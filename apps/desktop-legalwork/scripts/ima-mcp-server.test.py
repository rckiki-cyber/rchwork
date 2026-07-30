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


if __name__ == "__main__":
    unittest.main()
