#!/usr/bin/env python3
"""Run pinned Python lint, type, and dead-code gates for page processing."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PAGE_PROCESSOR_ROOT = PROJECT_ROOT / "python" / "page-processor"
LOCK_PATH = PAGE_PROCESSOR_ROOT / "requirements-quality-lock.txt"
VENV_DIR = PROJECT_ROOT / ".devkit" / "python-page-processor-quality"
BOOTSTRAPPED_ENV = "EVB_PAGE_PROCESSOR_QUALITY_BOOTSTRAPPED"
SOURCES = [
    "python/page-processor",
    "scripts/check-page-processor-smoke.py",
    "scripts/check-page-processor-quality.py",
    "scripts/devkit/ocr-profile-benchmark.py",
    "scripts/devkit/page-processing-harness.py",
    "scripts/devkit/process-pdf-split-pad.py",
]


def venv_python() -> Path:
    return VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def has_tools() -> bool:
    return all(find_spec(module) is not None for module in ("mypy", "ruff", "vulture"))


def bootstrap() -> None:
    python_path = venv_python()
    if not python_path.exists():
        subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)], check=True)
    subprocess.run([
        str(python_path),
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--require-hashes",
        "--only-binary=:all:",
        "-r",
        str(LOCK_PATH),
    ], check=True)
    subprocess.run([str(python_path), "-m", "pip", "check"], check=True)
    result = subprocess.run(
        [str(python_path), str(Path(__file__).resolve())],
        cwd=PROJECT_ROOT,
        env={**os.environ, BOOTSTRAPPED_ENV: "1"},
        check=False,
    )
    raise SystemExit(result.returncode)


def tool_executable(name: str) -> str:
    scripts_dir = Path(sys.executable).parent
    suffix = ".exe" if os.name == "nt" else ""
    candidate = scripts_dir / f"{name}{suffix}"
    if candidate.exists():
        return str(candidate)
    found = shutil.which(name)
    if found:
        return found
    raise RuntimeError(f"Pinned Python quality tool is not executable: {name}")


def main() -> int:
    # Always enter the dedicated hash-locked environment. Merely finding tools
    # in a developer's ambient Python would make this gate depend on unpinned
    # local versions and silently diverge from CI.
    if os.environ.get(BOOTSTRAPPED_ENV) != "1":
        bootstrap()
    if not has_tools():
        raise RuntimeError(f"Python quality tools are unavailable after installing {LOCK_PATH}")

    subprocess.run([
        tool_executable("ruff"),
        "check",
        "--select",
        "E9,F,I",
        *SOURCES,
    ], cwd=PROJECT_ROOT, check=True)
    subprocess.run([
        tool_executable("mypy"),
        "--ignore-missing-imports",
        "--follow-imports=skip",
        "--check-untyped-defs",
        "--no-error-summary",
        *SOURCES,
    ], cwd=PROJECT_ROOT, env={**os.environ, "MYPYPATH": str(PAGE_PROCESSOR_ROOT)}, check=True)
    subprocess.run([
        tool_executable("vulture"),
        *SOURCES,
        "--min-confidence",
        "90",
    ], cwd=PROJECT_ROOT, check=True)
    print("Page processor Python lint/type/dead-code checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
