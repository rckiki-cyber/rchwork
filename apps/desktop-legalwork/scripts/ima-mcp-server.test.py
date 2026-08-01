#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path


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

    def test_normal_answer_is_not_an_mcp_error(self):
        self.assertFalse(
            self.server._is_tool_result_error({"answer": "这是正常回答"})
        )


if __name__ == "__main__":
    unittest.main()
