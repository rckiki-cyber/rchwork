#!/usr/bin/env python3
"""
IMA 知识库 MCP Server — OpenAPI 搜索 + Cookie Q&A。

支持两种模式：
1. OpenAPI 模式（IMA_OPENAPI_CLIENTID + IMA_OPENAPI_APIKEY）：搜索/浏览知识库
2. Cookie 模式（IMA_X_IMA_COOKIE + IMA_X_IMA_BKN）：AI 问答，可读知识库全文
两种模式可同时使用。

凭证来源优先级（每次调用时重新读取）：
1. IMA_CREDS_FILE 指定的 JSON 文件（含 cookie/bkn 字段）— 用于静默自动刷新
2. 环境变量 IMA_X_IMA_COOKIE / IMA_X_IMA_BKN — 用于首次启动
3. 环境变量 IMA_OPENAPI_CLIENTID / IMA_OPENAPI_APIKEY — OpenAPI 模式
"""

import json
import os
import re
import sys
import base64
import secrets
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://ima.qq.com/openapi/wiki/v1"
QA_URL = "https://ima.qq.com/cgi-bin/assistant/qa"
REFRESH_PATH = "/cgi-bin/auth_login/refresh"
INIT_SESSION_PATH = "/cgi-bin/session_logic/init_session"
KNOWLEDGE_BASE_LIST_PATH = "/cgi-bin/knowledge_tab_reader/get_home_page_data"
RUNTIME_CLIENT_ID = str(uuid.uuid4())

# ── 凭证读取（文件优先于环境变量）──

def _read_creds_file():
    """从 IMA_CREDS_FILE 读取凭证，每次重新读（不缓存）"""
    path = os.environ.get("IMA_CREDS_FILE", "")
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}

def _get_cookie_creds():
    """返回 (cookie, bkn)，文件优先"""
    file_creds = _read_creds_file()
    cookie = file_creds.get("cookie", "") or os.environ.get("IMA_X_IMA_COOKIE", "")
    bkn = file_creds.get("bkn", "") or os.environ.get("IMA_X_IMA_BKN", "")
    return cookie, bkn

def _get_openapi_creds():
    """返回 (cid, key)，文件优先"""
    file_creds = _read_creds_file()
    cid = file_creds.get("client_id", "") or os.environ.get("IMA_OPENAPI_CLIENTID", "")
    key = file_creds.get("api_key", "") or os.environ.get("IMA_OPENAPI_APIKEY", "")
    return cid, key

def _get_captured_knowledge_bases():
    """返回登录窗口从 /wikis 页面被动发现的知识库快照。"""
    creds = _read_creds_file()
    raw = creds.get("knowledge_bases", [])
    result = []
    seen = set()
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            kb_id = str(item.get("id", "")).strip()
            if not kb_id or kb_id in seen:
                continue
            seen.add(kb_id)
            result.append({"id": kb_id, "name": str(item.get("name", "")).strip()})
    return result

def _merge_knowledge_bases(*groups):
    merged = {}
    order = []
    scalar_keys = ("name", "description", "document_count")
    list_keys = ("recommended_questions", "documents")
    for group in groups:
        for item in group or []:
            if not isinstance(item, dict):
                continue
            kb_id = str(item.get("id", "")).strip()
            if not kb_id:
                continue
            if kb_id not in merged:
                merged[kb_id] = {"id": kb_id, "name": ""}
                order.append(kb_id)
            target = merged[kb_id]
            for key in scalar_keys:
                value = item.get(key)
                if value not in (None, "") and target.get(key) in (None, ""):
                    target[key] = value
            for key in list_keys:
                values = item.get(key)
                if not isinstance(values, list):
                    continue
                existing = target.setdefault(key, [])
                for value in values:
                    if value not in existing:
                        existing.append(value)
    return [merged[kb_id] for kb_id in order]

def _resolve_knowledge_base_id(explicit_id=""):
    explicit_id = str(explicit_id or "").strip()
    if explicit_id:
        return explicit_id, None
    creds = _read_creds_file()
    default_id = str(creds.get("default_knowledge_base_id", "")).strip()
    if default_id:
        return default_id, None
    knowledge_bases = _get_captured_knowledge_bases()
    if not knowledge_bases:
        remote_bases, _ = _fetch_cookie_knowledge_bases()
        knowledge_bases = remote_bases
    if len(knowledge_bases) == 1:
        return knowledge_bases[0]["id"], None
    if knowledge_bases:
        choices = ", ".join(
            f'{item["name"] or "未命名知识库"} ({item["id"]})'
            for item in knowledge_bases
        )
        return "", f"IMA_KB_REQUIRED: 请传入 knowledge_base_id。可用知识库：{choices}"
    return "", (
        "IMA_KB_REQUIRED: IMA 当前账号未返回可用知识库。请确认账号已有个人或共享知识库，"
        "或重新登录后再试。"
    )

def api_call(path: str, payload: dict) -> dict:
    cid, key = _get_openapi_creds()
    if not cid:
        return {"error": "需要 IMA OpenAPI 凭证（ClientID+APIKey）才能使用此工具"}
    url = f"{BASE_URL}/{path}"
    headers = {
        "ima-openapi-clientid": cid,
        "ima-openapi-apikey": key,
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if result.get("code") != 0:
                return {"error": result.get("msg", "unknown error")}
            return result.get("data", {})
    except Exception as e:
        return {"error": str(e)}

# ── Q&A (Cookie 模式) ──

def _parse_x_ima_cookie(cookie):
    parsed = {}
    for part in cookie.split(";"):
        if "=" not in part:
            continue
        key, value = part.strip().split("=", 1)
        parsed[key.upper()] = value
    return parsed

def _replace_cookie_value(cookie, key, value):
    pattern = re.compile(rf"(^|;\s*){re.escape(key)}=[^;]*", re.IGNORECASE)
    if pattern.search(cookie):
        return pattern.sub(lambda m: f"{m.group(1)}{key}={value}", cookie)
    return cookie.rstrip("; ") + f"; {key}={value}"

def _request_headers(cookie, bkn, token="", json_response=False):
    headers = {
        "Accept": "application/json" if json_response else "*/*",
        "Content-Type": "application/json" if json_response else "text/event-stream",
        "Referer": "https://ima.qq.com/wikis",
        "Cookie": cookie,
        "x-ima-cookie": cookie,
        "x-ima-bkn": bkn,
        "extension_version": "999.999.999",
        "from_browser_ima": "1",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) legalwork/0.3.7",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers

def _post_json(path, payload, headers, timeout):
    import http.client
    conn = http.client.HTTPSConnection("ima.qq.com", timeout=timeout)
    try:
        conn.request("POST", path, body=json.dumps(payload), headers=headers)
        response = conn.getresponse()
        body = response.read()
        return response.status, response.getheader("content-type", ""), body
    finally:
        conn.close()

def _refresh_access_token(cookie, bkn, timeout):
    parts = _parse_x_ima_cookie(cookie)
    user_id = parts.get("IMA-UID", "")
    refresh_token = parts.get("IMA-REFRESH-TOKEN", "") or parts.get("IMA-TOKEN", "")
    if not user_id or not refresh_token:
        return None, cookie, "IMA_AUTH_EXPIRED: 登录凭据不完整，请重新登录 IMA"
    status, _, raw = _post_json(
        REFRESH_PATH,
        {
            "user_id": user_id,
            "refresh_token": urllib.parse.unquote(refresh_token),
            "token_type": 14,
        },
        _request_headers(cookie, bkn, json_response=True),
        min(timeout, 20),
    )
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        payload = {}
    if status in (401, 403) or payload.get("code") not in (0, None):
        return None, cookie, (
            "IMA_AUTH_EXPIRED: "
            + str(payload.get("msg") or f"Token 刷新失败（HTTP {status}）")
        )
    token = payload.get("token")
    if status != 200 or not isinstance(token, str) or not token:
        return None, cookie, f"IMA_PROTOCOL_ERROR: Token 刷新响应不完整（HTTP {status}）"
    return token, _replace_cookie_value(cookie, "IMA-TOKEN", token), None

def _extract_remote_knowledge_bases(payload):
    """解析 get_home_page_data 已知的个人库、加入库和兼容旧版列表结构。"""
    if not isinstance(payload, dict):
        return []
    root = payload.get("result")
    if not isinstance(root, dict):
        root = payload.get("data")
    if not isinstance(root, dict):
        root = payload

    knowledge_bases = []

    def compact_text(value, limit=240):
        text = re.sub(r"\s+", " ", str(value or "")).strip()
        return text[:limit]

    def add(item, documents=None):
        if not isinstance(item, dict):
            return
        basic = item.get("basic_info")
        if not isinstance(basic, dict):
            basic = {}
        kb_id = (
            item.get("id")
            or item.get("knowledge_base_id")
            or item.get("knowledge_matrix_id")
            or basic.get("knowledge_base_id")
            or basic.get("knowledge_matrix_id")
        )
        if not kb_id:
            return
        name = (
            basic.get("name")
            or basic.get("nickname")
            or item.get("name")
            or item.get("nickname")
            or item.get("title")
            or ""
        )
        recommended = basic.get("recommended_questions", [])
        if not isinstance(recommended, list):
            recommended = []
        safe_documents = []
        for document in documents or []:
            if not isinstance(document, dict):
                continue
            title = compact_text(document.get("title"), 160)
            if not title:
                continue
            summary = compact_text(
                document.get("abstract") or document.get("introduction"),
                240,
            )
            tags = document.get("tags")
            safe_documents.append({
                "title": title,
                **({"summary": summary} if summary else {}),
                **({
                    "tags": [compact_text(tag, 40) for tag in tags[:8] if compact_text(tag, 40)]
                } if isinstance(tags, list) and tags else {}),
            })
            if len(safe_documents) >= 20:
                break
        try:
            document_count = int(basic.get("size") or len(documents or []))
        except (TypeError, ValueError):
            document_count = len(documents or [])
        knowledge_bases.append({
            "id": str(kb_id),
            "name": compact_text(name, 120),
            "description": compact_text(basic.get("description"), 320),
            "recommended_questions": [
                compact_text(question, 160)
                for question in recommended[:12]
                if compact_text(question, 160)
            ],
            "documents": safe_documents,
            "document_count": document_count,
        })

    list_rsp = root.get("knowledge_list_rsp")
    if isinstance(list_rsp, dict):
        add(
            list_rsp.get("knowledge_base_info"),
            list_rsp.get("knowledge_list") if isinstance(list_rsp.get("knowledge_list"), list) else [],
        )
    add(root.get("knowledge_base_info"))
    for result in root.get("results", []):
        if not isinstance(result, dict):
            continue
        for item in result.get("knowledge_base_list", []):
            add(item)
    for item in root.get("knowledge_list", []):
        add(item)
    for item in root.get("knowledge_base_list", []):
        add(item)
    return _merge_knowledge_bases(knowledge_bases)

def _catalog_tokens(value):
    text = str(value or "").lower()
    tokens = set(re.findall(r"[a-z0-9][a-z0-9_-]+", text))
    for segment in re.findall(r"[\u3400-\u9fff]+", text):
        chars = list(segment[:120])
        for size in (2, 3, 4):
            for index in range(max(0, len(chars) - size + 1)):
                tokens.add("".join(chars[index:index + size]))
    return tokens

def _expanded_catalog_query(query):
    text = str(query or "")
    expansions = []
    intent_expansions = (
        (r"公司|企业|劳动|用工|员工|合同|合规|风控|治理", "企业 法务 合规 公司 劳动 合同"),
        (r"行政|政府|许可|处罚|复议|征收|执法", "行政法 行政 复议 处罚 执法"),
        (r"人工智能|算法|数据|平台|网络|科技|数字", "数字法学 人工智能 数据 算法 科技"),
        (r"立法|司法|判例|案例|裁判|法院|检察", "立法 司法 案例 裁判"),
        (r"法律|法规|法条|司法解释|规范性文件|效力|依据", "国家法律 法律 法规 法条 司法解释"),
    )
    for pattern, expansion in intent_expansions:
        if re.search(pattern, text):
            expansions.append(expansion)
    return f"{text} {' '.join(expansions)}"

def _rank_knowledge_bases(query, knowledge_bases):
    query_tokens = _catalog_tokens(_expanded_catalog_query(query))
    ranked = []
    for index, item in enumerate(knowledge_bases):
        name_tokens = _catalog_tokens(item.get("name"))
        description_tokens = _catalog_tokens(item.get("description"))
        question_tokens = _catalog_tokens(" ".join(item.get("recommended_questions", [])))
        document_text = " ".join(
            " ".join((
                str(document.get("title", "")),
                str(document.get("summary", "")),
                " ".join(document.get("tags", [])) if isinstance(document.get("tags"), list) else "",
            ))
            for document in item.get("documents", [])
            if isinstance(document, dict)
        )
        document_tokens = _catalog_tokens(document_text)

        def overlap(tokens):
            return len(query_tokens & tokens) / max(1, len(query_tokens) ** 0.5)

        score = (
            overlap(name_tokens) * 5.0
            + overlap(description_tokens) * 2.5
            + overlap(question_tokens) * 2.0
            + overlap(document_tokens) * 1.25
        )
        matched = sorted(
            query_tokens & (name_tokens | description_tokens | question_tokens | document_tokens),
            key=lambda term: (-len(term), term),
        )
        ranked.append({
            **item,
            "routing_score": round(score, 4),
            "matched_terms": matched[:12],
            "_order": index,
        })
    ranked.sort(key=lambda item: (-item["routing_score"], item["_order"]))
    for item in ranked:
        item.pop("_order", None)
    return ranked

def _fetch_cookie_knowledge_bases(timeout=30):
    """Cookie-only：刷新 token 后直接读取 IMA 知识库首页数据。"""
    cookie, bkn = _get_cookie_creds()
    if not cookie or not bkn:
        return [], "需要 IMA 登录凭证，请在插件中重新登录"
    try:
        timeout = max(10, min(int(timeout), 60))
    except (TypeError, ValueError):
        timeout = 30
    try:
        token, refreshed_cookie, auth_error = _refresh_access_token(cookie, bkn, timeout)
        if auth_error:
            return [], auth_error
        user_id = _parse_x_ima_cookie(refreshed_cookie).get("IMA-UID", "")
        if not user_id:
            return [], "IMA_AUTH_EXPIRED: 登录凭据缺少 IMA-UID，请重新登录"
        status, _, raw = _post_json(
            KNOWLEDGE_BASE_LIST_PATH,
            {
                "knowledge_base_id": user_id,
                "need_folder_number": True,
                "need_default_cover": False,
            },
            _request_headers(
                refreshed_cookie, bkn, token=token, json_response=True
            ),
            timeout,
        )
        try:
            payload = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return [], (
                "IMA_PROTOCOL_ERROR: 知识库列表响应不是 JSON"
                f"（HTTP {status}）"
            )
        code = payload.get("code", payload.get("Code"))
        if status in (401, 403) or code in (600001, 600002, 600003, 41, 110031):
            return [], "IMA_AUTH_EXPIRED: IMA 登录态已过期，请重新登录"
        if status != 200 or code not in (0, None):
            detail = payload.get("msg") or payload.get("message") or "未知错误"
            return [], f"IMA_LIST_ERROR: 无法读取知识库列表（HTTP {status}）：{detail}"
        return _extract_remote_knowledge_bases(payload), None
    except Exception as error:
        return [], f"IMA_LIST_ERROR: 读取知识库列表失败：{error}"

def _init_qa_session(cookie, bkn, token, kb_id, timeout):
    payload = {
        "envInfo": {"robotType": 5, "interactType": 0},
        "relatedUrl": kb_id,
        "sceneType": 1,
        "msgsLimit": 10,
        "forbidAutoAddToHistoryList": False,
        "knowledgeBaseInfoWithFolder": {
            "knowledgeBaseId": kb_id,
            "folderIds": [],
        },
    }
    status, _, raw = _post_json(
        INIT_SESSION_PATH,
        payload,
        _request_headers(cookie, bkn, token=token, json_response=True),
        min(timeout, 30),
    )
    try:
        response = json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        response = {}
    if status in (401, 403) or response.get("code") in (600001, 600002, 600003, 41, 110031):
        return "", "IMA_AUTH_EXPIRED: IMA 登录态已过期，请重新登录"
    session_id = response.get("session_id")
    if status != 200 or response.get("code") != 0 or not session_id:
        detail = response.get("msg") or raw.decode("utf-8", errors="replace")[:200]
        return "", f"IMA_SESSION_ERROR: 无法初始化知识库 {kb_id}（HTTP {status}）：{detail}"
    return str(session_id), None

def _extract_text(value, depth=0):
    if depth > 8:
        return ""
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return ""
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            return value
        return _extract_text(decoded, depth + 1)
    if isinstance(value, list):
        parts = [_extract_text(item, depth + 1) for item in value]
        return "".join(part for part in parts if part)
    if isinstance(value, dict):
        # IMA 当前和社区实现中均出现过这些顶层/嵌套回答字段。
        for key in (
            "Text",
            "text",
            "Answer",
            "answer",
            "Content",
            "content",
            "output_text",
            "Delta",
            "delta",
        ):
            text = _extract_text(value.get(key), depth + 1)
            if text:
                return text
        for key in (
            "Data",
            "data",
            "Result",
            "result",
            "Payload",
            "payload",
            "Output",
            "output",
            "Response",
            "response",
        ):
            text = _extract_text(value.get(key), depth + 1)
            if text:
                return text
        text = _extract_text(
            value.get("Message", value.get("message")),
            depth + 1,
        )
        if text and text.strip().lower() not in ("ok", "success", "成功"):
            return text
    return ""

def _event_shape(value, depth=0):
    """生成不含正文的事件结构摘要，用于协议错误诊断。"""
    if depth > 2:
        return type(value).__name__
    if isinstance(value, dict):
        parts = []
        for key in sorted(value.keys())[:12]:
            nested = value[key]
            if isinstance(nested, (dict, list)):
                parts.append(f"{key}:{_event_shape(nested, depth + 1)}")
            else:
                parts.append(f"{key}:{type(nested).__name__}")
        return "{" + ",".join(parts) + "}"
    if isinstance(value, list):
        return (
            f"[{_event_shape(value[0], depth + 1)}]"
            if value
            else "[]"
        )
    return type(value).__name__

def _collect_refs(value, refs, depth=0):
    if depth > 8:
        return
    if isinstance(value, list):
        for item in value:
            _collect_refs(item, refs, depth + 1)
        return
    if not isinstance(value, dict):
        return
    medias = value.get("medias")
    if isinstance(medias, list):
        for media in medias:
            if not isinstance(media, dict):
                continue
            title = media.get("title") or media.get("mediaName") or media.get("name")
            if title:
                refs.append(str(title))
    for key in (
        "context_refs",
        "Data",
        "data",
        "Result",
        "result",
        "Payload",
        "payload",
        "Content",
        "content",
    ):
        nested = value.get(key)
        if isinstance(nested, (dict, list)):
            _collect_refs(nested, refs, depth + 1)

def _collect_qa_event(event, answers, refs, diagnostics):
    if not isinstance(event, dict):
        return
    diagnostics.setdefault("shapes", set()).add(_event_shape(event))
    code = event.get("code", event.get("Code"))
    if code is not None:
        diagnostics["codes"].add(str(code))
    msgs = event.get("msgs")
    if isinstance(msgs, list):
        for msg in msgs:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            text = _extract_text(content) or _extract_text(msg)
            if text:
                answers.append(text)
            _collect_refs(content, refs)

    # 旧实现只检查了 event["content"]，因而漏掉 IMA 最常见的顶层 Text。
    direct = _extract_text(event)
    if direct:
        answers.append(direct)
    _collect_refs(event, refs)

ACADEMIC_QUESTION_PATTERN = re.compile(
    r"论文|文献|学术|研究综述|文献综述|参考文献|期刊|专著|硕士论文|博士论文|学位论文"
)
ACADEMIC_REFERENCE_INSTRUCTION = (
    "\n\n【参考文献输出要求】本问题涉及论文或学术文献。请在回答末尾单列“参考文献”，"
    "仅列出本次确实检索或引用到的文献；每条至少写明文献完整名称及作者。"
    "若知识库未提供作者信息，请明确标注“作者信息未提供”，不得猜测或补造作者。"
)

def _prepare_ima_question(question):
    """论文类问题统一要求 IMA 返回可核验的题名与作者。"""
    text = str(question or "").strip()
    if not text or not ACADEMIC_QUESTION_PATTERN.search(text):
        return text
    if "作者信息未提供" in text and "参考文献输出要求" in text:
        return text
    return text + ACADEMIC_REFERENCE_INSTRUCTION

def qa_ask(question: str, kb_id: str = "", timeout: int = 60) -> str:
    """按 IMA 当前协议执行 refresh → init_session → QA。"""
    cookie, bkn = _get_cookie_creds()
    if not cookie or not bkn:
        return "需要 IMA 登录凭证，请在插件中重新登录"

    import http.client
    try:
        timeout = max(10, min(int(timeout), 300))
    except (TypeError, ValueError):
        timeout = 60
    resolved_kb_id, kb_error = _resolve_knowledge_base_id(kb_id)
    if kb_error:
        return kb_error

    try:
        token, cookie, auth_error = _refresh_access_token(cookie, bkn, timeout)
        if auth_error:
            return auth_error
        session_id, session_error = _init_qa_session(
            cookie, bkn, token, resolved_kb_id, timeout
        )
        if session_error:
            return session_error

        guid = _parse_x_ima_cookie(cookie).get("IMA-GUID", "default_guid")
        prepared_question = _prepare_ima_question(question)
        body = json.dumps({
            "session_id": session_id,
            "robot_type": 5,
            "question": prepared_question,
            "question_type": 2,
            "client_id": RUNTIME_CLIENT_ID,
            "command_info": {
                "type": 14,
                "knowledge_qa_info": {
                    "tags": [],
                    "knowledge_ids": [resolved_kb_id],
                    "media_id_infos": [],
                },
            },
            "model_info": {"model_type": 4, "enable_enhancement": False},
            "history_info": {},
            "device_info": {
                "uskey": base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
                "uskey_bus_infos_input": f"{guid}_{int(time.time())}",
            },
            "client_tools": [],
        })
        conn = http.client.HTTPSConnection("ima.qq.com", timeout=timeout)
        headers = _request_headers(cookie, bkn, token=token)
        conn.request("POST", "/cgi-bin/assistant/qa", body=body, headers=headers)
        resp = conn.getresponse()
        if resp.status in (401, 403):
            return "IMA_AUTH_EXPIRED: Cookie 已过期，请在 legalwork 插件中重新登录 IMA 知识库，系统将自动刷新凭证"
        if resp.status != 200:
            return f"Q&A 接口返回 {resp.status}: {resp.read().decode('utf-8', errors='replace')[:200]}"

        answers = []
        refs = []
        diagnostics = {
            "events": 0,
            "parse_errors": 0,
            "codes": set(),
            "shapes": set(),
        }
        while True:
            line = resp.readline()
            if not line:
                break
            raw = line.decode("utf-8", errors="replace").strip()
            if not raw or raw.startswith(":"):
                continue
            if raw.startswith("data:") or raw.startswith("{"):
                payload_text = raw[5:].strip() if raw.startswith("data:") else raw
                if payload_text == "[DONE]":
                    continue
                try:
                    data = json.loads(payload_text)
                    diagnostics["events"] += 1
                    _collect_qa_event(data, answers, refs, diagnostics)
                except json.JSONDecodeError:
                    if raw.startswith("data:") and payload_text:
                        diagnostics["events"] += 1
                        answers.append(payload_text)
                    else:
                        diagnostics["parse_errors"] += 1

        # 累计事件选最长文本；分片事件则按到达顺序拼接。
        unique_answers = list(dict.fromkeys(text.strip() for text in answers if text.strip()))
        if unique_answers:
            longest = max(unique_answers, key=len)
            result = longest if all(part in longest for part in unique_answers) else "".join(unique_answers)
        else:
            result = ""
        refs = list(dict.fromkeys(refs))
        if result and refs:
            result += "\n\n📚 参考资料：\n" + "\n".join(f"- {r}" for r in refs[:10])
        if result:
            return result
        if refs:
            return (
                "IMA_NO_ANSWER: IMA 返回了参考资料但没有回答文本，可能未命中可回答内容。\n\n"
                "📚 参考资料：\n" + "\n".join(f"- {r}" for r in refs[:10])
            )
        codes = ",".join(sorted(diagnostics["codes"])) or "无"
        shapes = " | ".join(sorted(diagnostics["shapes"])[:5]) or "无"
        if "3" in diagnostics["codes"]:
            return (
                "IMA_NO_MATCH: IMA 返回 Code=3 且没有文本。该知识库可能未命中内容，"
                "也可能是服务端瞬时限流；请确认 knowledge_base_id 后稍后重试。"
            )
        return (
            "IMA_PROTOCOL_ERROR: HTTP 200 但未解析到回答。"
            f"诊断：knowledge_base_id={resolved_kb_id}, SSE事件={diagnostics['events']}, "
            f"JSON解析失败={diagnostics['parse_errors']}, 返回码={codes}, "
            f"事件结构={shapes}"
        )

    except Exception as e:
        return f"Q&A 请求失败: {str(e)}"
    finally:
        if "conn" in locals():
            conn.close()

# ── 工具处理器 ──

def handle_search_knowledge_base(args: dict) -> dict:
    result = api_call("search_knowledge_base", {
        "query": args.get("query", ""), "cursor": args.get("cursor", ""), "limit": args.get("limit", 20),
    })
    if "error" in result:
        return result
    items = result.get("info_list", [])
    return {
        "knowledge_bases": [{
            "id": kb.get("kb_id", ""), "name": kb.get("kb_name", ""),
            "content_count": kb.get("content_count", 0),
            "description": kb.get("description", ""), "creator": kb.get("creator", ""),
        } for kb in items],
        "is_end": result.get("is_end", True), "next_cursor": result.get("next_cursor", ""),
    }

def _list_all_kb_ids(limit: int = 50) -> list:
    """列出所有知识库 ID，用于多库搜索"""
    result = api_call("search_knowledge_base", {"query": "", "cursor": "", "limit": limit})
    if "error" in result:
        return []
    return [kb.get("kb_id", "") for kb in result.get("info_list", []) if kb.get("kb_id")]

def handle_search_knowledge(args: dict) -> dict:
    query = args.get("query", "")
    if not query:
        return {"error": "需要 query"}
    kb_id = args.get("knowledge_base_id", "")

    # 指定了知识库 → 单库搜索
    if kb_id:
        result = api_call("search_knowledge", {
            "query": query, "cursor": args.get("cursor", ""), "knowledge_base_id": kb_id,
        })
        if "error" in result:
            return result
        return {"results": [{
            "media_id": i.get("media_id", ""), "title": i.get("title", ""),
            "highlight_content": i.get("highlight_content", ""),
            "kb_id": kb_id,
        } for i in result.get("info_list", [])],
            "is_end": result.get("is_end", True), "next_cursor": result.get("next_cursor", ""),
        }

    # 未指定知识库 → 全库搜索（遍历所有知识库，合并结果）
    kb_ids = _list_all_kb_ids(50)
    if not kb_ids:
        return {"error": "没有可搜索的知识库", "results": []}

    all_results = []
    per_kb_limit = args.get("limit", 10)
    for kid in kb_ids:
        r = api_call("search_knowledge", {
            "query": query, "cursor": "", "knowledge_base_id": kid, "limit": per_kb_limit,
        })
        if "error" in r:
            continue
        for i in r.get("info_list", []):
            all_results.append({
                "media_id": i.get("media_id", ""), "title": i.get("title", ""),
                "highlight_content": i.get("highlight_content", ""),
                "kb_id": kid,
            })

    # 按包含查询词的次数简单排序（结果多的排在前面）
    all_results.sort(key=lambda x: x["highlight_content"].count(query) if x["highlight_content"] else 0, reverse=True)
    return {"results": all_results[:20], "total_kbs": len(kb_ids), "matched_kbs": len(set(r["kb_id"] for r in all_results))}

def handle_get_knowledge_base(args: dict) -> dict:
    ids = args.get("ids", [])
    if not ids:
        return {"error": "需要 ids"}
    result = api_call("get_knowledge_base", {"ids": ids})
    if "error" in result:
        return result
    return {"knowledge_bases": [{
        "id": kid, "name": info.get("kb_name", ""),
        "description": info.get("description", ""), "content_count": info.get("content_count", 0),
        "creator": info.get("creator", ""),
    } for kid, info in result.get("infos", {}).items()]}

def handle_get_knowledge_list(args: dict) -> dict:
    kb_id = args.get("knowledge_base_id", "")
    if not kb_id:
        return {"error": "需要 knowledge_base_id"}
    result = api_call("get_knowledge_list", {
        "cursor": args.get("cursor", ""), "limit": args.get("limit", 50),
        "knowledge_base_id": kb_id, "folder_id": args.get("folder_id", ""),
    })
    if "error" in result:
        return result
    folders, files = [], []
    for item in result.get("knowledge_list", []):
        if item.get("folder_id"):
            folders.append({"folder_id": item["folder_id"], "name": item.get("title", ""),
                            "file_number": item.get("file_number", 0),
                            "folder_number": item.get("folder_number", 0)})
        else:
            files.append({"media_id": item.get("media_id", ""), "title": item.get("title", ""),
                          "parent_folder_id": item.get("parent_folder_id", "")})
    return {"folders": folders, "files": files, "is_end": result.get("is_end", True),
            "next_cursor": result.get("next_cursor", "")}

def handle_list_available_knowledge_bases(args: dict) -> dict:
    """Cookie-only：动态读取 IMA 知识库，失败时使用登录窗口快照。"""
    remote_bases, remote_error = _fetch_cookie_knowledge_bases(
        args.get("timeout", 30)
    )
    captured_bases = _get_captured_knowledge_bases()
    knowledge_bases = _merge_knowledge_bases(remote_bases, captured_bases)
    creds = _read_creds_file()
    return {
        "knowledge_bases": knowledge_bases,
        "default_knowledge_base_id": creds.get("default_knowledge_base_id", ""),
        "count": len(knowledge_bases),
        "source": (
            "IMA Cookie API"
            if remote_bases
            else "IMA /wikis 登录页网络响应快照"
        ),
        "captured_at": creds.get("last_verified_at", ""),
        "warning": remote_error or "",
        "message": (
            "未发现知识库；请确认当前账号已有个人或共享知识库，或重新登录。"
            if not knowledge_bases else ""
        ),
    }

def handle_search_ima_catalog(args: dict) -> dict:
    """目录级 RAG：按名称、简介、推荐问题和文档结构检索最相关知识库。"""
    query = str(args.get("query", "")).strip()
    if not query:
        return {"error": "需要 query"}
    try:
        top_k = max(1, min(int(args.get("top_k", 5)), 10))
    except (TypeError, ValueError):
        top_k = 5
    remote_bases, remote_error = _fetch_cookie_knowledge_bases(
        args.get("timeout", 30)
    )
    knowledge_bases = _merge_knowledge_bases(
        remote_bases,
        _get_captured_knowledge_bases(),
    )
    ranked = _rank_knowledge_bases(query, knowledge_bases)
    return {
        "query": query,
        "knowledge_bases": ranked[:top_k],
        "count": len(knowledge_bases),
        "warning": remote_error or "",
        "routing": (
            "目录级 RAG 仅选择知识库；最终答案仍由选中的 IMA 知识库全文检索生成。"
        ),
    }

def handle_research_ima(args: dict) -> dict:
    """统一入口：目录级 RAG 自动选库，然后执行 IMA 全文问答。"""
    question = str(args.get("question", "")).strip()
    if not question:
        return {"error": "需要 question"}
    explicit_id = str(args.get("knowledge_base_id", "")).strip()
    selected = None
    if explicit_id:
        remote_bases, _ = _fetch_cookie_knowledge_bases(args.get("timeout", 30))
        catalog = _merge_knowledge_bases(
            remote_bases,
            _get_captured_knowledge_bases(),
        )
        selected = next(
            (item for item in catalog if item.get("id") == explicit_id),
            {"id": explicit_id, "name": "指定知识库", "routing_score": 1.0},
        )
    else:
        catalog_result = handle_search_ima_catalog({
            "query": question,
            "top_k": 1,
            "timeout": args.get("timeout", 30),
        })
        if "error" in catalog_result:
            return catalog_result
        candidates = catalog_result.get("knowledge_bases", [])
        if not candidates:
            return {"error": "IMA 当前账号没有可用于问答的知识库"}
        selected = candidates[0]

    answer = qa_ask(
        question,
        str(selected.get("id", "")),
        args.get("timeout", 90),
    )
    name = str(selected.get("name") or "未命名知识库")
    return {
        "answer": f"【IMA 自动选库：{name}】\n\n{answer}",
        "selected_knowledge_base": {
            "id": selected.get("id", ""),
            "name": name,
            "routing_score": selected.get("routing_score"),
            "matched_terms": selected.get("matched_terms", []),
        },
    }

def handle_ask(args: dict) -> dict:
    """向 IMA AI 提问，AI 会搜索知识库并回答"""
    question = args.get("question", "")
    if not question:
        return {"error": "需要 question"}
    answer = qa_ask(question, args.get("knowledge_base_id", ""), args.get("timeout", 60))
    return {"answer": answer}

def handle_refresh_auth(args: dict) -> dict:
    """向 Electron 主进程发送 IMA Cookie 刷新信号"""
    trigger_path = os.environ.get("IMA_REFRESH_TRIGGER_PATH", "")
    if not trigger_path:
        return {"result": "IMA_REFRESH_TRIGGER_PATH 未设置，刷新信号无法发送"}
    try:
        import time as _time
        with open(trigger_path, "w") as f:
            json.dump({"requested_at": _time.time()}, f)
        return {"result": "已发送刷新信号，请重试 ask。若仍然返回 IMA_AUTH_EXPIRED 则说明 Cookie 已永久失效，可调用 open_ima_login 弹出登录窗口"}
    except Exception as e:
        return {"error": f"发送刷新信号失败: {e}"}

def handle_open_login(args: dict) -> dict:
    """向 Electron 主进程发送弹窗登录信号"""
    trigger_path = os.environ.get("IMA_REFRESH_TRIGGER_PATH", "")
    if not trigger_path:
        return {"error": "IMA_REFRESH_TRIGGER_PATH 未设置"}
    try:
        import time as _time
        with open(trigger_path, "w") as f:
            json.dump({"action": "login", "requested_at": _time.time()}, f)
        return {"result": "IMA 登录窗口已弹出，请在弹出的窗口中扫码登录，登录后窗口将自动关闭，届时可重试 ask"}
    except Exception as e:
        return {"error": f"弹窗失败: {e}"}

# ── 启动时检测 OpenAPI 凭证 ──

_cid, _key = _get_openapi_creds()
_has_openapi = bool(_cid and _key)

# ── MCP Server ──

_COOKIE_ONLY_TOOLS = {
    "research_ima": {
        "description": "IMA 自动研究入口。对法律、合规、案例、法学论文、行业实践、合同或监管问题，应主动调用，无需等待用户强调“查 IMA”。工具先对知识库名称、简介、推荐问题和文档结构做目录级 RAG，自动选择最相关知识库，再调用 IMA 全文问答。论文/文献类问题会自动要求 IMA 在回答末尾列出实际参考文献的完整名称及作者。只需传入用户的完整问题",
        "input_schema": {"type": "object", "properties": {
            "question": {"type": "string", "description": "用户的完整研究问题，保留法律领域、主体和时间范围等限定"},
            "knowledge_base_id": {"type": "string", "description": "可选；用户明确指定知识库时传入，否则自动选库"},
            "timeout": {"type": "number", "description": "超时秒数"},
        }, "required": ["question"]},
        "handler": handle_research_ima,
    },
    "search_ima_catalog": {
        "description": "对 IMA 知识库目录做 RAG 检索，依据库名、简介、推荐问题、文档标题/摘要/标签返回最相关的知识库。用于解释选库结果或在调用 research_ima 前查看候选库，不检索全文",
        "input_schema": {"type": "object", "properties": {
            "query": {"type": "string", "description": "要匹配知识库的自然语言任务或问题"},
            "top_k": {"type": "number", "description": "返回候选库数量，默认 5，最多 10"},
            "timeout": {"type": "number", "description": "超时秒数"},
        }, "required": ["query"]},
        "handler": handle_search_ima_catalog,
    },
    "list_available_knowledge_bases": {
        "description": "使用 Cookie 接口动态列出当前 IMA 账号可用的个人库和共享库，无需 OpenAPI；接口失败时回退到登录时 /wikis 捕获的快照。先用它取得 knowledge_base_id，再调用 ask",
        "input_schema": {"type": "object", "properties": {
            "timeout": {"type": "number", "description": "超时秒数"},
        }, "required": []},
        "handler": handle_list_available_knowledge_bases,
    },
    "ask": {
        "description": "向指定 IMA 知识库提问。未传 knowledge_base_id 时使用默认库、唯一已发现库或动态读取 Cookie 知识库列表；若有多个库则明确返回可选 ID，绝不会发送空知识库查询。论文/文献类问题自动要求返回实际参考文献的完整名称及作者",
        "input_schema": {"type": "object", "properties": {
            "question": {"type": "string", "description": "你的问题"},
            "knowledge_base_id": {"type": "string", "description": "知识库 ID。建议先调用 list_available_knowledge_bases 获取"},
            "timeout": {"type": "number", "description": "超时秒数"},
        }, "required": ["question"]}, "handler": handle_ask,
    },
    "refresh_ima_auth": {
        "description": "当 ask 返回 IMA_AUTH_EXPIRED 时调用此工具。它通知桌面端使用 IMA token refresh 接口验证并刷新凭据；随后重试 ask，若仍过期再调用 open_ima_login",
        "input_schema": {"type": "object", "properties": {}, "required": []},
        "handler": handle_refresh_auth,
    },
    "open_ima_login": {
        "description": "弹出 IMA 登录窗口让用户扫码登录。当 ask 返回 IMA_AUTH_EXPIRED 且 refresh_ima_auth 后仍然过期时使用。调用后登录窗口会自动弹出，用户扫码即可，无需手动复制 Cookie",
        "input_schema": {"type": "object", "properties": {}, "required": []},
        "handler": handle_open_login,
    },
}

_OPENAPI_TOOLS = {
    "search_knowledge_base": {
        "description": "搜索/列出 IMA 知识库。query 为空则返回所有知识库",
        "input_schema": {"type": "object", "properties": {
            "query": {"type": "string", "description": "搜索关键词"},
            "cursor": {"type": "string", "description": "翻页游标"},
            "limit": {"type": "number", "description": "每页数量（1-50）"},
        }}, "handler": handle_search_knowledge_base,
    },
    "get_knowledge_list": {
        "description": "浏览知识库的文件和文件夹列表",
        "input_schema": {"type": "object", "properties": {
            "knowledge_base_id": {"type": "string", "description": "知识库 ID"},
            "folder_id": {"type": "string", "description": "文件夹 ID"},
            "cursor": {"type": "string", "description": "翻页游标"},
            "limit": {"type": "number", "description": "每页数量"},
        }, "required": ["knowledge_base_id"]}, "handler": handle_get_knowledge_list,
    },
    "search_knowledge": {
        "description": "在指定知识库中搜索内容。不传 knowledge_base_id 时自动搜索所有知识库并合并结果（显示每个结果的来源 kb_id）",
        "input_schema": {"type": "object", "properties": {
            "knowledge_base_id": {"type": "string", "description": "知识库 ID（可选，不传则搜所有知识库）"},
            "query": {"type": "string", "description": "搜索关键词"},
            "cursor": {"type": "string", "description": "翻页游标"},
            "limit": {"type": "number", "description": "每库返回数量"},
        }, "required": ["query"]}, "handler": handle_search_knowledge,
    },
    "get_knowledge_base": {
        "description": "获取知识库详细信息",
        "input_schema": {"type": "object", "properties": {
            "ids": {"type": "array", "items": {"type": "string"}, "description": "知识库 ID 列表"},
        }, "required": ["ids"]}, "handler": handle_get_knowledge_base,
    },
}

TOOLS = {}
TOOLS.update(_COOKIE_ONLY_TOOLS)
if _has_openapi:
    TOOLS.update(_OPENAPI_TOOLS)

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        req_id = req.get("id", 1)
        method = req.get("method", "")
        params = req.get("params", {})

        if method == "initialize":
            respond(req_id, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}, "resources": {}},
                            "serverInfo": {"name": "ima-knowledge-base", "version": "1.0.0"}})
            continue
        if method == "notifications/initialized":
            continue
        if method == "tools/list":
            respond(req_id, {"tools": [{"name": n, "description": i["description"], "inputSchema": i["input_schema"]}
                                         for n, i in TOOLS.items()]})
            continue
        if method == "tools/call":
            tool_name = params.get("name", "")
            args = params.get("arguments", {})
            tool = TOOLS.get(tool_name)
            if not tool:
                respond_error(req_id, -32601, f"未知工具: {tool_name}")
                continue
            try:
                result = tool["handler"](args)
                text = json.dumps(result, ensure_ascii=False, indent=2) if not isinstance(result.get("answer"), str) else result["answer"]
                respond(req_id, {"content": [{"type": "text", "text": text}],
                                "isError": "error" in result})
            except Exception as e:
                respond_error(req_id, -32603, str(e))
            continue
        respond_error(req_id, -32601, f"未知方法: {method}")

def respond(req_id: int, result: dict):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}) + "\n")
    sys.stdout.flush()

def respond_error(req_id: int, code: int, message: str):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}) + "\n")
    sys.stdout.flush()

if __name__ == "__main__":
    main()
