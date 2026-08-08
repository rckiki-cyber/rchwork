from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn


WORKER = Path(__file__).resolve().parents[1] / "scripts" / "docx_worker.py"
PROFILE_WORKER = Path(__file__).resolve().parents[1] / "scripts" / "legal_profile_worker.py"


class FromMarkdownFormattingTest(unittest.TestCase):
    def test_academic_output_does_not_inherit_blue_title_theme(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            root = Path(raw_tmp)
            source = root / "review.md"
            output = root / "review.docx"
            source.write_text(
                "# 自动化行政行为程序要件重构\n\n"
                "## 摘要\n\n"
                "这是用于检查宋体小四、黑色标题和段落格式的正文。\n\n"
                "### 一、研究进展\n\n"
                "这是第二段正文。\n\n"
                "## 六、参考文献\n\n"
                "[1] 张三. 一个长度足以换行的参考文献标题[J]. 法学研究, 2026(1): 1-20。",
                encoding="utf-8",
            )

            completed = subprocess.run(
                [
                    sys.executable,
                    str(WORKER),
                    "from-markdown",
                    "--input",
                    str(source),
                    "--output",
                    str(output),
                    "--profile",
                    "academic",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            payload = json.loads(completed.stdout)
            self.assertEqual(payload["status"], "ok")

            doc = Document(output)
            self.assertEqual([p.text for p in doc.paragraphs[:3]], [
                "自动化行政行为程序要件重构",
                "摘要",
                "这是用于检查宋体小四、黑色标题和段落格式的正文。",
            ])

            title = doc.styles["Title"]
            heading1 = doc.styles["Heading 1"]
            heading2 = doc.styles["Heading 2"]
            for style in (title, heading1, heading2):
                self.assertEqual(str(style.font.color.rgb), "000000")
                self.assertIsNone(style._element.get_or_add_pPr().find(qn("w:pBdr")))
                self.assertIsNone(style._element.get_or_add_rPr().find(qn("w:spacing")))

            self.assertEqual(title.paragraph_format.alignment, WD_ALIGN_PARAGRAPH.CENTER)
            self.assertAlmostEqual(title.paragraph_format.space_after.pt, 18.0)
            self.assertAlmostEqual(heading1.paragraph_format.space_before.pt, 12.0)
            self.assertAlmostEqual(heading1.paragraph_format.space_after.pt, 6.0)
            self.assertAlmostEqual(heading2.paragraph_format.space_before.pt, 9.0)
            self.assertAlmostEqual(heading2.paragraph_format.space_after.pt, 3.0)

            body = doc.paragraphs[2]
            self.assertEqual(body.alignment, WD_ALIGN_PARAGRAPH.JUSTIFY)
            self.assertAlmostEqual(body.paragraph_format.first_line_indent.pt, 24.0)
            run = body.runs[0]
            fonts = run._element.get_or_add_rPr().get_or_add_rFonts()
            self.assertEqual(fonts.get(qn("w:eastAsia")), "宋体")
            self.assertEqual(fonts.get(qn("w:hint")), "eastAsia")
            self.assertEqual(str(doc.styles["Normal"].font.color.rgb), "000000")

            reference = next(p for p in doc.paragraphs if p.text.startswith("[1]"))
            self.assertAlmostEqual(reference.paragraph_format.left_indent.pt, 24.0)
            self.assertAlmostEqual(reference.paragraph_format.first_line_indent.pt, -24.0)

    def test_semantic_profile_also_clears_builtin_title_residue(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            root = Path(raw_tmp)
            source = root / "agreement.docx"
            output = root / "agreement-formatted.docx"
            doc = Document()
            doc.add_paragraph("委托代理协议", style="Title")
            doc.add_paragraph("甲乙双方经协商一致，订立本协议。")
            doc.save(source)

            completed = subprocess.run(
                [
                    sys.executable,
                    str(PROFILE_WORKER),
                    "apply",
                    "--input",
                    str(source),
                    "--output",
                    str(output),
                    "--profile",
                    "engagement-agreement",
                    "--scopes",
                    "body,headings",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(json.loads(completed.stdout)["status"], "ok")
            formatted = Document(output)
            title = formatted.styles["Title"]
            self.assertEqual(str(title.font.color.rgb), "000000")
            self.assertIsNone(title._element.get_or_add_pPr().find(qn("w:pBdr")))
            self.assertIsNone(title._element.get_or_add_rPr().find(qn("w:spacing")))


if __name__ == "__main__":
    unittest.main()
