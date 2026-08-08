---
name: legal-document-formatting
description: LegalWork 的 Office 文档格式执行技能。Word/DOCX 与常规 PPTX 默认由本技能自带的本地 Python worker 完成；支持从参考 DOCX 提取并复用页面、正文与标题样式；Office MCP 只有 worker 明确返回 unsupported 并生成 fallback ticket 后才能作为最后兜底。Word 默认正文中文宋体、英文 Times New Roman、小四 12pt。
---

# LegalWork 文档格式执行 Skill

本技能是 Office 文档的确定性执行层。内容起草、法律分析、检索由其他能力完成；文档写入、格式、页面和基础结构优先交给本技能 worker，不让模型逐条操作 OfficeCLI。

## 1. 格式来源优先级

按以下顺序决定 Word 格式，前者覆盖后者：

1. 用户在当前任务中明确指定的格式；
2. 用户提供的参考 DOCX、模板 DOCX、学校/法院/律所样板；
3. 对应内置 profile；
4. `legal-default`。

如果用户说“照这个 Word”“按这份格式”“参考这些文档排版”，优先走 **reference-driven formatting**，不要凭模型目测后手写一套近似格式。

## 2. 强制执行顺序

1. 默认不调用 `mcp_officecli_officecli`，也不主动查 OfficeCLI help。
2. 直接使用 Assets 中的 `scripts/skill_runner.py`。runner 自动维护 `~/.legalwork/runtimes/office-skills/python-venv`，安装并复用固定依赖；不要让模型自己 `pip install`。
3. 一次 worker 调用完成一个确定性任务，stdout 只保留一条紧凑 JSON；禁止把整篇 HTML/XML 渲染进 history。
4. 修改已有文档默认另存副本，不覆盖原件。
5. 只有 worker 返回 `status:"unsupported"` 且给出 `fallback_ticket`，才调用 `request_office_fallback(ticket=...)`。普通报错、环境错误、参数错误都不能解锁 Office MCP。

运行 runner 时优先使用环境中的 `LEGALWORK_SKILL_PYTHON` / `LEGALWORK_PYTHON` / `LEGALWORK_OCR_PYTHON` 作为启动解释器；若未提供，使用系统可用的 Python 3.10-3.13。runner 内部负责专用 venv 和依赖，不把安装日志返回模型。

## 3. Word 默认格式与内置 profile

用户没有另行指定、也没有参考文档或机构强制规范时，基础默认：

- A4 纵向；
- 正文中文宋体；
- 英文与阿拉伯数字 Times New Roman；
- 12 pt（小四）；
- 两端对齐；
- 首行缩进 2 字符；
- 1.5 倍行距；
- 段前、段后 0；
- 标题使用真实 Title / Heading 样式。

内置 profile：

- `legal-default`：法律意见、报告、备忘录等普通正式文档；
- `academic`：论文、开题、研究报告。当前基线采用标题黑体 18pt、一级标题黑体 15pt、正文宋体 12pt、上下 2.54cm、左右 3.17cm；
- `litigation`：诉状、答辩状、代理词等诉讼文书基础版式。

学术文档若已有学校模板或用户提供参考文档，以模板/参考文档为准；参考文献、页眉页脚、页码等也优先沿用样板，而不是强套统一默认。

## 4. 参考 DOCX 驱动格式

Assets 中的 `reference_profile_worker.py` 用于把“格式样板”变成可复用的确定性规则。它只提取格式，不把参考文档正文送回模型。

### 查看参考文档的格式摘要

```text
<python> <skill_runner.py> reference inspect --input REFERENCE.docx
```

返回紧凑 JSON，包括：页面尺寸与页边距、正文主字体/字号、行距、缩进、段距、Title/Heading 1-3 样式，以及是否存在页码字段。

### 让目标文档沿用参考格式

```text
<python> <skill_runner.py> reference apply \
  --reference REFERENCE.docx \
  --input TARGET.docx \
  --output OUTPUT.docx
```

默认应用：

- 页面尺寸与页边距；
- Normal 正文样式；
- Title / Heading 1 / Heading 2 / Heading 3；
- 目标正文和表格中的字体字号；
- 标题段落的对应格式。

它**不复制参考文档正文、页眉页脚文字、修订、批注、字段内容或编号内容**，避免把样板中的案名、姓名、页眉文字等错误带入新文档。需要完全复用复杂模板结构时，应走模板填充或 worker 明确 unsupported 后再兜底。

如果只想改样式定义，不强制覆盖目标段落的直接格式：

```text
... reference apply ... --styles-only
```

参考格式任务的理想链路：

```text
已有目标 DOCX -> 1 次 reference/apply -> 交付
```

若是从零起草：

```text
write draft.md -> docx/from-markdown -> reference/apply -> 交付
```

通常 2-3 次工具调用即可。

## 5. Word worker

命令形态：

```text
<python> <skill_runner.py> docx <operation> <arguments...>
```

常用 operation：

- `inspect --input FILE`：只返回段落、表格、节、主要样式和复杂特性摘要；不输出全文。
- `normalize --input IN --output OUT --profile legal-default`：一次完成页面、样式、正文宋体小四、标题和审计。
- `normalize ... --scopes page`：只改页面；`body,styles` 或 `headings,styles` 可做局部规范化。
- `page --input IN --output OUT --top 2.54 --bottom 2.54 --left 3.17 --right 3.17`：只改页边距，不顺手重排全文。
- `from-markdown --input DRAFT.md --output OUT.docx --profile legal-default`：从一次性完成的 Markdown 生成 Word；普通新建文档优先走此路径。
- `replace --input IN --output OUT --old OLD --new NEW`：安全文字替换；跨 run 且无法保证格式时返回 unsupported。
- `template-fill --input TEMPLATE.docx --output OUT.docx --values VALUES.json`：填充 `{{NAME}}` 一类占位符；复杂跨 run 占位符返回 unsupported。

普通新建 Word 的目标链路：

```text
write draft.md -> 1 次 runner/from-markdown -> 交付
```

普通格式修改目标链路：

```text
1 次 runner/normalize 或 page -> audit 通过 -> 交付
```

worker 已返回 `status:"ok"` 且 audit 无 error/mismatch 时立即结束，不追加“再确认一下”的读取或渲染轮次。

## 6. PPTX worker

命令形态：

```text
<python> <skill_runner.py> pptx <operation> <arguments...>
```

常用 operation：

- `inspect --input FILE`：返回页数、布局、文本框等紧凑摘要；
- `from-json --input SPEC.json --output OUT.pptx`：一次性创建常规 PPT；
- `replace --input IN --output OUT --old OLD --new NEW`：安全替换文字。

PPT 先确定内容结构/模板，再一次性生成或修改。默认不逐页截图、不反复渲染。需要复杂母版、动画、媒体、特殊域等且 worker 明确 unsupported 时，才进入 Office MCP 兜底。

## 7. Office MCP 最后兜底

可判定为 unsupported 的典型情形：

- 需要完整保留并编辑复杂 Track Changes/修订结构；
- 宏、复杂域、内容控件、嵌入对象或特殊模板无法安全改写；
- 替换目标跨多个 run，重排会破坏既有格式；
- 旧 `.doc` / `.ppt` 的本地转换也无法完成；
- 其他 worker 能明确证明无法安全处理的结构。

worker 返回：

```json
{"status":"unsupported","marker":"LEGALWORK_DOCUMENT_UNSUPPORTED","reason":"...","fallback_ticket":"/tmp/...json"}
```

此时才调用 `request_office_fallback`。该工具验证一次性 ticket 后，只对当前 turn 临时开放 Office MCP。

Office MCP 解锁后只补 worker 无法完成的那一小部分：不重新做已完成内容、不 `view html`、不反复 help，同类修改 batch，完成必要验证后立即结束。

## 8. 成本与上下文纪律

- 不把完整 DOCX/PPTX HTML/XML、二进制编码、pip 日志塞进模型上下文；
- runner / worker stdout 只输出最后一条紧凑 JSON；
- 不为了确认重复读取同一文件；
- 不扫描 Skill 目录；Assets 已给出脚本路径；
- 普通格式修改目标 1-3 次工具调用；
- 新建普通 Word/PPT 目标 2-4 次工具调用；
- 有参考 Word 时，不先人工总结几十条格式规则再逐条修改，直接 `reference apply`；
- 文档越长，应主要增加本地 Python CPU 时间，而不增加模型循环次数。

## 9. 交付底线

用户要求优先；有模板/参考样板时优先保留其格式体系；默认另存副本；不擅自接受修订、删除批注/字段/签章或改写未授权正文。最终只说明产物位置、采用的 profile/参考样板和必要限制，不复述工具日志。
