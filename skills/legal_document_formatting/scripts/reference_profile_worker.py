#!/usr/bin/env python3
"""Extract and apply compact formatting rules from a reference DOCX.

The worker never renders document HTML or returns document text. It resolves
Word style inheritance (Heading -> Normal), captures Heading 1-4, page setup,
and dominant body formatting, then applies those conventions to a target DOCX.
"""
from __future__ import annotations

import argparse
import json
import shutil
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

try:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt
except Exception as exc:  # pragma: no cover
    Document = None  # type: ignore[assignment]
    IMPORT_ERROR = str(exc)
else:
    IMPORT_ERROR = ""

SPECIAL_PREFIXES = (
    "title", "subtitle", "heading", "caption", "quote", "footnote",
    "header", "footer", "toc", "目录", "标题", "题注", "引文",
)
STYLE_NAMES = ("Title", "Heading 1", "Heading 2", "Heading 3", "Heading 4")


def emit(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(code)


def fail(message: str, code: int = 1) -> None:
    emit({"status": "error", "operation": "reference-profile", "error": message}, code)


def require_docx() -> None:
    if Document is None:
        fail(f"python-docx unavailable: {IMPORT_ERROR}")


def docx_path(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if not path.is_file():
        fail(f"file not found: {path}")
    if path.suffix.lower() != ".docx":
        fail(f"reference-driven formatting only supports .docx (got {path.suffix or 'no extension'})")
    return path


def east_asia_font(target: Any) -> str | None:
    try:
        rpr = target._element.get_or_add_rPr()
        fonts = rpr.rFonts
        return None if fonts is None else fonts.get(qn("w:eastAsia"))
    except Exception:
        return None


def pt(value: Any) -> float | None:
    try:
        return round(float(value.pt), 2) if value is not None else None
    except Exception:
        return None


def line_spacing(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return round(float(value), 3)
    return pt(value)


def alignment(value: Any) -> int | None:
    try:
        return None if value is None else int(value)
    except Exception:
        return None


def font_format(target: Any) -> dict[str, Any]:
    font = target.font
    return {
        "east_asia": east_asia_font(target),
        "latin": font.name,
        "size_pt": pt(font.size),
        "bold": bool(font.bold) if font.bold is not None else None,
        "italic": bool(font.italic) if font.italic is not None else None,
    }


def paragraph_format(target: Any) -> dict[str, Any]:
    fmt = target.paragraph_format
    return {
        "alignment": alignment(fmt.alignment),
        "line_spacing": line_spacing(fmt.line_spacing),
        "first_line_indent_pt": pt(fmt.first_line_indent),
        "left_indent_pt": pt(fmt.left_indent),
        "right_indent_pt": pt(fmt.right_indent),
        "space_before_pt": pt(fmt.space_before),
        "space_after_pt": pt(fmt.space_after),
        "keep_with_next": bool(fmt.keep_with_next) if fmt.keep_with_next is not None else None,
    }


def merge(primary: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    return {key: primary.get(key) if primary.get(key) is not None else fallback.get(key) for key in primary}


def effective_style(style: Any) -> dict[str, Any]:
    """Resolve explicit style properties through Word's basedOn chain."""
    chain: list[Any] = []
    current = style
    seen: set[int] = set()
    while current is not None and id(current) not in seen and len(chain) < 12:
        seen.add(id(current))
        chain.append(current)
        current = current.base_style
    font: dict[str, Any] = {"east_asia": None, "latin": None, "size_pt": None, "bold": None, "italic": None}
    para: dict[str, Any] = {
        "alignment": None, "line_spacing": None, "first_line_indent_pt": None,
        "left_indent_pt": None, "right_indent_pt": None,
        "space_before_pt": None, "space_after_pt": None, "keep_with_next": None,
    }
    for item in reversed(chain):
        font = merge(font_format(item), font)
        para = merge(paragraph_format(item), para)
    return {"font": font, "paragraph": para}


def is_body(paragraph: Any) -> bool:
    name = (paragraph.style.name if paragraph.style is not None else "").strip().lower()
    return bool(paragraph.text.strip()) and not any(name.startswith(prefix) for prefix in SPECIAL_PREFIXES)


def weighted_mode(values: Iterable[tuple[Any, int]]) -> Any | None:
    counts: Counter[Any] = Counter()
    for value, weight in values:
        if value is not None and weight > 0:
            counts[value] += weight
    return counts.most_common(1)[0][0] if counts else None


def dominant_body_format(doc: Any) -> dict[str, Any]:
    normal = effective_style(doc.styles["Normal"])
    latin: list[tuple[str | None, int]] = []
    east_asia: list[tuple[str | None, int]] = []
    sizes: list[tuple[float | None, int]] = []
    alignments: list[tuple[int | None, int]] = []
    spacings: list[tuple[float | None, int]] = []
    indents: list[tuple[float | None, int]] = []
    before: list[tuple[float | None, int]] = []
    after: list[tuple[float | None, int]] = []

    for paragraph in doc.paragraphs:
        if not is_body(paragraph):
            continue
        weight = max(1, len(paragraph.text.strip()))
        style = effective_style(paragraph.style)
        direct_para = paragraph_format(paragraph)
        resolved_para = merge(direct_para, style["paragraph"])
        alignments.append((resolved_para["alignment"], weight))
        spacings.append((resolved_para["line_spacing"], weight))
        indents.append((resolved_para["first_line_indent_pt"], weight))
        before.append((resolved_para["space_before_pt"], weight))
        after.append((resolved_para["space_after_pt"], weight))
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            rw = max(1, len(run.text.strip()))
            resolved_font = merge(font_format(run), style["font"])
            latin.append((resolved_font["latin"], rw))
            east_asia.append((resolved_font["east_asia"], rw))
            sizes.append((resolved_font["size_pt"], rw))

    return {
        "font": {
            "latin": weighted_mode(latin) or normal["font"]["latin"],
            "east_asia": weighted_mode(east_asia) or normal["font"]["east_asia"],
            "size_pt": weighted_mode(sizes) or normal["font"]["size_pt"],
            "bold": normal["font"]["bold"],
            "italic": normal["font"]["italic"],
        },
        "paragraph": {
            "alignment": weighted_mode(alignments) if alignments else normal["paragraph"]["alignment"],
            "line_spacing": weighted_mode(spacings) if spacings else normal["paragraph"]["line_spacing"],
            "first_line_indent_pt": weighted_mode(indents) if indents else normal["paragraph"]["first_line_indent_pt"],
            "left_indent_pt": normal["paragraph"]["left_indent_pt"],
            "right_indent_pt": normal["paragraph"]["right_indent_pt"],
            "space_before_pt": weighted_mode(before) if before else normal["paragraph"]["space_before_pt"],
            "space_after_pt": weighted_mode(after) if after else normal["paragraph"]["space_after_pt"],
            "keep_with_next": normal["paragraph"]["keep_with_next"],
        },
    }


def page_profile(section: Any) -> dict[str, float | None]:
    def cm(value: Any) -> float | None:
        try:
            return round(float(value.cm), 3) if value is not None else None
        except Exception:
            return None
    return {
        "width_cm": cm(section.page_width), "height_cm": cm(section.page_height),
        "top_cm": cm(section.top_margin), "bottom_cm": cm(section.bottom_margin),
        "left_cm": cm(section.left_margin), "right_cm": cm(section.right_margin),
        "header_cm": cm(section.header_distance), "footer_cm": cm(section.footer_distance),
    }


def has_page_field(doc: Any) -> bool:
    for section in doc.sections:
        for paragraph in section.footer.paragraphs:
            if "PAGE" in paragraph._p.xml or "NUMPAGES" in paragraph._p.xml:
                return True
    return False


def extract_profile(doc: Any, source: Path) -> dict[str, Any]:
    styles: dict[str, Any] = {}
    for style_name in STYLE_NAMES:
        try:
            styles[style_name] = effective_style(doc.styles[style_name])
        except KeyError:
            continue
    return {
        "source": str(source),
        "page": page_profile(doc.sections[0]),
        "body": dominant_body_format(doc),
        "styles": styles,
        "footer": {"has_page_number": has_page_field(doc)},
    }


def set_font(target: Any, spec: dict[str, Any]) -> None:
    latin = spec.get("latin")
    east_asia = spec.get("east_asia")
    size = spec.get("size_pt")
    if latin:
        target.font.name = latin
    if size:
        target.font.size = Pt(float(size))
    if spec.get("bold") is not None:
        target.font.bold = bool(spec["bold"])
    if spec.get("italic") is not None:
        target.font.italic = bool(spec["italic"])
    if latin or east_asia:
        fonts = target._element.get_or_add_rPr().get_or_add_rFonts()
        if latin:
            fonts.set(qn("w:ascii"), latin); fonts.set(qn("w:hAnsi"), latin); fonts.set(qn("w:cs"), latin)
        if east_asia:
            fonts.set(qn("w:eastAsia"), east_asia)


def apply_paragraph(target: Any, spec: dict[str, Any]) -> None:
    fmt = target.paragraph_format
    if spec.get("alignment") is not None:
        try:
            fmt.alignment = WD_ALIGN_PARAGRAPH(int(spec["alignment"]))
        except Exception:
            pass
    spacing = spec.get("line_spacing")
    if spacing is not None:
        fmt.line_spacing = float(spacing) if float(spacing) <= 4 else Pt(float(spacing))
    for key, attr in (
        ("first_line_indent_pt", "first_line_indent"), ("left_indent_pt", "left_indent"),
        ("right_indent_pt", "right_indent"), ("space_before_pt", "space_before"),
        ("space_after_pt", "space_after"),
    ):
        if spec.get(key) is not None:
            setattr(fmt, attr, Pt(float(spec[key])))
    if spec.get("keep_with_next") is not None:
        fmt.keep_with_next = bool(spec["keep_with_next"])


def apply_page(doc: Any, page: dict[str, Any]) -> None:
    for section in doc.sections:
        if page.get("width_cm"): section.page_width = Cm(float(page["width_cm"]))
        if page.get("height_cm"): section.page_height = Cm(float(page["height_cm"]))
        for key, attr in (
            ("top_cm", "top_margin"), ("bottom_cm", "bottom_margin"),
            ("left_cm", "left_margin"), ("right_cm", "right_margin"),
            ("header_cm", "header_distance"), ("footer_cm", "footer_distance"),
        ):
            if page.get(key) is not None:
                setattr(section, attr, Cm(float(page[key])))


def apply_profile(doc: Any, profile: dict[str, Any], materialize_body: bool) -> dict[str, int]:
    changed = Counter()
    apply_page(doc, profile["page"])
    changed["sections"] += len(doc.sections)
    body = profile["body"]
    normal = doc.styles["Normal"]
    set_font(normal, body["font"]); apply_paragraph(normal, body["paragraph"])
    changed["styles"] += 1

    for style_name, spec in profile.get("styles", {}).items():
        try:
            style = doc.styles[style_name]
        except KeyError:
            continue
        set_font(style, spec["font"]); apply_paragraph(style, spec["paragraph"])
        changed["styles"] += 1

    if materialize_body:
        for paragraph in doc.paragraphs:
            style_name = paragraph.style.name if paragraph.style is not None else ""
            spec = profile.get("styles", {}).get(style_name)
            if is_body(paragraph):
                apply_paragraph(paragraph, body["paragraph"])
                for run in paragraph.runs:
                    if run.text: set_font(run, body["font"]); changed["body_runs"] += 1
                changed["body_paragraphs"] += 1
            elif spec:
                apply_paragraph(paragraph, spec["paragraph"])
                for run in paragraph.runs:
                    if run.text: set_font(run, spec["font"]); changed["heading_runs"] += 1
                changed["headings"] += 1
        for table in doc.tables:
            for row in table.rows:
                for cell in row.cells:
                    for paragraph in cell.paragraphs:
                        for run in paragraph.runs:
                            if run.text: set_font(run, body["font"]); changed["table_runs"] += 1
    return dict(changed)


def cmd_inspect(args: argparse.Namespace) -> None:
    require_docx()
    reference = docx_path(args.input)
    emit({"status": "ok", "operation": "reference-inspect", "profile": extract_profile(Document(str(reference)), reference)})


def cmd_apply(args: argparse.Namespace) -> None:
    require_docx()
    reference = docx_path(args.reference)
    source = docx_path(args.input)
    output = Path(args.output).expanduser().resolve()
    if output.suffix.lower() != ".docx": fail("output must end with .docx")
    output.parent.mkdir(parents=True, exist_ok=True)
    if source != output: shutil.copy2(source, output)
    profile = extract_profile(Document(str(reference)), reference)
    target = Document(str(output))
    changed = apply_profile(target, profile, materialize_body=not args.styles_only)
    target.save(str(output))
    emit({
        "status": "ok", "operation": "format-like-reference", "reference": str(reference),
        "output": str(output), "changed": changed,
        "profile_summary": {
            "page": profile["page"], "body": profile["body"],
            "styles": list(profile["styles"].keys()), "footer": profile["footer"],
        },
        "limitations": [
            "headers/footers content is not copied",
            "custom numbering, fields, comments, and tracked changes are preserved in the target but not cloned from the reference",
        ],
    })


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LegalWork reference-driven DOCX formatter")
    sub = parser.add_subparsers(dest="command", required=True)
    inspect = sub.add_parser("inspect"); inspect.add_argument("--input", required=True); inspect.set_defaults(func=cmd_inspect)
    apply = sub.add_parser("apply")
    apply.add_argument("--reference", required=True); apply.add_argument("--input", required=True); apply.add_argument("--output", required=True)
    apply.add_argument("--styles-only", action="store_true"); apply.set_defaults(func=cmd_apply)
    return parser


def main() -> None:
    args = build_parser().parse_args(); args.func(args)


if __name__ == "__main__":
    main()
