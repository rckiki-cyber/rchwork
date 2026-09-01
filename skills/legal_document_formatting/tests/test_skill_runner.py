"""Tests for skill_runner's bundled Office Python relocation handling."""
from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def _load_runner() -> object:
    spec = importlib.util.spec_from_file_location(
        "skill_runner_under_test",
        Path(__file__).resolve().parents[1] / "scripts" / "skill_runner.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BundledOfficePythonRelocationTest(unittest.TestCase):
    def test_env_reanchors_pythonhome_to_python_dir(self) -> None:
        module = _load_runner()
        # 模拟打包后的路径：office-runtime/python/bin/python3（mac）
        mac = str(Path("/fake/app/resources/office-runtime/python/bin/python3"))
        env = module.bundled_office_python_env(mac)
        self.assertEqual(
            env["PYTHONHOME"],
            "/fake/app/resources/office-runtime/python",
        )

    def test_windows_env_reanchors_pythonhome_to_python_dir(self) -> None:
        module = _load_runner()
        windows = r"C:\Program Files\legalwork\resources\office-runtime\python\python.exe"
        env = module.bundled_office_python_env(windows, platform_name="nt")
        self.assertEqual(
            env["PYTHONHOME"],
            r"C:\Program Files\legalwork\resources\office-runtime\python",
        )

    def test_dispatch_preserves_pythonhome_for_bundled_worker(self) -> None:
        module = _load_runner()
        bundled = "/fake/resources/office-runtime/python/bin/python3"
        completed = SimpleNamespace(
            returncode=0,
            stdout='{"status":"ok"}\n',
            stderr="",
        )
        with (
            patch.object(module, "ensure_runtime", return_value=bundled),
            patch.object(module, "worker_path", return_value=Path("/fake/worker.py")),
            patch.object(module, "is_bundled_office_python", return_value=True),
            patch.object(module.subprocess, "run", return_value=completed) as run,
            patch("builtins.print"),
        ):
            with self.assertRaisesRegex(SystemExit, "0"):
                module.dispatch("docx", [])

        self.assertEqual(
            run.call_args.kwargs["env"]["PYTHONHOME"],
            "/fake/resources/office-runtime/python",
        )

    def test_real_bundled_python_imports_with_env(self) -> None:
        # 用本地 vendored mac runtime 做真实 import 验证（绕过硬编码前缀漂移）。
        # tests/ -> legal_document_formatting/tests -> skills -> repo
        repo = Path(__file__).resolve().parents[3]
        mac_py = repo / "apps" / "desktop-legalwork" / "vendor" / "office-runtime" / "mac-arm64" / "python" / "bin" / "python3"
        if not mac_py.is_file():
            self.skipTest("vendored mac office runtime not present")
        module = _load_runner()
        env = module.bundled_office_python_env(str(mac_py))
        self.assertTrue(module.python_version_ok(str(mac_py), env))
        self.assertTrue(module.imports_ok(str(mac_py), env))
        # PYTHONHOME 指向错误路径时必须失败——证明重锚定是必要的
        self.assertFalse(module.imports_ok(str(mac_py), {**os.environ, "PYTHONHOME": "/tmp/nonexistent"}))


if __name__ == "__main__":
    unittest.main()
