#!/usr/bin/env python3
"""Managed Python launcher for LegalWork's document-formatting skill.

This script is stdlib-only. It owns a small venv under ~/.legalwork/runtimes,
installs the skill's pinned dependencies once, then dispatches to the DOCX,
PPTX, or reference-profile worker. All setup noise stays local; stdout is
reserved for one compact worker JSON result so model context does not grow
with pip/venv logs.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterable

RUNTIME_VERSION = "v1"
REQUIRED_IMPORTS = ("docx", "pptx", "openpyxl", "lxml", "PIL")
MAX_ERROR_CHARS = 2400


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(code)


def platform_python(venv_root: Path) -> Path:
    if os.name == "nt":
        return venv_root / "Scripts" / "python.exe"
    return venv_root / "bin" / "python"


def runtime_root() -> Path:
    explicit = os.environ.get("LEGALWORK_DOCUMENT_SKILL_VENV", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return (Path.home() / ".legalwork" / "runtimes" / "office-skills" / "python-venv").resolve()


def package_root() -> Path:
    return Path(__file__).resolve().parent.parent


def requirements_path() -> Path:
    return package_root() / "requirements.txt"


def marker_path(venv_root: Path) -> Path:
    return venv_root / f".legalwork-document-skill-{RUNTIME_VERSION}"


def python_version_ok(command: str) -> bool:
    try:
        completed = subprocess.run(
            [command, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        if completed.returncode != 0:
            return False
        major, minor = (int(part) for part in completed.stdout.strip().split(".")[:2])
        return major == 3 and 10 <= minor <= 13
    except Exception:
        return False


def imports_ok(command: str) -> bool:
    code = "\n".join(f"import {name}" for name in REQUIRED_IMPORTS)
    try:
        completed = subprocess.run(
            [command, "-c", code],
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
        )
        return completed.returncode == 0
    except Exception:
        return False


def candidate_bootstrap_pythons() -> Iterable[str]:
    seen: set[str] = set()
    raw = [
        os.environ.get("LEGALWORK_SKILL_PYTHON"),
        os.environ.get("LEGALWORK_PYTHON"),
        os.environ.get("LEGALWORK_OCR_PYTHON"),
        sys.executable,
        shutil.which("python3"),
        shutil.which("python"),
    ]
    for candidate in raw:
        value = (candidate or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        yield value


def choose_bootstrap_python() -> str:
    for candidate in candidate_bootstrap_pythons():
        if python_version_ok(candidate):
            return candidate
    emit({
        "status": "error",
        "stage": "runtime",
        "error": "No compatible Python 3.10-3.13 interpreter is available for the LegalWork document skill runtime.",
        "office_fallback_allowed": False,
    }, 1)
    raise AssertionError("unreachable")


def run_quiet(command: list[str], cwd: Path, timeout: int) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return 124, f"command timed out after {timeout}s: {exc}"
    except Exception as exc:
        return 1, str(exc)
    output = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
    return completed.returncode, output[-MAX_ERROR_CHARS:]


def ensure_runtime() -> str:
    root = runtime_root()
    python = platform_python(root)
    marker = marker_path(root)

    if python.is_file() and python_version_ok(str(python)) and marker.is_file() and imports_ok(str(python)):
        return str(python)

    requirements = requirements_path()
    if not requirements.is_file():
        emit({
            "status": "error",
            "stage": "runtime",
            "error": f"Document skill requirements are missing: {requirements}",
            "office_fallback_allowed": False,
        }, 1)

    bootstrap = choose_bootstrap_python()
    root.parent.mkdir(parents=True, exist_ok=True)
    if python.exists() and not python_version_ok(str(python)):
        shutil.rmtree(root, ignore_errors=True)

    if not python.is_file():
        code, output = run_quiet([bootstrap, "-m", "venv", str(root)], package_root(), 90)
        if code != 0 or not python.is_file():
            emit({
                "status": "error",
                "stage": "runtime",
                "error": f"Failed to create managed document-skill venv: {output}",
                "office_fallback_allowed": False,
            }, 1)

    if not imports_ok(str(python)):
        code, output = run_quiet(
            [str(python), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(requirements)],
            package_root(),
            300,
        )
        if code != 0 or not imports_ok(str(python)):
            marker.unlink(missing_ok=True)
            emit({
                "status": "error",
                "stage": "runtime",
                "error": f"Failed to install document-skill dependencies: {output}",
                "office_fallback_allowed": False,
            }, 1)

    marker.write_text(RUNTIME_VERSION, encoding="utf-8")
    return str(python)


def worker_path(kind: str) -> Path:
    filenames = {
        "docx": "docx_worker.py",
        "pptx": "pptx_worker.py",
        "reference": "reference_profile_worker.py",
    }
    path = Path(__file__).resolve().parent / filenames[kind]
    if not path.is_file():
        emit({
            "status": "error",
            "stage": "dispatch",
            "error": f"Document worker is missing: {path}",
            "office_fallback_allowed": False,
        }, 1)
    return path


def dispatch(kind: str, worker_args: list[str]) -> None:
    python = ensure_runtime()
    worker = worker_path(kind)
    try:
        completed = subprocess.run(
            [python, str(worker), *worker_args],
            cwd=str(package_root()),
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
    except subprocess.TimeoutExpired:
        emit({
            "status": "error",
            "stage": "dispatch",
            "error": "Document worker timed out after 300 seconds.",
            "office_fallback_allowed": False,
        }, 1)
    except Exception as exc:
        emit({
            "status": "error",
            "stage": "dispatch",
            "error": str(exc),
            "office_fallback_allowed": False,
        }, 1)

    stdout = completed.stdout.strip()
    if stdout:
        # Workers are contractually limited to one compact JSON object. If a
        # library unexpectedly prints noise, keep only the final non-empty line.
        lines = [line.strip() for line in stdout.splitlines() if line.strip()]
        print(lines[-1])
        raise SystemExit(completed.returncode)

    detail = (completed.stderr or "document worker returned no output")[-MAX_ERROR_CHARS:]
    emit({
        "status": "error",
        "stage": "dispatch",
        "error": detail,
        "office_fallback_allowed": False,
    }, completed.returncode or 1)


def main() -> None:
    parser = argparse.ArgumentParser(description="LegalWork managed document-skill launcher")
    parser.add_argument("kind", choices=("docx", "pptx", "reference"))
    parser.add_argument("worker_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    dispatch(args.kind, args.worker_args)


if __name__ == "__main__":
    main()
