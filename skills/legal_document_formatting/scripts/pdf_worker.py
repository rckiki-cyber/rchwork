#!/usr/bin/env python3
"""Create a readable PDF from a DOCX without relying on Office MCP.

LibreOffice is preferred because it preserves the Word layout. A bundled
ReportLab fallback keeps PDF delivery available on machines without an Office
installation while preserving the full paragraph/table text and heading
hierarchy.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(code)


def office_candidates() -> list[str]:
    raw = [
        os.environ.get("LEGALWORK_SOFFICE"),
        shutil.which("soffice"),
        shutil.which("libreoffice"),
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ]
    seen: set[str] = set()
    result: list[str] = []
    for value in raw:
        path = str(value or "").strip()
        if not path or path in seen:
            continue
        seen.add(path)
        if Path(path).is_file() or shutil.which(path):
            result.append(path)
    return result


def atomic_copy(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = output.with_name(f".{output.name}.legalwork-converting")
    staged.unlink(missing_ok=True)
    shutil.copy2(source, staged)
    staged.replace(output)


def try_libreoffice(source: Path, output: Path) -> str | None:
    for executable in office_candidates():
        try:
            with tempfile.TemporaryDirectory(prefix="legalwork-pdf-convert-") as directory:
                completed = subprocess.run(
                    [executable, "--headless", "--convert-to", "pdf", "--outdir", directory, str(source)],
                    capture_output=True,
                    text=True,
                    timeout=180,
                    check=False,
                )
                generated = Path(directory) / f"{source.stem}.pdf"
                if completed.returncode == 0 and generated.is_file() and generated.stat().st_size > 4:
                    atomic_copy(generated, output)
                    return Path(executable).name
        except Exception:
            continue
    return None


def reportlab_convert(source: Path, output: Path) -> dict[str, int]:
    from docx import Document
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    styles = getSampleStyleSheet()
    body = ParagraphStyle(
        "LegalWorkBody",
        parent=styles["BodyText"],
        fontName="STSong-Light",
        fontSize=12,
        leading=20,
        firstLineIndent=24,
        spaceAfter=2,
        wordWrap="CJK",
    )
    heading_styles = {
        1: ParagraphStyle("LWHeading1", parent=body, fontSize=18, leading=26, spaceBefore=12, spaceAfter=8, firstLineIndent=0),
        2: ParagraphStyle("LWHeading2", parent=body, fontSize=16, leading=24, spaceBefore=10, spaceAfter=6, firstLineIndent=0),
        3: ParagraphStyle("LWHeading3", parent=body, fontSize=14, leading=22, spaceBefore=8, spaceAfter=4, firstLineIndent=0),
        4: ParagraphStyle("LWHeading4", parent=body, fontSize=12, leading=20, spaceBefore=6, spaceAfter=3, firstLineIndent=0),
    }
    title = ParagraphStyle(
        "LWTitle",
        parent=heading_styles[1],
        fontSize=22,
        leading=30,
        alignment=TA_CENTER,
        spaceAfter=16,
        firstLineIndent=0,
    )
    document = Document(str(source))
    story: list[Any] = []
    paragraph_count = 0
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            story.append(Spacer(1, 4))
            continue
        style_name = str(getattr(paragraph.style, "name", "") or "")
        lowered = style_name.lower()
        style = body
        if lowered in {"title", "标题"}:
            style = title
        elif "heading" in lowered or "标题" in style_name:
            digits = "".join(character for character in style_name if character.isdigit())
            level = min(4, max(1, int(digits or "1")))
            style = heading_styles[level]
        story.append(Paragraph(html.escape(text).replace("\n", "<br/>"), style))
        paragraph_count += 1

    table_count = 0
    for source_table in document.tables:
        rows = [[Paragraph(html.escape(cell.text.strip()), body) for cell in row.cells] for row in source_table.rows]
        if not rows:
            continue
        table = Table(rows, repeatRows=1, hAlign="CENTER")
        table.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), "STSong-Light"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F3F5")),
        ]))
        story.extend([Spacer(1, 6), table, Spacer(1, 8)])
        table_count += 1

    if not story:
        story.append(Paragraph("（空文档）", body))
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = output.with_name(f".{output.name}.legalwork-converting")
    staged.unlink(missing_ok=True)
    pdf = SimpleDocTemplate(
        str(staged),
        pagesize=A4,
        leftMargin=25.4 * mm,
        rightMargin=25.4 * mm,
        topMargin=25.4 * mm,
        bottomMargin=25.4 * mm,
        title=source.stem,
        author="LegalWork",
    )
    pdf.build(story)
    staged.replace(output)
    return {"paragraphs": paragraph_count, "tables": table_count}


def cmd_from_docx(args: argparse.Namespace) -> None:
    source = Path(args.input).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != ".docx":
        emit({"status": "error", "operation": "from-docx", "error": f"input must be an existing .docx: {source}"}, 1)
    if output.suffix.lower() != ".pdf":
        emit({"status": "error", "operation": "from-docx", "error": "output must end with .pdf"}, 1)

    converter = try_libreoffice(source, output)
    summary: dict[str, int] = {}
    if converter is None:
        try:
            summary = reportlab_convert(source, output)
            converter = "reportlab"
        except Exception as exc:
            emit({"status": "error", "operation": "from-docx", "error": str(exc)}, 1)
    if not output.is_file() or output.stat().st_size < 5 or output.read_bytes()[:4] != b"%PDF":
        emit({"status": "error", "operation": "from-docx", "error": "converter did not produce a valid PDF"}, 1)
    emit({
        "status": "ok",
        "operation": "from-docx",
        "input": str(source),
        "output": str(output),
        "converter": converter,
        "bytes": output.stat().st_size,
        "summary": summary,
    })


def main() -> None:
    parser = argparse.ArgumentParser(description="LegalWork deterministic PDF worker")
    sub = parser.add_subparsers(dest="command", required=True)
    command = sub.add_parser("from-docx")
    command.add_argument("--input", required=True)
    command.add_argument("--output", required=True)
    command.set_defaults(func=cmd_from_docx)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
