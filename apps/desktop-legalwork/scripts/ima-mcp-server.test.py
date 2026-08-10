#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


def load_server_module():
    path = Path(__file__).with_name("ima-mcp-server.py")
    spec = importlib.util.spec_from_file_location("ima_mcp_server_test_target", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ImaQuestionPreparationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server_module()

    def test_academic_question_requires_reference_titles_and_authors(self):
        prepared = self.server._prepare_ima_question(
            "请梳理人工智能监管领域的代表性论文"
        )
        self.assertIn("文献完整名称及作者", prepared)
        self.assertIn("作者信息未提供", prepared)
        self.assertIn("不得猜测或补造作者", prepared)

    def test_non_academic_question_is_not_modified(self):
        question = "行政复议申请期限是什么？"
        self.assertEqual(self.server._prepare_ima_question(question), question)

    def test_preparation_is_idempotent(self):
        prepared = self.server._prepare_ima_question("请做一份数据法学文献综述")
        self.assertEqual(self.server._prepare_ima_question(prepared), prepared)


class ImaSseParsingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server_module()

    def test_extracts_current_text_message_shape(self):
        event = {
            "Id": "answer-1",
            "Type": "text_message",
            "Data": {"text_message": {"Text": "数字行政法研究结论"}},
        }
        answers = []
        refs = []
        diagnostics = {"codes": set(), "shapes": set()}

        self.server._collect_qa_event(event, answers, refs, diagnostics)

        self.assertEqual(answers, ["数字行政法研究结论"])

    def test_collects_files_from_current_file_list_shape(self):
        event = {
            "Id": "files-1",
            "Type": "tool_result",
            "Data": {
                "file_list": {
                    "status": 0,
                    "files": [
                        {"title": "数字行政处罚研究.pdf"},
                        {"fileName": "数字行政法论文.docx"},
                    ],
                }
            },
        }
        answers = []
        refs = []
        diagnostics = {"codes": set(), "shapes": set()}

        self.server._collect_qa_event(event, answers, refs, diagnostics)

        self.assertEqual(
            refs,
            ["数字行政处罚研究.pdf", "数字行政法论文.docx"],
        )

    def test_protocol_error_answer_is_an_mcp_error(self):
        result = {
            "answer": (
                "【IMA 自动选库：⚖️法律法规库】\n\n"
                "IMA_PROTOCOL_ERROR: HTTP 200 但未解析到回答。"
            )
        }

        self.assertTrue(self.server._is_tool_result_error(result))

    def test_no_match_and_no_answer_are_mcp_errors(self):
        self.assertTrue(
            self.server._is_tool_result_error({"answer": "IMA_NO_MATCH: 未命中内容"})
        )
        self.assertTrue(
            self.server._is_tool_result_error({"answer": "IMA_NO_ANSWER: 没有回答正文"})
        )

    def test_normal_answer_is_not_an_mcp_error(self):
        self.assertFalse(
            self.server._is_tool_result_error({"answer": "这是正常回答"})
        )


class ImaKnowledgeBaseRoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server_module()

    def test_catalog_ranking_selects_the_relevant_legal_domain(self):
        catalog = [
            {
                "id": "criminal",
                "name": "刑事法学研究",
                "description": "犯罪构成与量刑",
                "recommended_questions": [],
                "documents": [{"title": "危害食品药品安全犯罪"}],
            },
            {
                "id": "digital",
                "name": "数字法学研究",
                "description": "人工智能、数据与算法治理",
                "recommended_questions": ["自动化行政如何规制"],
                "documents": [{"title": "算法行政的正当程序"}],
            },
        ]

        ranked = self.server._rank_knowledge_bases(
            "自动化行政决策中的算法解释与正当程序",
            catalog,
        )

        self.assertEqual(ranked[0]["id"], "digital")
        self.assertGreater(ranked[0]["routing_score"], ranked[1]["routing_score"])

    def test_zero_score_does_not_arbitrarily_select_the_first_kb(self):
        plan = self.server._plan_knowledge_base_route(
            "天气怎么样",
            [
                {"id": "a", "name": "A", "routing_score": 0, "matched_terms": []},
                {"id": "b", "name": "B", "routing_score": 0, "matched_terms": []},
            ],
        )

        self.assertEqual(plan["confidence"], "none")
        self.assertEqual(plan["selected"], [])

    def test_catalog_cache_is_not_used_after_credentials_are_removed(self):
        self.server._catalog_cache.update({
            "expires_at": float("inf"),
            "credential_fingerprint": "old",
            "knowledge_bases": [{"id": "private", "name": "旧登录库"}],
        })

        with patch.object(self.server, "_get_cookie_creds", return_value=("", "")):
            knowledge_bases, error = self.server._fetch_cookie_knowledge_bases()

        self.assertEqual(knowledge_bases, [])
        self.assertIn("需要 IMA 登录凭证", error)

    def test_close_candidates_use_bounded_top_two(self):
        ranked = [
            {"id": "a", "name": "刑事法学", "routing_score": 4.0, "matched_terms": ["食药犯罪"]},
            {"id": "b", "name": "立法司法资料", "routing_score": 3.2, "matched_terms": ["刑法修正"]},
            {"id": "c", "name": "行政法学", "routing_score": 2.9, "matched_terms": ["行政从属"]},
        ]

        plan = self.server._plan_knowledge_base_route(
            "综合研究危害食品药品安全犯罪与刑法修正案",
            ranked,
        )

        self.assertEqual(plan["confidence"], "medium")
        self.assertEqual([item["id"] for item in plan["selected"]], ["a", "b"])

    def test_research_ima_asks_two_close_candidates_without_listing_preflight(self):
        candidates = [
            {"id": "a", "name": "刑事法学", "routing_score": 4.0, "matched_terms": ["食药犯罪"]},
            {"id": "b", "name": "立法司法资料", "routing_score": 3.2, "matched_terms": ["刑法修正"]},
        ]
        catalog_result = {"knowledge_bases": candidates}

        with patch.object(
            self.server,
            "handle_search_ima_catalog",
            return_value=catalog_result,
        ) as catalog, patch.object(
            self.server,
            "qa_ask",
            side_effect=lambda question, kb_id, timeout: f"{kb_id}的有效研究结果",
        ) as ask:
            result = self.server.handle_research_ima({
                "question": "综合研究危害食品药品安全犯罪与刑法修正案",
                "timeout": 90,
            })

        catalog.assert_called_once()
        self.assertEqual(ask.call_count, 2)
        self.assertEqual(
            [item["id"] for item in result["selected_knowledge_bases"]],
            ["a", "b"],
        )
        self.assertIn("来自知识库「刑事法学」", result["answer"])
        self.assertIn("来自知识库「立法司法资料」", result["answer"])

    def test_top_one_no_match_falls_back_once(self):
        candidates = [
            {"id": "a", "name": "数字法学", "routing_score": 5.0, "matched_terms": ["算法", "行政"]},
            {"id": "b", "name": "行政法学", "routing_score": 2.0, "matched_terms": ["行政"]},
        ]

        with patch.object(
            self.server,
            "handle_search_ima_catalog",
            return_value={"knowledge_bases": candidates},
        ), patch.object(
            self.server,
            "qa_ask",
            side_effect=["IMA_NO_MATCH: 未命中", "备选库的有效答案"],
        ) as ask:
            result = self.server.handle_research_ima({
                "question": "算法行政的程序规制",
                "timeout": 90,
            })

        self.assertEqual(ask.call_count, 2)
        self.assertEqual(result["routing"]["confidence"], "fallback")
        self.assertEqual(result["selected_knowledge_bases"][-1]["id"], "b")
        self.assertIn("备选库的有效答案", result["answer"])

    def test_openapi_search_without_id_routes_instead_of_scanning_all_kbs(self):
        candidates = [
            {"id": "a", "name": "数字法学", "routing_score": 5.0, "matched_terms": ["算法", "行政"]},
            {"id": "b", "name": "行政法学", "routing_score": 2.0, "matched_terms": ["行政"]},
        ]

        with patch.object(
            self.server,
            "handle_search_ima_catalog",
            return_value={"knowledge_bases": candidates},
        ), patch.object(
            self.server,
            "api_call",
            return_value={
                "info_list": [{
                    "media_id": "doc-1",
                    "title": "算法行政的程序规制",
                    "highlight_content": "自动化行政中的算法解释",
                }],
                "is_end": True,
            },
        ) as api_call:
            result = self.server.handle_search_knowledge({
                "query": "算法行政的程序规制",
            })

        self.assertEqual(api_call.call_count, 1)
        self.assertEqual(
            api_call.call_args.args[1]["knowledge_base_id"],
            "a",
        )
        self.assertEqual(result["searched_kbs"], 1)
        self.assertEqual(result["results"][0]["knowledge_base_name"], "数字法学")


if __name__ == "__main__":
    unittest.main()
