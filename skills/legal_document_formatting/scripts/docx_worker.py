#!/usr/bin/env python3
"""Deterministic DOCX worker for LegalWork's legal-document-formatting skill.

The worker emits one compact JSON object and never renders the whole document
into HTML. Unsupported-but-valid requests return exit code 0 with
status="unsupported" plus a one-time Office fallback ticket.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
import uuid
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

UNSUPPORTED_MARKER = "LEGALWORK_DOCUMENT_UNSUPPORTED"

try:
    from docx import Document
    from docx.enum.section import WD_ORIENT
    from docx.enum.style import WD_STYLE_TYPE
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt
except Exception as exc:  # pragma: no cover - environment-dependent
    Document = None  # type: ignore[assignment]
    IMPORT_ERROR = str(exc)
else:
    IMPORT_ERROR = ""

PROFILES: dict[str, dict[str, Any]] = {
    "legal-default": {
        "body_east_asia": "宋体",
        "body_latin": "Times New Roman",
        "body_size": 12.0,
        "line_spacing": 1.5,
        "first_line_chars": 2.0,
        "page": {
            "width_cm": 21.0,
            "height_cm": 29.7,
            "top_cm": 2.54,
            "bottom_cm": 2.54,
            "left_cm": 3.17,
            "right_cm": 3.17,
            "header_cm": 1.5,
            "footer_cm": 1.75,
        },
        "title": {"east_asia": "黑体", "latin": "Times New Roman", "size": 18.0, "bold": True},
        "heading1": {"east_asia": "黑体", "latin": "Times New Roman", "size": 14.0, "bold": True},
        "heading2": {"east_asia": "黑体", "latin": "Times New Roman", "size": 12.0, "bold": True},
        "heading3": {"east_asia": "宋体", "latin": "Times New Roman", "size": 12.0, "bold": True},
    },
    "academic": {
        "body_east_asia": "宋体",
        "body_latin": "Times New Roman",
        "body_size": 12.0,
        "line_spacing": 1.5,
        "first_line_chars": 2.0,
        "page": {
            "width_cm": 21.0,
            "height_cm": 29.7,
            "top_cm": 2.54,
            "bottom_cm": 2.54,
            "left_cm": 3.17,
            "right_cm": 3.17,
            "header_cm": 1.5,
            "footer_cm": 1.75,
        },
        "title": {"east_asia": "黑体", "latin": "Times New Roman", "size": 18.0, "bold": True},
        "heading1": {"east_asia": "黑体", "latin": "Times New Roman", "size": 15.0, "bold": True},
        "heading2": {"east_asia": "黑体", "latin": "Times New Roman", "size": 14.0, "bold": True},
        "heading3": {"east_asia": "宋体", "latin": "Times New Roman", "size": 12.0, "bold": True},
    },
    "litigation": {
        "body_east_asia": "宋体",
        "body_latin": "Times New Roman",
        "body_size": 12.0,
        "line_spacing": 1.5,
        "first_line_chars": 2.0,
        "page": {
            "width_cm": 21.0,
            "height_cm": 29.7,
            "top_cm": 2.5,
            "bottom_cm": 2.5,
            "left_cm": 3.0,
            "right_cm": 2.5,
            "header_cm": 1.5,
            "footer_cm": 1.75,
        },
        "title": {"east_asia": "黑体", "latin": "Times New Roman", "size": 18.0, "bold": True},
        "heading1": {"east_asia": "黑体", "latin": "Times New Roman", "size": 14.0, "bold": True},
        "heading2": {"east_asia": "黑体", "latin": "Times New Roman", "size": 12.0, "bold": True},
        "heading3": {"east_asia": "宋体", "latin": "Times New Roman", "size": 12.0, "bold": True},
    },
}

SPECIAL_STYLE_PREFIXES = (
    "title", "subtitle", "heading", "caption", "quote", "footnote",
    "header", "footer", "toc", "目录", "标题", "题注", "引文",
)


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(exit_code)


def create_fallback_ticket(operation: str, reason: str, detail: Any | None) -> str:
    root = Path(tempfile.gettempdir()) / "legalwork-office-fallback"
    root.mkdir(parents=True, exist_ok=True)
    ticket = root / f"ticket-{uuid.uuid4().hex}.json"
    payload = {
        "marker": UNSUPPORTED_MARKER,
        "status": "unsupported",
        "source": "legal-document-formatting",
        "operation": operation,
        "reason": reason,
        "detail": detail,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    ticket.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return str(ticket)


def unsupported(reason: str, *, operation: str, detail: Any | None = None) -> None:
    payload: dict[str, Any] = {
        "status": "unsupported",
        "marker": UNSUPPORTED_MARKER,
        "operation": operation,
        "reason": reason,
        "fallback": "office_mcp",
        "fallback_ticket": create_fallback_ticket(operation, reason, detail),
    }
    if detail is not None:
        payload["detail"] = detail
    emit(payload)


def fail(message: str, *, operation: str) -> None:
    emit({"status": "error", "operation": operation, "error": message}, 1)


def require_docx(operation: str) -> None:
    if Document is None:
        unsupported(f"python-docx unavailable: {IMPORT_ERROR}", operation=operation)


def ensure_docx_path(path: str, operation: str, must_exist: bool = True) -> Path:
    p = Path(path).expanduser().resolve()
    if must_exist and not p.is_file():
        fail(f"file not found: {p}", operation=operation)
    if p.suffix.lower() != ".docx":
        unsupported(f"only .docx is handled locally (got {p.suffix or 'no extension'})", operation=operation)
    return p


def copy_for_output(src: Path, output: str, operation: str) -> Path:
    dst = Path(output).expanduser().resolve()
    if dst.suffix.lower() != ".docx":
        fail("output must end with .docx", operation=operation)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src != dst:
        shutil.copy2(src, dst)
    return dst


def detect_complex_features(path: Path) -> dict[str, bool]:
    features = {
        "tracked_changes": False,
        "comments": False,
        "content_controls": False,
        "fields": False,
        "macros": False,
    }
    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            features["comments"] = "word/comments.xml" in names
            features["macros"] = any(name.lower().endswith("vbaproject.bin") for name in names)
            for name in ("word/document.xml", "word/footnotes.xml", "word/endnotes.xml"):
                if name not in names:
                    continue
                text = zf.read(name).decode("utf-8", errors="ignore")
                if "<w:ins" in text or "<w:del" in text or "<w:moveFrom" in text or "<w:moveTo" in text:
                    features["tracked_changes"] = True
                if "<w:sdt" in text:
                    features["content_controls"] = True
                if "<w:fldSimple" in text or "<w:instrText" in text:
                    features["fields"] = True
    except zipfile.BadZipFile:
        fail("invalid DOCX zip container", operation="inspect")
    return features


def east_asia_font(run_or_style: Any) -> str | None:
    try:
        rpr = run_or_style._element.get_or_add_rPr()
        rfonts = rpr.rFonts
        return None if rfonts is None else rfonts.get(qn("w:eastAsia"))
    except Exception:
        return None


def set_font(target: Any, east_asia: str, latin: str, size_pt: float, bold: bool | None = None) -> None:
    target.font.name = latin
    target.font.size = Pt(size_pt)
    if bold is not None:
        target.font.bold = bold
    rfonts = target._element.get_or_add_rPr().get_or_add_rFonts()
    rfonts.set(qn("w:ascii"), latin)
    rfonts.set(qn("w:hAnsi"), latin)
    rfonts.set(qn("w:eastAsia"), east_asia)
    rfonts.set(qn("w:cs"), latin)


def set_style_font(style: Any, east_asia: str, latin: str, size_pt: float, bold: bool | None = None) -> None:
    style.font.name = latin
    style.font.size = Pt(size_pt)
    if bold is not None:
        style.font.bold = bold
    rfonts = style._element.get_or_add_rPr().get_or_add_rFonts()
    rfonts.set(qn("w:ascii"), latin)
    rfonts.set(qn("w:hAnsi"), latin)
    rfonts.set(qn("w:eastAsia"), east_asia)
    rfonts.set(qn("w:cs"), latin)


def is_body_paragraph(paragraph: Any) -> bool:
    name = (paragraph.style.name if paragraph.style is not None else "").strip().lower()
    return not any(name.startswith(prefix) for prefix in SPECIAL_STYLE_PREFIXES)


def apply_page(section: Any, page: dict[str, float]) -> None:
    section.orientation = WD_ORIENT.PORTRAIT
    section.page_width = Cm(page["width_cm"])
    section.page_height = Cm(page["height_cm"])
    section.top_margin = Cm(page["top_cm"])
    section.bottom_margin = Cm(page["bottom_cm"])
    section.left_margin = Cm(page["left_cm"])
    section.right_margin = Cm(page["right_cm"])
    section.header_distance = Cm(page["header_cm"])
    section.footer_distance = Cm(page["footer_cm"])


def ensure_style(doc: Any, name: str, style_type: Any = WD_STYLE_TYPE.PARAGRAPH) -> Any:
    try:
        return doc.styles[name]
    except KeyError:
        return doc.styles.add_style(name, style_type)


def apply_profile(doc: Any, profile_name: str, scopes: set[str]) -> dict[str, int]:
    profile = PROFILES.get(profile_name)
    if profile is None:
        unsupported(f"unknown profile: {profile_name}", operation="normalize", detail={"profiles": sorted(PROFILES)})
    changed = Counter()
    if "page" in scopes:
        for section in doc.sections:
            apply_page(section, profile["page"])
            changed["sections"] += 1

    if "styles" in scopes or "body" in scopes:
        normal = ensure_style(doc, "Normal")
        set_style_font(normal, profile["body_east_asia"], profile["body_latin"], profile["body_size"])
        pf = normal.paragraph_format
        pf.line_spacing = profile["line_spacing"]
        pf.space_before = Pt(0)
        pf.space_after = Pt(0)
        pf.first_line_indent = Pt(profile["body_size"] * profile["first_line_chars"])
        normal._element.get_or_add_pPr().append(OxmlElement("w:widowControl"))
        changed["styles"] += 1

    style_map = {
        "Title": profile["title"],
        "Heading 1": profile["heading1"],
        "Heading 2": profile["heading2"],
        "Heading 3": profile["heading3"],
    }
    if "styles" in scopes or "headings" in scopes:
        for name, cfg in style_map.items():
            style = ensure_style(doc, name)
            set_style_font(style, cfg["east_asia"], cfg["latin"], cfg["size"], cfg["bold"])
            changed["styles"] += 1

    if "body" in scopes:
        for paragraph in doc.paragraphs:
            if not paragraph.text.strip() or not is_body_paragraph(paragraph):
                continue
            fmt = paragraph.paragraph_format
            fmt.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            fmt.line_spacing = profile["line_spacing"]
            fmt.space_before = Pt(0)
            fmt.space_after = Pt(0)
            fmt.first_line_indent = Pt(profile["body_size"] * profile["first_line_chars"])
            for run in paragraph.runs:
                set_font(run, profile["body_east_asia"], profile["body_latin"], profile["body_size"])
                changed["runs"] += 1
            changed["paragraphs"] += 1
        for table in doc.tables:
            for row in table.rows:
                for cell in row.cells:
                    for paragraph in cell.paragraphs:
                        for run in paragraph.runs:
                            set_font(run, profile["body_east_asia"], profile["body_latin"], profile["body_size"])
                            changed["table_runs"] += 1
            changed["tables"] += 1

    if "headings" in scopes:
        for paragraph in doc.paragraphs:
            style_name = paragraph.style.name if paragraph.style is not None else ""
            cfg = style_map.get(style_name)
            if not cfg:
                continue
            paragraph.paragraph_format.keep_with_next = True
            paragraph.paragraph_format.first_line_indent = Pt(0)
            for run in paragraph.runs:
                set_font(run, cfg["east_asia"], cfg["latin"], cfg["size"], cfg["bold"])
                changed["heading_runs"] += 1
            changed["headings"] += 1
    return dict(changed)


def summarize(doc: Any, path: Path) -> dict[str, Any]:
    style_counts = Counter((p.style.name if p.style is not None else "(none)") for p in doc.paragraphs if p.text.strip())
    sections = []
    for section in doc.sections[:8]:
        sections.append({
            "page_cm": [round(section.page_width.cm, 2), round(section.page_height.cm, 2)],
            "margins_cm": [
                round(section.top_margin.cm, 2), round(section.bottom_margin.cm, 2),
                round(section.left_margin.cm, 2), round(section.right_margin.cm, 2),
            ],
        })
    return {
        "file": str(path),
        "paragraphs": len(doc.paragraphs),
        "nonempty_paragraphs": sum(1 for p in doc.paragraphs if p.text.strip()),
        "tables": len(doc.tables),
        "sections": len(doc.sections),
        "top_styles": style_counts.most_common(8),
        "section_sample": sections,
        "features": detect_complex_features(path),
    }


def audit_profile(doc: Any, profile_name: str) -> dict[str, Any]:
    profile = PROFILES[profile_name]
    mismatches = Counter()
    checked = 0
    samples: list[dict[str, Any]] = []
    for idx, paragraph in enumerate(doc.paragraphs):
        if not paragraph.text.strip() or not is_body_paragraph(paragraph):
            continue
        checked += 1
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            latin = run.font.name or paragraph.style.font.name
            ea = east_asia_font(run) or east_asia_font(paragraph.style)
            size = run.font.size.pt if run.font.size else (paragraph.style.font.size.pt if paragraph.style.font.size else None)
            bad = []
            if latin and latin != profile["body_latin"]:
                mismatches["latin_font"] += 1
                bad.append(f"latin={latin}")
            if ea and ea != profile["body_east_asia"]:
                mismatches["east_asia_font"] += 1
                bad.append(f"eastAsia={ea}")
            if size is not None and abs(size - profile["body_size"]) > 0.05:
                mismatches["font_size"] += 1
                bad.append(f"size={size}")
            if bad and len(samples) < 5:
                samples.append({"paragraph": idx + 1, "issues": bad, "text": paragraph.text[:80]})
    return {"checked_body_paragraphs": checked, "mismatches": dict(mismatches), "samples": samples}


def cmd_inspect(args: argparse.Namespace) -> None:
    operation = "inspect"
    require_docx(operation)
    path = ensure_docx_path(args.input, operation)
    try:
        emit({"status": "ok", "operation": operation, "summary": summarize(Document(str(path)), path)})
    except SystemExit:
        raise
    except Exception as exc:
        fail(str(exc), operation=operation)


def cmd_normalize(args: argparse.Namespace) -> None:
    operation = "normalize"
    require_docx(operation)
    src = ensure_docx_path(args.input, operation)
    features = detect_complex_features(src)
    if (features["tracked_changes"] or features["macros"]) and not args.allow_complex:
        unsupported(
            "document contains tracked changes or macros; local normalization would not guarantee full preservation",
            operation=operation,
            detail=features,
        )
    dst = copy_for_output(src, args.output, operation)
    scopes = {part.strip() for part in args.scopes.split(",") if part.strip()}
    allowed = {"page", "styles", "body", "headings"}
    if not scopes or not scopes <= allowed:
        fail(f"invalid scopes: {sorted(scopes - allowed)}", operation=operation)
    try:
        doc = Document(str(dst))
        changes = apply_profile(doc, args.profile, scopes)
        doc.save(str(dst))
        reloaded = Document(str(dst))
        audit = audit_profile(reloaded, args.profile) if "body" in scopes else {"checked_body_paragraphs": 0, "mismatches": {}}
        emit({
            "status": "ok",
            "operation": operation,
            "output": str(dst),
            "profile": args.profile,
            "scopes": sorted(scopes),
            "changes": changes,
            "audit": audit,
        })
    except SystemExit:
        raise
    except Exception as exc:
        fail(str(exc), operation=operation)


def cmd_page(args: argparse.Namespace) -> None:
    operation = "page"
    require_docx(operation)
    src = ensure_docx_path(args.input, operation)
    dst = copy_for_output(src, args.output, operation)
    try:
        doc = Document(str(dst))
        base = dict(PROFILES[args.profile]["page"])
        overrides = {
            "top_cm": args.top,
            "bottom_cm": args.bottom,
            "left_cm": args.left,
            "right_cm": args.right,
            "header_cm": args.header,
            "footer_cm": args.footer,
        }
        for key, value in overrides.items():
            if value is not None:
                base[key] = float(value)
        for section in doc.sections:
            apply_page(section, base)
        doc.save(str(dst))
        emit({"status": "ok", "operation": operation, "output": str(dst), "sections": len(doc.sections), "page": base})
    except Exception as exc:
        fail(str(exc), operation=operation)


def replace_in_container(paragraphs: Iterable[Any], old: str, new: str) -> tuple[int, int]:
    replaced = 0
    spanning = 0
    for paragraph in paragraphs:
        if old not in paragraph.text:
            continue
        local = 0
        for run in paragraph.runs:
            count = run.text.count(old)
            if count:
                run.text = run.text.replace(old, new)
                local += count
        if local:
            replaced += local
        elif old in paragraph.text:
            spanning += 1
    return replaced, spanning


def all_paragraphs(doc: Any) -> Iterable[Any]:
    yield from doc.paragraphs
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                yield from cell.paragraphs


def cmd_replace(args: argparse.Namespace) -> None:
    operation = "replace"
    require_docx(operation)
    src = ensure_docx_path(args.input, operation)
    dst = copy_for_output(src, args.output, operation)
    try:
        doc = Document(str(dst))
        replaced, spanning = replace_in_container(all_paragraphs(doc), args.old, args.new)
        if spanning and not args.allow_reflow:
            unsupported(
                "target text crosses Word run boundaries; safe local replacement would not preserve formatting",
                operation=operation,
                detail={"spanning_paragraphs": spanning, "single_run_replacements": replaced},
            )
        if spanning and args.allow_reflow:
            for paragraph in all_paragraphs(doc):
                if args.old in paragraph.text:
                    text = paragraph.text.replace(args.old, args.new)
                    paragraph.clear()
                    paragraph.add_run(text)
                    replaced += 1
        if replaced:
            doc.save(str(dst))
        emit({"status": "ok", "operation": operation, "output": str(dst), "replacements": replaced})
    except SystemExit:
        raise
    except Exception as exc:
        fail(str(exc), operation=operation)


def parse_markdown_blocks(text: str) -> list[dict[str, Any]]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[dict[str, Any]] = []
    paragraph: list[str] = []

    def flush() -> None:
        if paragraph:
            blocks.append({"type": "paragraph", "text": " ".join(part.strip() for part in paragraph).strip()})
            paragraph.clear()

    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped:
            flush(); i += 1; continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        if heading:
            flush(); blocks.append({"type": "heading", "level": len(heading.group(1)), "text": heading.group(2).strip()}); i += 1; continue
        if re.match(r"^[-*+]\s+", stripped):
            flush(); blocks.append({"type": "bullet", "text": re.sub(r"^[-*+]\s+", "", stripped)}); i += 1; continue
        if re.match(r"^\d+[.)]\s+", stripped):
            flush(); blocks.append({"type": "number", "text": re.sub(r"^\d+[.)]\s+", "", stripped)}); i += 1; continue
        if "|" in stripped and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{3,}", lines[i + 1]):
            flush()
            rows = [[cell.strip() for cell in stripped.strip("|").split("|")]]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append([cell.strip() for cell in lines[i].strip().strip("|").split("|")])
                i += 1
            blocks.append({"type": "table", "rows": rows})
            continue
        paragraph.append(stripped)
        i += 1
    flush()
    return blocks


def cmd_from_markdown(args: argparse.Namespace) -> None:
    operation = "from-markdown"
    require_docx(operation)
    md = Path(args.input).expanduser().resolve()
    if not md.is_file():
        fail(f"file not found: {md}", operation=operation)
    out = Path(args.output).expanduser().resolve()
    if out.suffix.lower() != ".docx":
        fail("output must end with .docx", operation=operation)
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        doc = Document()
        apply_profile(doc, args.profile, {"page", "styles"})
        blocks = parse_markdown_blocks(md.read_text(encoding="utf-8"))
        for block in blocks:
            kind = block["type"]
            if kind == "heading":
                p = doc.add_paragraph(style=f"Heading {int(block['level'])}")
                p.add_run(block["text"])
            elif kind == "bullet":
                doc.add_paragraph(block["text"], style="List Bullet")
            elif kind == "number":
                doc.add_paragraph(block["text"], style="List Number")
            elif kind == "table":
                rows = block["rows"]
                width = max((len(row) for row in rows), default=1)
                table = doc.add_table(rows=len(rows), cols=width)
                table.style = "Table Grid"
                for r_idx, row in enumerate(rows):
                    for c_idx, value in enumerate(row):
                        table.cell(r_idx, c_idx).text = value
            else:
                doc.add_paragraph(block["text"], style="Normal")
        apply_profile(doc, args.profile, {"body", "headings"})
        doc.save(str(out))
        reloaded = Document(str(out))
        emit({
            "status": "ok",
            "operation": operation,
            "output": str(out),
            "profile": args.profile,
            "blocks": len(blocks),
            "summary": {"paragraphs": len(reloaded.paragraphs), "tables": len(reloaded.tables)},
            "audit": audit_profile(reloaded, args.profile),
        })
    except SystemExit:
        raise
    except Exception as exc:
        fail(str(exc), operation=operation)


def cmd_template_fill(args: argparse.Namespace) -> None:
    operation = "template-fill"
    require_docx(operation)
    src = ensure_docx_path(args.input, operation)
    dst = copy_for_output(src, args.output, operation)
    try:
        values = json.loads(Path(args.values).read_text(encoding="utf-8"))
        if not isinstance(values, dict):
            fail("values JSON must be an object", operation=operation)
        doc = Document(str(dst))
        unresolved: list[str] = []
        total = 0
        for key, value in values.items():
            old = "{{" + str(key) + "}}"
            replaced, spanning = replace_in_container(all_paragraphs(doc), old, str(value))
            total += replaced
            if spanning:
                unresolved.append(str(key))
        if unresolved:
            unsupported(
                "template placeholders cross Word run boundaries; local replacement cannot guarantee layout preservation",
                operation=operation,
                detail={"keys": unresolved[:20]},
            )
        doc.save(str(dst))
        emit({"status": "ok", "operation": operation, "output": str(dst), "replacements": total})
    except SystemExit:
        raise
    except Exception as exc:
        fail(str(exc), operation=operation)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LegalWork deterministic DOCX worker")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("inspect")
    p.add_argument("--input", required=True)
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("normalize")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--profile", choices=sorted(PROFILES), default="legal-default")
    p.add_argument("--scopes", default="page,styles,body,headings")
    p.add_argument("--allow-complex", action="store_true")
    p.set_defaults(func=cmd_normalize)

    p = sub.add_parser("page")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--profile", choices=sorted(PROFILES), default="legal-default")
    p.add_argument("--top", type=float)
    p.add_argument("--bottom", type=float)
    p.add_argument("--left", type=float)
    p.add_argument("--right", type=float)
    p.add_argument("--header", type=float)
    p.add_argument("--footer", type=float)
    p.set_defaults(func=cmd_page)

    p = sub.add_parser("replace")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--old", required=True)
    p.add_argument("--new", required=True)
    p.add_argument("--allow-reflow", action="store_true")
    p.set_defaults(func=cmd_replace)

    p = sub.add_parser("from-markdown")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--profile", choices=sorted(PROFILES), default="legal-default")
    p.set_defaults(func=cmd_from_markdown)

    p = sub.add_parser("template-fill")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--values", required=True)
    p.set_defaults(func=cmd_template_fill)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
