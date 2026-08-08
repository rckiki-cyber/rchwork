#!/usr/bin/env python3
"""Convert legacy .doc/.ppt files locally before considering Office MCP.

Uses LibreOffice/soffice headless when available. Conversion happens in a
private temporary directory so a stale output file can never be mistaken for a
successful conversion. Only exhausted local conversion may enable fallback.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

MARKER = "LEGALWORK_DOCUMENT_UNSUPPORTED"


def emit(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(code)


def candidates() -> list[str]:
    raw = [
        os.environ.get("LEGALWORK_SOFFICE"),
        shutil.which("soffice"),
        shutil.which("libreoffice"),
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ]
    seen: set[str] = set()
    out: list[str] = []
    for value in raw:
        if not value:
            continue
        path = str(value).strip()
        if not path or path in seen:
            continue
        seen.add(path)
        if Path(path).is_file() or shutil.which(path):
            out.append(path)
    return out


def cmd_convert(args: argparse.Namespace) -> None:
    src = Path(args.input).expanduser().resolve()
    if not src.is_file():
        emit({"status": "error", "operation": "legacy-convert", "error": f"file not found: {src}"}, 1)
    ext = src.suffix.lower()
    if ext not in {".doc", ".ppt"}:
        emit({"status": "error", "operation": "legacy-convert", "error": f"expected .doc or .ppt input, got {ext or 'no extension'}"}, 1)
    target_ext = ".docx" if ext == ".doc" else ".pptx"
    output = Path(args.output).expanduser().resolve() if args.output else src.with_suffix(target_ext)
    if output.suffix.lower() != target_ext:
        emit({"status": "error", "operation": "legacy-convert", "error": f"output must end with {target_ext}"}, 1)
    output.parent.mkdir(parents=True, exist_ok=True)

    office = candidates()
    if not office:
        emit({
            "status": "unsupported",
            "marker": MARKER,
            "operation": "legacy-convert",
            "reason": "legacy Office format requires local conversion but no LibreOffice/soffice executable is available",
            "detail": {"legacy_format": ext, "local_conversion_attempted": True, "converter_found": False},
        })

    last_error = ""
    for executable in office:
        try:
            with tempfile.TemporaryDirectory(prefix="legalwork-office-convert-") as temp_dir:
                temp = Path(temp_dir)
                completed = subprocess.run(
                    [executable, "--headless", "--convert-to", target_ext.lstrip("."), "--outdir", str(temp), str(src)],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    check=False,
                )
                generated = temp / f"{src.stem}{target_ext}"
                if completed.returncode == 0 and generated.is_file() and generated.stat().st_size > 0:
                    staged = output.with_name(f".{output.name}.legalwork-converting")
                    if staged.exists():
                        staged.unlink()
                    shutil.copy2(generated, staged)
                    staged.replace(output)
                    emit({
                        "status": "ok",
                        "operation": "legacy-convert",
                        "input": str(src),
                        "output": str(output),
                        "converter": Path(executable).name,
                    })
                last_error = (completed.stderr or completed.stdout or f"exit code {completed.returncode}")[-1600:]
        except Exception as exc:
            last_error = str(exc)
            continue

    emit({
        "status": "unsupported",
        "marker": MARKER,
        "operation": "legacy-convert",
        "reason": "all available local LibreOffice/soffice conversion attempts failed",
        "detail": {
            "legacy_format": ext,
            "local_conversion_attempted": True,
            "converter_found": True,
            "converter_count": len(office),
            "last_error": last_error,
        },
    })


def main() -> None:
    parser = argparse.ArgumentParser(description="LegalWork legacy Office converter")
    sub = parser.add_subparsers(dest="command", required=True)
    convert = sub.add_parser("convert")
    convert.add_argument("--input", required=True)
    convert.add_argument("--output")
    convert.set_defaults(func=cmd_convert)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
