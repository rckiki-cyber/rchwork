#!/usr/bin/env python3
"""Unified open-kimi-ppt validation and deterministic local export entrypoint.

This runner keeps Kimi-derived scenario style selection, PPTD structural
validation, and local PPTX delivery inside one Skill-owned program.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Sequence

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from export_pptx import ExportError, find_manifest, read_yaml_mapping
from local_export_pptx import export_local_pptx


SCENARIO_GUIDES = {
    "analysis-decision": "analysis-decision.md",
    "business-plan": "business-plan.md",
    "management-report": "management-report.md",
    "academic-research": "academic-research.md",
    "education-training": "education-training.md",
    "tech-engineering": "tech-engineering.md",
    "brand-creative": "brand-creative.md",
}
PLACEHOLDER_RE = re.compile(
    r"(?:\[cache hygiene|history-only compression|omitted|placeholder|lorem ipsum|待补充|此处省略)",
    re.IGNORECASE,
)


def fail(message: str) -> None:
    print(json.dumps({
        "status": "error",
        "engine": "open-kimi-ppt",
        "error": message,
    }, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_mapping(value: Any, label: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ExportError(f"{label} must be a mapping")
    return value


def require_nonempty_mapping(value: Any, label: str, minimum: int = 1) -> Dict[str, Any]:
    result = require_mapping(value, label)
    if len(result) < minimum:
        raise ExportError(f"{label} must contain at least {minimum} entries")
    return result


def validate_bounds(bounds: Any, size: Sequence[float], label: str) -> None:
    if not isinstance(bounds, list) or len(bounds) != 4:
        raise ExportError(f"{label}.bounds must contain [x, y, width, height]")
    if not all(isinstance(value, (int, float)) for value in bounds):
        raise ExportError(f"{label}.bounds must contain numbers")
    x, y, width, height = bounds
    if width <= 0 or height <= 0:
        raise ExportError(f"{label}.bounds width and height must be positive")
    if x < 0 or y < 0 or x + width > size[0] or y + height > size[1]:
        raise ExportError(f"{label}.bounds exceed the slide canvas")


def iter_page_data(manifest: Path, manifest_data: Dict[str, Any]) -> Iterable[tuple[str, Dict[str, Any], str]]:
    page_paths = manifest_data.get("pages")
    if not isinstance(page_paths, list) or not page_paths:
        raise ExportError("PPTD manifest must contain a non-empty pages list")
    root = manifest.parent.resolve()
    for entry in page_paths:
        if not isinstance(entry, str) or not entry.strip():
            raise ExportError("every PPTD page path must be a non-empty string")
        page = (root / entry).resolve()
        try:
            page.relative_to(root)
        except ValueError as exc:
            raise ExportError(f"page path escapes the PPTD project: {entry}") from exc
        if not page.is_file():
            raise ExportError(f"missing page file: {entry}")
        text, data = read_yaml_mapping(page)
        yield entry, data, text


def validate_style(manifest: Path, scenario: str) -> Dict[str, Any]:
    skill_root = Path(__file__).resolve().parents[1]
    categories = skill_root / "reference" / "slides_categories.md"
    scenario_guide = skill_root / "reference" / "slides_categories" / SCENARIO_GUIDES[scenario]
    pptd_guide = skill_root / "reference" / "pptd.md"
    for guide in (pptd_guide, categories, scenario_guide):
        if not guide.is_file() or guide.stat().st_size == 0:
            raise ExportError(f"required open-kimi-ppt guide is missing: {guide}")

    _manifest_text, data = read_yaml_mapping(manifest)
    if data.get("version") != "v2":
        raise ExportError("unified open-kimi-ppt workflow requires PPTD version v2")
    size = data.get("size")
    if (
        not isinstance(size, list) or len(size) != 2 or
        not all(isinstance(value, (int, float)) and value > 0 for value in size)
    ):
        raise ExportError("PPTD size must contain two positive numbers")

    theme = require_mapping(data.get("theme"), "theme")
    colors = require_nonempty_mapping(theme.get("colors"), "theme.colors", 3)
    text_styles = require_nonempty_mapping(theme.get("textStyles"), "theme.textStyles", 2)

    page_types = set()
    element_count = 0
    text_element_count = 0
    for page_name, page, page_text in iter_page_data(manifest, data):
        if PLACEHOLDER_RE.search(page_text):
            raise ExportError(f"placeholder text is forbidden in {page_name}")
        page_type = page.get("pageType")
        if isinstance(page_type, str) and page_type.strip():
            page_types.add(page_type.strip())
        elements = page.get("elements")
        if not isinstance(elements, list):
            raise ExportError(f"page elements must be an array: {page_name}")
        seen_ids = set()
        for index, element in enumerate(elements):
            record = require_mapping(element, f"{page_name}.elements[{index}]")
            element_id = record.get("elementId")
            if not isinstance(element_id, str) or not element_id.strip():
                raise ExportError(f"{page_name}.elements[{index}] requires elementId")
            if element_id in seen_ids:
                raise ExportError(f"duplicate elementId in {page_name}: {element_id}")
            seen_ids.add(element_id)
            validate_bounds(record.get("bounds"), size, f"{page_name}.{element_id}")
            element_count += 1
            if record.get("elementType") == "text":
                text_element_count += 1

    if element_count == 0 or text_element_count == 0:
        raise ExportError("PPTD project must contain visible elements and text")

    contract = {
        "engine": "open-kimi-ppt",
        "styleValidated": True,
        "scenario": scenario,
        "guides": {
            "pptd": {"path": str(pptd_guide), "sha256": sha256(pptd_guide)},
            "categories": {"path": str(categories), "sha256": sha256(categories)},
            "scenario": {"path": str(scenario_guide), "sha256": sha256(scenario_guide)},
        },
        "theme": {
            "colors": sorted(str(key) for key in colors),
            "textStyles": sorted(str(key) for key in text_styles),
        },
        "pageTypes": sorted(page_types),
        "slides": len(data.get("pages", [])),
        "elements": element_count,
    }
    contract_path = manifest.parent / ".open-kimi-style.json"
    contract_path.write_text(
        json.dumps(contract, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    contract["styleContract"] = str(contract_path)
    return contract


def run_check(source: Path, scenario: str) -> Dict[str, Any]:
    manifest = find_manifest(source)
    contract = validate_style(manifest, scenario)
    return {
        "status": "ok",
        "operation": "check",
        "project": str(manifest.parent),
        "manifest": str(manifest),
        **contract,
    }


def run_export(
    source: Path,
    output: Path,
    scenario: str,
    transition: str,
    force: bool,
) -> Dict[str, Any]:
    checked = run_check(source, scenario)
    manifest = Path(checked["manifest"])
    summary = export_local_pptx(manifest, output, transition, force=force)
    return {
        **checked,
        **summary,
        "status": "ok",
        "operation": "export",
        "engine": "open-kimi-ppt",
        "styleValidated": True,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Unified Kimi-style validation and deterministic local PPTX export runner"
    )
    sub = parser.add_subparsers(dest="operation", required=True)
    for operation in ("check", "export"):
        command = sub.add_parser(operation)
        command.add_argument("input", type=Path, help="PPTD manifest or project directory")
        command.add_argument("--scenario", choices=tuple(SCENARIO_GUIDES), required=True)
        if operation == "export":
            command.add_argument("--output", "-o", type=Path, required=True)
            command.add_argument("--transition", choices=("fade", "none"), default="fade")
            command.add_argument("--force", action="store_true")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.operation == "check":
            result = run_check(args.input, args.scenario)
        else:
            result = run_export(
                args.input,
                args.output,
                args.scenario,
                args.transition,
                args.force,
            )
    except (ExportError, OSError, ValueError) as exc:
        fail(str(exc))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
