#!/usr/bin/env python3
"""Audit structural Word-format rules without modifying the DOCX."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable
from zipfile import BadZipFile, ZipFile
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CP_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
DC_NS = "http://purl.org/dc/elements/1.1/"
W = f"{{{W_NS}}}"
NS = {"w": W_NS}
DXA_PER_CM = 1440 / 2.54


@dataclass
class Finding:
    severity: str
    code: str
    message: str
    location: str = ""


PROFILE_RULES = {
    "generic": {"table_required": False},
    "litigation": {
        "margins_cm": (2.54, 2.54, 3.18, 3.18),
        "font_size_pt": 12.0,
        "table_required": False,
    },
    "professional": {
        "margins_cm": (2.54, 2.54, 3.18, 3.18),
        "font_size_pt": 12.0,
        "table_required": False,
    },
    "contract": {
        "margins_cm": (2.5, 2.5, 2.75, 2.75),
        "font_size_pt": 12.0,
        "table_required": False,
    },
    "evidence": {
        "font_size_pt": 10.5,
        "table_required": True,
    },
    "academic": {
        "margins_cm": (2.54, 2.54, 3.18, 3.18),
        "font_size_pt": 10.5,
        "table_required": False,
    },
}

SERIF_CJK = {
    "宋体",
    "simsun",
    "songti sc",
    "songti sc regular",
    "noto serif cjk sc",
    "source han serif sc",
}
SERIF_LATIN = {"times new roman", "times", "liberation serif"}


def qval(element: ET.Element | None, name: str = "val") -> str | None:
    return element.get(W + name) if element is not None else None


def cm(value: str | None) -> float | None:
    try:
        return round(float(value) / DXA_PER_CM, 2)
    except (TypeError, ValueError):
        return None


def half_points(value: str | None) -> float | None:
    try:
        return float(value) / 2
    except (TypeError, ValueError):
        return None


def text_of(element: ET.Element) -> str:
    return "".join(node.text or "" for node in element.findall(".//w:t", NS))


def add(
    findings: list[Finding],
    severity: str,
    code: str,
    message: str,
    location: str = "",
) -> None:
    findings.append(Finding(severity, code, message, location))


def read_xml(archive: ZipFile, name: str) -> ET.Element | None:
    try:
        return ET.fromstring(archive.read(name))
    except KeyError:
        return None


def first_run_props(style: ET.Element | None) -> dict[str, object]:
    if style is None:
        return {}
    rpr = style.find("w:rPr", NS)
    if rpr is None:
        return {}
    fonts = rpr.find("w:rFonts", NS)
    return {
        "eastAsia": qval(fonts, "eastAsia"),
        "ascii": qval(fonts, "ascii") or qval(fonts, "hAnsi"),
        "size_pt": half_points(qval(rpr.find("w:sz", NS))),
    }


def style_baseline(styles: ET.Element | None) -> dict[str, object]:
    if styles is None:
        return {}
    defaults: dict[str, object] = {}
    rpr_default = styles.find("w:docDefaults/w:rPrDefault/w:rPr", NS)
    if rpr_default is not None:
        wrapper = ET.Element("style")
        wrapper.append(rpr_default)
        defaults.update(first_run_props(wrapper))

    normal = None
    for style in styles.findall("w:style", NS):
        if style.get(W + "type") != "paragraph":
            continue
        style_id = (style.get(W + "styleId") or "").lower()
        name = (qval(style.find("w:name", NS)) or "").lower()
        if style_id == "normal" or name in {"normal", "正文"}:
            normal = style
            break
    return {**defaults, **{k: v for k, v in first_run_props(normal).items() if v is not None}}


def paragraph_style_stats(document: ET.Element) -> tuple[Counter[str], int, int, int]:
    styles: Counter[str] = Counter()
    repeated_space_count = 0
    fake_list_count = 0
    empty_run = 0
    for paragraph in document.findall(".//w:body/w:p", NS):
        text = text_of(paragraph)
        ppr = paragraph.find("w:pPr", NS)
        pstyle = qval(ppr.find("w:pStyle", NS)) if ppr is not None else None
        styles[pstyle or "(none)"] += 1
        if re.search(r"[ \u3000]{3,}", text):
            repeated_space_count += 1
        if re.match(r"^\s*(?:[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|\d+[.、]|[-•●○])", text):
            if ppr is None or ppr.find("w:numPr", NS) is None:
                fake_list_count += 1
        if not text and paragraph.find(".//w:drawing", NS) is None:
            empty_run += 1
    return styles, repeated_space_count, fake_list_count, empty_run


def audit_sections(
    document: ET.Element,
    profile: str,
    findings: list[Finding],
) -> list[dict[str, object]]:
    rules = PROFILE_RULES[profile]
    sections: list[dict[str, object]] = []
    sect_prs = document.findall(".//w:sectPr", NS)
    if not sect_prs:
        add(findings, "error", "missing-section", "文档没有可识别的节属性。")
        return sections

    for index, sect in enumerate(sect_prs, 1):
        page = sect.find("w:pgSz", NS)
        margins = sect.find("w:pgMar", NS)
        width = cm(qval(page, "w"))
        height = cm(qval(page, "h"))
        orient = qval(page, "orient") or "portrait"
        record = {
            "index": index,
            "width_cm": width,
            "height_cm": height,
            "orientation": orient,
            "top_cm": cm(qval(margins, "top")),
            "bottom_cm": cm(qval(margins, "bottom")),
            "left_cm": cm(qval(margins, "left")),
            "right_cm": cm(qval(margins, "right")),
        }
        sections.append(record)
        location = f"section:{index}"

        if width is None or height is None:
            add(findings, "error", "missing-page-size", "节未显式设置纸张尺寸。", location)
        else:
            dims = sorted((round(width, 1), round(height, 1)))
            if not (abs(dims[0] - 21.0) <= 0.2 and abs(dims[1] - 29.7) <= 0.2):
                add(findings, "warning", "non-a4", f"纸张尺寸为 {width} × {height} cm，不是 A4。", location)

        values = (record["top_cm"], record["bottom_cm"], record["left_cm"], record["right_cm"])
        if any(value is None for value in values):
            add(findings, "error", "missing-margins", "节未完整显式设置四周页边距。", location)
        expected = rules.get("margins_cm")
        if expected and all(value is not None for value in values):
            if any(abs(float(actual) - target) > 0.65 for actual, target in zip(values, expected)):
                add(
                    findings,
                    "warning",
                    "profile-margins",
                    f"页边距 {values} cm 偏离 {profile} 默认值 {expected} cm；有模板时可忽略。",
                    location,
                )
    return sections


def audit_styles(
    styles: ET.Element | None,
    profile: str,
    findings: list[Finding],
) -> dict[str, object]:
    baseline = style_baseline(styles)
    if styles is None:
        add(findings, "error", "missing-styles", "缺少 styles.xml。")
        return baseline

    if not baseline:
        add(findings, "warning", "missing-normal-style", "未识别到正文/Normal 样式基线。")
        return baseline

    cjk = str(baseline.get("eastAsia") or "").strip()
    latin = str(baseline.get("ascii") or "").strip()
    size = baseline.get("size_pt")
    if not cjk:
        add(findings, "warning", "missing-cjk-font", "正文样式未显式设置东亚字体。")
    elif cjk.lower() not in SERIF_CJK and profile in {"litigation", "professional", "contract", "academic"}:
        add(findings, "warning", "unexpected-cjk-font", f"正文东亚字体为 {cjk}，请确认符合模板。")
    if not latin:
        add(findings, "warning", "missing-latin-font", "正文样式未显式设置西文字体。")
    elif latin.lower() not in SERIF_LATIN and profile in {"litigation", "professional", "contract", "academic"}:
        add(findings, "warning", "unexpected-latin-font", f"正文西文字体为 {latin}，请确认符合模板。")

    expected_size = PROFILE_RULES[profile].get("font_size_pt")
    if size is None:
        add(findings, "warning", "missing-body-size", "正文样式未显式设置字号。")
    elif expected_size and abs(float(size) - float(expected_size)) > 1.6:
        add(
            findings,
            "warning",
            "profile-body-size",
            f"正文字号为 {size} pt，偏离 {profile} 默认值 {expected_size} pt；有模板时可忽略。",
        )

    heading_count = 0
    missing_outline = 0
    for style in styles.findall("w:style", NS):
        if style.get(W + "type") != "paragraph":
            continue
        style_id = style.get(W + "styleId") or ""
        name = qval(style.find("w:name", NS)) or ""
        if re.search(r"(heading|标题)\s*[1-9一二三四五六七八九]", f"{style_id} {name}", re.I):
            heading_count += 1
            if style.find("w:pPr/w:outlineLvl", NS) is None:
                missing_outline += 1
    if heading_count and missing_outline:
        add(
            findings,
            "warning",
            "heading-outline",
            f"{missing_outline}/{heading_count} 个标题样式没有显式大纲级别，目录和导航可能失效。",
        )
    return baseline


def audit_tables(document: ET.Element, profile: str, findings: list[Finding]) -> dict[str, int]:
    tables = document.findall(".//w:tbl", NS)
    if PROFILE_RULES[profile].get("table_required") and not tables:
        add(findings, "error", "table-required", f"{profile} profile 要求至少包含一个结构化表格。")

    missing_grid = 0
    missing_width = 0
    missing_header = 0
    exact_rows = 0
    for table in tables:
        if table.find("w:tblGrid", NS) is None:
            missing_grid += 1
        if table.find("w:tblPr/w:tblW", NS) is None:
            missing_width += 1
        rows = table.findall("w:tr", NS)
        if rows and rows[0].find("w:trPr/w:tblHeader", NS) is None:
            missing_header += 1
        for row in rows:
            height = row.find("w:trPr/w:trHeight", NS)
            if height is not None and qval(height, "hRule") == "exact":
                exact_rows += 1

    if missing_grid:
        add(findings, "warning", "table-grid", f"{missing_grid} 个表格缺少显式 tblGrid。")
    if missing_width:
        add(findings, "warning", "table-width", f"{missing_width} 个表格缺少显式表宽。")
    if missing_header and tables:
        add(findings, "warning", "repeat-header", f"{missing_header} 个表格首行未设置重复表头。")
    if exact_rows:
        add(findings, "warning", "exact-row-height", f"{exact_rows} 行使用固定行高，可能截断文字。")
    return {
        "tables": len(tables),
        "missing_grid": missing_grid,
        "missing_width": missing_width,
        "missing_repeat_header": missing_header,
        "exact_height_rows": exact_rows,
    }


def audit_package(path: Path, profile: str) -> dict[str, object]:
    findings: list[Finding] = []
    try:
        archive = ZipFile(path)
    except (BadZipFile, OSError) as exc:
        return {
            "path": str(path),
            "profile": profile,
            "findings": [asdict(Finding("error", "invalid-docx", f"无法打开 DOCX：{exc}"))],
            "summary": {"errors": 1, "warnings": 0, "info": 0},
        }

    with archive:
        names = set(archive.namelist())
        required = {"[Content_Types].xml", "word/document.xml", "word/styles.xml"}
        for missing in sorted(required - names):
            add(findings, "error", "missing-part", f"缺少 OOXML 部件：{missing}")

        document = read_xml(archive, "word/document.xml")
        styles = read_xml(archive, "word/styles.xml")
        if document is None:
            add(findings, "error", "missing-document", "无法解析 word/document.xml。")
            sections: list[dict[str, object]] = []
            table_stats: dict[str, int] = {}
            paragraph_stats: dict[str, object] = {}
            baseline: dict[str, object] = {}
        else:
            sections = audit_sections(document, profile, findings)
            baseline = audit_styles(styles, profile, findings)
            table_stats = audit_tables(document, profile, findings)
            styles_used, repeated_spaces, fake_lists, empty_paragraphs = paragraph_style_stats(document)
            paragraph_stats = {
                "body_paragraphs": sum(styles_used.values()),
                "styles_used": dict(styles_used.most_common()),
                "paragraphs_with_alignment_spaces": repeated_spaces,
                "likely_fake_lists": fake_lists,
                "empty_body_paragraphs": empty_paragraphs,
            }
            if repeated_spaces:
                add(findings, "warning", "space-alignment", f"{repeated_spaces} 个正文段落疑似用连续空格对齐。")
            if fake_lists:
                add(findings, "warning", "fake-numbering", f"{fake_lists} 个段落疑似手打编号或项目符号。")
            if empty_paragraphs > max(8, int(sum(styles_used.values()) * 0.08)):
                add(findings, "warning", "empty-paragraphs", f"正文有 {empty_paragraphs} 个空段落，检查是否用空段推版。")

            instructions = " ".join(node.text or "" for node in document.findall(".//w:instrText", NS))
            if re.search(r"\bTOC\b", instructions, re.I):
                add(findings, "info", "toc-field", "检测到自动目录字段。")
            if re.search(r"\bPAGE\b", instructions, re.I):
                add(findings, "info", "page-field", "检测到页码字段。")
            if document.find(".//w:hidden", NS) is not None or document.find(".//w:vanish", NS) is not None:
                add(findings, "warning", "hidden-text", "文档包含隐藏文字。")
            if document.find(".//w:ins", NS) is not None or document.find(".//w:del", NS) is not None:
                add(findings, "warning", "tracked-changes", "文档包含修订记录；交付前确认保留或清理策略。")

        if "word/comments.xml" in names:
            comments = read_xml(archive, "word/comments.xml")
            count = len(comments.findall("w:comment", NS)) if comments is not None else 0
            if count:
                add(findings, "warning", "comments", f"文档包含 {count} 条批注。")

        core = read_xml(archive, "docProps/core.xml")
        metadata: dict[str, str] = {}
        if core is not None:
            for label, query in {
                "creator": f"{{{DC_NS}}}creator",
                "last_modified_by": f"{{{CP_NS}}}lastModifiedBy",
            }.items():
                node = core.find(query)
                if node is not None and (node.text or "").strip():
                    metadata[label] = (node.text or "").strip()
            if metadata:
                add(findings, "info", "metadata", "文档包含作者/最后修改者元数据；对外交付时检查是否需要清理。")

    counts = Counter(item.severity for item in findings)
    return {
        "path": str(path),
        "profile": profile,
        "baseline_style": baseline,
        "sections": sections,
        "paragraphs": paragraph_stats,
        "tables": table_stats,
        "metadata_fields": sorted(metadata),
        "findings": [asdict(item) for item in findings],
        "summary": {
            "errors": counts["error"],
            "warnings": counts["warning"],
            "info": counts["info"],
        },
    }


def print_human(report: dict[str, object]) -> None:
    summary = report["summary"]
    print(f"File: {report['path']}")
    print(f"Profile: {report['profile']}")
    print(
        "Summary: "
        f"{summary['errors']} error(s), "
        f"{summary['warnings']} warning(s), "
        f"{summary['info']} info"
    )
    for finding in report["findings"]:
        location = f" [{finding['location']}]" if finding["location"] else ""
        print(f"- {finding['severity'].upper()} {finding['code']}{location}: {finding['message']}")


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path, help="DOCX file to audit")
    parser.add_argument(
        "--profile",
        choices=sorted(PROFILE_RULES),
        default="generic",
        help="Formatting profile",
    )
    parser.add_argument("--json", action="store_true", help="Print JSON")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return exit code 1 when warnings exist",
    )
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    if args.docx.suffix.lower() != ".docx":
        print("error: audit input must be a .docx file", file=sys.stderr)
        return 2
    if not args.docx.is_file():
        print(f"error: file not found: {args.docx}", file=sys.stderr)
        return 2

    report = audit_package(args.docx.resolve(), args.profile)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)

    summary = report["summary"]
    if summary["errors"]:
        return 2
    if args.strict and summary["warnings"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
