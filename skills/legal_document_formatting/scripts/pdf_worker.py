#!/usr/bin/env python3
"""Create a deterministic PDF from DOCX with LegalWork-owned dependencies.

The production path deliberately never discovers or launches LibreOffice,
Microsoft Office, WPS, Acrobat, Preview, or another user-installed PDF app.
Rendering uses the Python runtime and CJK font shipped inside LegalWork so the
same input and profile produce the same layout on every supported platform.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import zipfile
from pathlib import Path
from typing import Any


SONGTI_SOURCE_NAMES = ("宋体", "SimSun", "Songti", "STSong")
SONGTI_PDF_MARKERS = (
    "simsun",
    "simsong",
    "songti",
    "stsong",
    "lisong",
    "notoserifcjk",
    "notoserifsc",
    "sourcehanserif",
)
BUNDLED_FONT_FILENAMES = ("NotoSerifSC-Regular.ttf", "NotoSerifSC-Bold.ttf")


def emit(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(code)


def docx_requests_songti(source: Path) -> bool:
    try:
        with zipfile.ZipFile(source) as archive:
            names = ("word/styles.xml", "word/document.xml", "word/fontTable.xml")
            payload = b"\n".join(archive.read(name) for name in names if name in archive.namelist())
        text = payload.decode("utf-8", errors="ignore")
        declared_fonts = re.findall(r"\bw:(?:ascii|hAnsi|eastAsia|cs)=\"([^\"]+)\"", text)
        return any(
            marker.lower() in font.lower()
            for font in declared_fonts
            for marker in SONGTI_SOURCE_NAMES
        )
    except (OSError, zipfile.BadZipFile):
        return False


def pdf_base_fonts(path: Path) -> list[str]:
    try:
        payload = path.read_bytes()
    except OSError:
        return []
    fonts = {
        match.decode("ascii", errors="ignore")
        for match in re.findall(rb"/BaseFont\s*/([^\s/<>()\[\]]+)", payload)
    }
    return sorted(fonts)


def pdf_has_songti(path: Path) -> bool:
    return any(
        marker in font.lower()
        for font in pdf_base_fonts(path)
        for marker in SONGTI_PDF_MARKERS
    )


def pdf_embeds_songti_font_program(path: Path) -> bool:
    try:
        payload = path.read_bytes()
    except OSError:
        return False
    for object_payload in re.findall(rb"\d+\s+\d+\s+obj\b(.*?)\bendobj", payload, flags=re.DOTALL):
        lowered = object_payload.lower()
        if not any(marker.encode("ascii") in lowered for marker in SONGTI_PDF_MARKERS):
            continue
        if b"/fontfile2" in lowered or b"/fontfile3" in lowered:
            return True
    return False


def bundled_cjk_font_paths() -> tuple[Path, Path]:
    # Tests and source checkouts may point at prepared fonts explicitly. The
    # packaged app never sets these and resolves Resources/office-fonts below.
    explicit_regular = os.environ.get("LEGALWORK_BUNDLED_CJK_FONT_REGULAR", "").strip()
    explicit_bold = os.environ.get("LEGALWORK_BUNDLED_CJK_FONT_BOLD", "").strip()
    script = Path(__file__).resolve()
    resources_or_repo = script.parents[3]
    packaged_fonts = tuple(resources_or_repo / "office-fonts" / name for name in BUNDLED_FONT_FILENAMES)
    packaged_install = (resources_or_repo / "app.asar").is_file() or (resources_or_repo / "app.asar.unpacked").is_dir()
    candidate_roots = [packaged_fonts]
    if not packaged_install:
        candidate_roots.extend([
            (
                Path(explicit_regular).expanduser() if explicit_regular else None,
                Path(explicit_bold).expanduser() if explicit_bold else None,
            ),
            tuple(
            resources_or_repo / "apps" / "desktop-legalwork" / "vendor" / "office-fonts" / name
            for name in BUNDLED_FONT_FILENAMES
            ),
        ])
    for regular, bold in candidate_roots:
        if (
            regular and bold and
            regular.is_file() and bold.is_file() and
            regular.stat().st_size > 1_000_000 and bold.stat().st_size > 1_000_000
        ):
            return regular.resolve(), bold.resolve()
    raise RuntimeError(
        "LegalWork bundled CJK fonts are missing. Reinstall the application; "
        "system fonts and user-installed office software are intentionally not used."
    )


def register_reportlab_songti() -> tuple[str, str, str]:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    regular_path, bold_path = bundled_cjk_font_paths()
    regular_name = "LegalWorkSongti"
    bold_name = "LegalWorkSongtiBold"
    pdfmetrics.registerFont(TTFont(regular_name, str(regular_path)))
    pdfmetrics.registerFont(TTFont(bold_name, str(bold_path)))
    pdfmetrics.registerFontFamily(
        "LegalWorkSongtiFamily",
        normal=regular_name,
        bold=bold_name,
        italic=regular_name,
        boldItalic=bold_name,
    )
    return regular_name, bold_name, "Noto Serif SC (bundled)"


def inherited_style_value(paragraph: Any, attribute: str) -> Any:
    value = getattr(paragraph.paragraph_format, attribute)
    if value is not None:
        return value
    style = paragraph.style
    while style is not None:
        value = getattr(style.paragraph_format, attribute)
        if value is not None:
            return value
        style = style.base_style
    return None


def style_font_size(document: Any, name: str, fallback: float) -> float:
    try:
        style = document.styles[name]
    except KeyError:
        return fallback
    while style is not None:
        if style.font.size is not None:
            return float(style.font.size.pt)
        style = style.base_style
    return fallback


def reportlab_convert(source: Path, output: Path) -> dict[str, Any]:
    from reportlab import rl_config
    from docx import Document
    from docx.table import Table as DocxTable
    from docx.text.paragraph import Paragraph as DocxParagraph
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import BaseDocTemplate, Frame, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle

    # Stable object ordering, timestamps, and document IDs make release and
    # regression comparisons meaningful across machines.
    rl_config.invariant = 1
    regular_font, bold_font, font_label = register_reportlab_songti()
    document = Document(str(source))
    section = document.sections[0]
    normal_size = style_font_size(document, "Normal", 12.0)
    normal_style = document.styles["Normal"]
    raw_spacing = normal_style.paragraph_format.line_spacing
    line_multiplier = float(raw_spacing) if isinstance(raw_spacing, (float, int)) and float(raw_spacing) <= 4 else 1.5
    body = ParagraphStyle(
        "LegalWorkBody",
        fontName=regular_font,
        fontSize=normal_size,
        leading=normal_size * line_multiplier,
        firstLineIndent=normal_size * 2,
        spaceBefore=0,
        spaceAfter=0,
        alignment=TA_JUSTIFY,
        wordWrap="CJK",
        allowWidows=0,
        allowOrphans=0,
    )
    heading_defaults = {
        1: (15.0, 12.0, 6.0),
        2: (14.0, 9.0, 3.0),
        3: (12.0, 6.0, 0.0),
        4: (12.0, 3.0, 0.0),
    }
    heading_styles: dict[int, ParagraphStyle] = {}
    for level, (fallback_size, fallback_before, fallback_after) in heading_defaults.items():
        style_name = f"Heading {level}"
        size = style_font_size(document, style_name, fallback_size)
        try:
            word_style = document.styles[style_name]
            before = word_style.paragraph_format.space_before
            after = word_style.paragraph_format.space_after
        except KeyError:
            before = after = None
        heading_styles[level] = ParagraphStyle(
            f"LWHeading{level}",
            parent=body,
            fontName=bold_font,
            fontSize=size,
            leading=size * 1.25,
            spaceBefore=before.pt if before is not None else fallback_before,
            spaceAfter=after.pt if after is not None else fallback_after,
            firstLineIndent=0,
            alignment=TA_LEFT,
            keepWithNext=True,
            allowWidows=0,
            allowOrphans=0,
        )
    title_size = style_font_size(document, "Title", 18.0)
    title = ParagraphStyle(
        "LWTitle",
        parent=body,
        fontName=bold_font,
        fontSize=title_size,
        leading=title_size,
        alignment=TA_CENTER,
        spaceBefore=0,
        spaceAfter=18,
        firstLineIndent=0,
        keepWithNext=True,
    )
    list_style = ParagraphStyle(
        "LWList",
        parent=body,
        leftIndent=normal_size * 2,
        firstLineIndent=-normal_size * 2,
    )
    quote_style = ParagraphStyle(
        "LWQuote",
        parent=body,
        leftIndent=normal_size * 2,
        rightIndent=normal_size * 2,
        firstLineIndent=0,
    )
    table_cell_style = ParagraphStyle(
        "LWTableCell",
        parent=body,
        firstLineIndent=0,
        fontSize=normal_size,
        leading=normal_size * 1.25,
        alignment=TA_LEFT,
    )
    story: list[Any] = []
    paragraph_count = 0
    table_count = 0
    number_index = 0
    for child in document.element.body.iterchildren():
        if child.tag.endswith("}p"):
            paragraph = DocxParagraph(child, document)
            text = paragraph.text.strip()
            if not text:
                story.append(Spacer(1, normal_size * 0.25))
                number_index = 0
                continue
            style_name = str(getattr(paragraph.style, "name", "") or "")
            lowered = style_name.lower()
            style = body
            if lowered in {"title", "标题"}:
                style = title
                number_index = 0
            elif "heading" in lowered or "标题" in style_name:
                digits = "".join(character for character in style_name if character.isdigit())
                level = min(4, max(1, int(digits or "1")))
                style = heading_styles[level]
                number_index = 0
            elif lowered.startswith("list number"):
                number_index += 1
                text = f"{number_index}. {text}"
                style = list_style
            elif lowered.startswith("list bullet"):
                number_index = 0
                text = f"• {text}"
                style = list_style
            elif lowered.startswith("quote"):
                number_index = 0
                style = quote_style
            else:
                number_index = 0

            if re.fullmatch(r"[（(]\s*全文完\s*[）)]", text) and story and isinstance(story[-1], Paragraph):
                previous = story.pop()
                end_marker_style = ParagraphStyle(
                    f"LWEndMarker{paragraph_count}",
                    parent=body,
                    firstLineIndent=0,
                    alignment=TA_CENTER,
                    spaceBefore=normal_size * 0.5,
                )
                story.append(KeepTogether([
                    previous,
                    Paragraph(html.escape(text), end_marker_style),
                ]))
                paragraph_count += 1
                continue

            first_indent = inherited_style_value(paragraph, "first_line_indent")
            if first_indent is not None and style is body:
                style = ParagraphStyle(
                    f"LWBody{paragraph_count}",
                    parent=body,
                    firstLineIndent=float(first_indent.pt),
                )
            story.append(Paragraph(html.escape(text).replace("\n", "<br/>"), style))
            paragraph_count += 1
        elif child.tag.endswith("}tbl"):
            source_table = DocxTable(child, document)
            rows = [
                [Paragraph(html.escape(cell.text.strip()).replace("\n", "<br/>"), table_cell_style) for cell in row.cells]
                for row in source_table.rows
            ]
            if not rows:
                continue
            table = Table(rows, repeatRows=1, hAlign="CENTER")
            table.setStyle(TableStyle([
                ("FONTNAME", (0, 0), (-1, -1), regular_font),
                ("FONTSIZE", (0, 0), (-1, -1), normal_size),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F3F5")),
            ]))
            story.extend([Spacer(1, normal_size * 0.5), table, Spacer(1, normal_size * 0.5)])
            table_count += 1
            number_index = 0

    if not story:
        story.append(Paragraph("（空文档）", body))
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = output.with_name(f".{output.name}.legalwork-converting")
    staged.unlink(missing_ok=True)
    pdf = BaseDocTemplate(
        str(staged),
        pagesize=(section.page_width.pt, section.page_height.pt) if section.page_width and section.page_height else A4,
        leftMargin=section.left_margin.pt,
        rightMargin=section.right_margin.pt,
        topMargin=section.top_margin.pt,
        bottomMargin=section.bottom_margin.pt,
        title=source.stem,
        author="LegalWork",
    )
    frame = Frame(
        pdf.leftMargin,
        pdf.bottomMargin,
        pdf.width,
        pdf.height,
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
        id="legalwork-body",
    )
    pdf.addPageTemplates([PageTemplate(id="legalwork", frames=[frame], pagesize=pdf.pagesize)])
    pdf.build(story)
    staged.replace(output)
    return {
        "paragraphs": paragraph_count,
        "tables": table_count,
        "font": font_label,
        "body_size_pt": normal_size,
        "line_spacing": line_multiplier,
    }


def cmd_from_docx(args: argparse.Namespace) -> None:
    source = Path(args.input).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != ".docx":
        emit({"status": "error", "operation": "from-docx", "error": f"input must be an existing .docx: {source}"}, 1)
    if output.suffix.lower() != ".pdf":
        emit({"status": "error", "operation": "from-docx", "error": "output must end with .pdf"}, 1)

    require_songti = docx_requests_songti(source)
    try:
        summary = reportlab_convert(source, output)
    except Exception as exc:
        emit({"status": "error", "operation": "from-docx", "error": str(exc)}, 1)
    if not output.is_file() or output.stat().st_size < 5 or output.read_bytes()[:4] != b"%PDF":
        emit({"status": "error", "operation": "from-docx", "error": "converter did not produce a valid PDF"}, 1)
    if not pdf_has_songti(output) or not pdf_embeds_songti_font_program(output):
        emit({
            "status": "error",
            "operation": "from-docx",
            "error": "PDF did not embed LegalWork's bundled CJK serif font",
        }, 1)
    emit({
        "status": "ok",
        "operation": "from-docx",
        "input": str(source),
        "output": str(output),
        "converter": "legalwork-reportlab-bundled",
        "bytes": output.stat().st_size,
        "summary": summary,
        "verification": {
            "source_requests_songti": require_songti,
            "pdf_fonts": pdf_base_fonts(output)[:16],
            "songti_embedded": pdf_has_songti(output),
            "font_program_embedded": pdf_embeds_songti_font_program(output),
            "external_office_used": False,
        },
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
