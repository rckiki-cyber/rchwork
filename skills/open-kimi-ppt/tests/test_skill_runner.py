#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "skill_runner.py"
SPEC = importlib.util.spec_from_file_location("open_kimi_skill_runner", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class SkillRunnerTests(unittest.TestCase):
    def create_project(self, root: Path, styled: bool = True) -> Path:
        project = root / "deck"
        (project / "pages").mkdir(parents=True)
        theme = """
theme:
  colors: {primary: "#172554", accent: "#EA580C", text: "#111827"}
  textStyles:
    title: {fontSize: 38, color: "$primary", fontFamily: MiSans, bold: true}
    body: {fontSize: 18, color: "$text", fontFamily: MiSans}
""" if styled else ""
        (project / "deck.pptd").write_text(
            "version: v2\ntitle: Test\nsize: [960, 540]\n" + theme +
            "pages:\n  - pages/01.page\n",
            encoding="utf-8",
        )
        (project / "pages" / "01.page").write_text(
            """pageType: cover
background: {type: solid, color: "$primary"}
elements:
  - elementId: title
    elementType: text
    bounds: [80, 180, 800, 100]
    content: {style: "$title", text: "统一 Kimi 风格"}
""",
            encoding="utf-8",
        )
        return project

    def test_check_records_the_selected_scenario_and_style_contract(self):
        with tempfile.TemporaryDirectory() as name:
            project = self.create_project(Path(name))
            result = MODULE.run_check(project, "education-training")
            self.assertTrue(result["styleValidated"])
            self.assertEqual(result["engine"], "open-kimi-ppt")
            contract = Path(result["styleContract"])
            self.assertTrue(contract.is_file())
            saved = json.loads(contract.read_text(encoding="utf-8"))
            self.assertEqual(saved["scenario"], "education-training")
            self.assertIn("scenario", saved["guides"])

    def test_check_rejects_a_deck_without_a_central_style_theme(self):
        with tempfile.TemporaryDirectory() as name:
            project = self.create_project(Path(name), styled=False)
            with self.assertRaisesRegex(MODULE.ExportError, "theme must be a mapping"):
                MODULE.run_check(project, "education-training")

    @patch.object(MODULE, "export_local_pptx")
    def test_export_returns_one_unified_verified_result(self, export_local_pptx):
        with tempfile.TemporaryDirectory() as name:
            project = self.create_project(Path(name))
            output = project / "deck.pptx"
            export_local_pptx.return_value = {
                "slides": 1,
                "fadeTransitions": 1,
                "fontParts": 1,
                "bytes": 4096,
                "output": str(output),
                "exporter": "local-python-pptx",
                "warnings": [],
            }
            result = MODULE.run_export(
                project, output, "education-training", "fade", False
            )
            self.assertEqual(result["operation"], "export")
            self.assertTrue(result["styleValidated"])
            self.assertEqual(result["output"], str(output))
            self.assertEqual(result["exporter"], "local-python-pptx")
            export_local_pptx.assert_called_once_with(
                Path(result["manifest"]), output, "fade", force=False
            )


if __name__ == "__main__":
    unittest.main()
