#!/usr/bin/env python3
"""Managed launcher for LegalWork Office document workers.

Packaged LegalWork discovers the bundled Office Python runtime next to the
packaged skills directory. End users never create a venv or run pip for
Word/Excel/PPT tasks. A managed venv remains available only in development.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path, PureWindowsPath
from typing import Iterable

RUNTIME_VERSION = "v5"
REQUIRED_IMPORTS = ("docx", "pptx", "openpyxl", "lxml", "PIL", "reportlab")
MAX_ERROR_CHARS = 2400


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(code)


def platform_python(venv_root: Path) -> Path:
    if os.name == "nt":
        return venv_root / "Scripts" / "python.exe"
    return venv_root / "bin" / "python"


def office_runtime_python(runtime_root: Path) -> Path:
    if os.name == "nt":
        return runtime_root / "python" / "python.exe"
    return runtime_root / "python" / "bin" / "python3"


def runtime_root() -> Path:
    explicit = os.environ.get("LEGALWORK_DOCUMENT_SKILL_VENV", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return (Path.home() / ".legalwork" / "runtimes" / "office-skills" / "python-venv").resolve()


def package_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resources_root() -> Path:
    # packaged: <Resources>/skills/legal_document_formatting
    # development: <repo>/skills/legal_document_formatting
    return package_root().parent.parent


def packaged_install() -> bool:
    root = resources_root()
    return (root / "app.asar").is_file() or (root / "app.asar.unpacked").is_dir()


def requirements_path() -> Path:
    return package_root() / "requirements.txt"


def marker_path(venv_root: Path) -> Path:
    return venv_root / f".legalwork-document-skill-{RUNTIME_VERSION}"


def bundled_office_python_home(command: str, platform_name: str | None = None) -> str:
    """Return the relocatable runtime root for a bundled interpreter.

    The packaged layouts differ intentionally: Windows places python.exe at
    ``python/python.exe`` while Unix places it at ``python/bin/python3``.
    Walking two parents works only for the Unix layout.
    """
    if (platform_name or os.name) == "nt":
        return str(PureWindowsPath(command).parent)
    return str(Path(command).resolve().parent.parent)


def bundled_office_python_env(command: str, platform_name: str | None = None) -> dict:
    """python-build-standalone hard-codes sys.prefix at build time and is not
    relocatable by default: once the tree is packaged under office-runtime/,
    the python still looks for its stdlib/site-packages under the build-time
    temp path unless PYTHONHOME re-anchors it. Without this, `import docx`
    fails on end-user machines and reports "incomplete or incompatible".
    """
    env = dict(os.environ)
    env["PYTHONHOME"] = bundled_office_python_home(command, platform_name)
    return env


def is_bundled_office_python(command: str) -> bool:
    explicit = os.environ.get("LEGALWORK_OFFICE_PYTHON", "").strip()
    candidates = [office_runtime_python(resources_root() / "office-runtime")]
    if explicit:
        candidates.append(Path(explicit).expanduser())
    normalized = os.path.normcase(os.path.realpath(command))
    return any(normalized == os.path.normcase(os.path.realpath(str(candidate))) for candidate in candidates)


def python_version_ok(command: str, env: dict | None = None) -> bool:
    try:
        completed = subprocess.run(
            [command, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
            env=env,
        )
        if completed.returncode != 0:
            return False
        major, minor = (int(part) for part in completed.stdout.strip().split(".")[:2])
        return major == 3 and minor >= 10
    except Exception:
        return False


def imports_ok(command: str, env: dict | None = None) -> bool:
    code = "\n".join(f"import {name}" for name in REQUIRED_IMPORTS)
    try:
        completed = subprocess.run(
            [command, "-c", code],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
            env=env,
        )
        return completed.returncode == 0
    except Exception:
        return False


def bundled_office_python() -> str | None:
    explicit = os.environ.get("LEGALWORK_OFFICE_PYTHON", "").strip()
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser().resolve())
    candidates.append(office_runtime_python(resources_root() / "office-runtime"))

    for path in candidates:
        if not path.is_file():
            continue
        command = str(path)
        env = bundled_office_python_env(command)
        if python_version_ok(command, env) and imports_ok(command, env):
            return command
        emit({
            "status": "error",
            "stage": "runtime",
            "error": f"Bundled Office Python is incomplete or incompatible: {path}. Reinstall LegalWork.",
            "office_fallback_allowed": False,
        }, 1)

    if packaged_install():
        expected = office_runtime_python(resources_root() / "office-runtime")
        emit({
            "status": "error",
            "stage": "runtime",
            "error": f"Bundled Office Python is missing: {expected}. Reinstall LegalWork. Runtime setup on end-user machines is disabled.",
            "office_fallback_allowed": False,
        }, 1)
    return None


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
    bundled = bundled_office_python()
    if bundled:
        return bundled
    for candidate in candidate_bootstrap_pythons():
        if python_version_ok(candidate):
            return candidate
    emit({
        "status": "error",
        "stage": "runtime",
        "error": "No compatible Python 3.10+ interpreter is available for the development document Skill runtime.",
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
    bundled = bundled_office_python()
    if bundled:
        return bundled

    # Development-only fallback. packaged_install() is already rejected by
    # bundled_office_python(), so end-user machines never reach venv/pip setup.
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
            "error": f"Document Skill requirements are missing: {requirements}",
            "office_fallback_allowed": False,
        }, 1)

    bootstrap = choose_bootstrap_python()
    root.parent.mkdir(parents=True, exist_ok=True)
    if python.exists() and not python_version_ok(str(python)):
        shutil.rmtree(root, ignore_errors=True)

    if not python.is_file():
        code, output = run_quiet(
            [bootstrap, "-m", "venv", "--system-site-packages", str(root)],
            package_root(),
            90,
        )
        if code != 0 or not python.is_file():
            emit({
                "status": "error",
                "stage": "runtime",
                "error": f"Failed to create development document-skill venv: {output}",
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
                "error": f"Failed to prepare development document-skill dependencies: {output}",
                "office_fallback_allowed": False,
            }, 1)

    marker.write_text(RUNTIME_VERSION, encoding="utf-8")
    return str(python)


def worker_path(kind: str) -> Path:
    filenames = {
        "docx": "docx_worker.py",
        "pdf": "pdf_worker.py",
        "xlsx": "xlsx_worker.py",
        "pptx": "pptx_worker.py",
        "reference": "reference_profile_worker.py",
        "profile": "legal_profile_worker.py",
        "legacy": "legacy_office_worker.py",
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
    python = choose_bootstrap_python() if kind == "legacy" else ensure_runtime()
    worker = worker_path(kind)
    env = bundled_office_python_env(python) if is_bundled_office_python(python) else None
    try:
        completed = subprocess.run(
            [python, str(worker), *worker_args],
            cwd=str(package_root()),
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
            env=env,
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
    parser.add_argument("kind", choices=("docx", "pdf", "xlsx", "pptx", "reference", "profile", "legacy"))
    parser.add_argument("worker_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    dispatch(args.kind, args.worker_args)


if __name__ == "__main__":
    main()
