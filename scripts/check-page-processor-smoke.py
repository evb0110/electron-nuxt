#!/usr/bin/env python3

import json
import os
import shutil
import subprocess
import sys
import tempfile
from importlib.util import find_spec
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PAGE_PROCESSOR_ROOT = PROJECT_ROOT / "python" / "page-processor"
SMOKE_DEPENDENCIES = ("numpy>=2.0.0", "opencv-python-headless>=4.10.0")
SMOKE_BOOTSTRAP_ENV_VAR = "EVB_PAGE_PROCESSOR_SMOKE_BOOTSTRAPPED"
SMOKE_VENV_ROOT = PROJECT_ROOT / ".devkit" / "python-page-processor-smoke"


def has_smoke_dependencies() -> bool:
    return find_spec("cv2") is not None and find_spec("numpy") is not None


def venv_python_path(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def python_version_tag(python_command: str) -> str | None:
    result = subprocess.run(
        [
            python_command,
            "-c",
            "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None

    return result.stdout.strip().replace(".", "")


def candidate_python_commands() -> list[str]:
    commands = []
    current_version = sys.version_info[:2]
    if current_version >= (3, 14):
        commands.extend(["python3.13", "python3.12", "python3.11"])
    commands.append(sys.executable)
    commands.extend(["python3.13", "python3.12", "python3.11", "python3"])

    resolved_commands = []
    seen_paths = set()
    for command in commands:
        resolved = shutil.which(command) if command != sys.executable else command
        if resolved is None:
            continue
        resolved_path = str(Path(resolved).resolve())
        if resolved_path in seen_paths:
            continue
        seen_paths.add(resolved_path)
        resolved_commands.append(resolved_path)

    return resolved_commands


def create_smoke_venv_python() -> Path:
    failures = []
    for python_command in candidate_python_commands():
        version_tag = python_version_tag(python_command)
        if version_tag is None:
            continue

        venv_dir = SMOKE_VENV_ROOT / f"py{version_tag}"
        python_path = venv_python_path(venv_dir)
        try:
            if not python_path.exists():
                subprocess.run([python_command, "-m", "venv", str(venv_dir)], check=True)
            subprocess.run(
                [
                    str(python_path),
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    *SMOKE_DEPENDENCIES,
                ],
                check=True,
            )
            subprocess.run(
                [
                    str(python_path),
                    "-c",
                    "import cv2; import numpy",
                ],
                check=True,
            )
            return python_path
        except subprocess.CalledProcessError as error:
            failures.append(f"{python_command}: exited with {error.returncode}")

    raise RuntimeError(
        "Unable to prepare page processor smoke dependencies in .devkit. "
        f"Tried: {', '.join(failures) or 'no usable Python interpreters found'}"
    )


def ensure_smoke_dependencies() -> None:
    if has_smoke_dependencies():
        return

    if os.environ.get(SMOKE_BOOTSTRAP_ENV_VAR) == "1":
        raise RuntimeError(
            "Page processor smoke dependencies are unavailable after bootstrap. "
            f"Expected {', '.join(SMOKE_DEPENDENCIES)}."
        )

    python_path = create_smoke_venv_python()
    env = {
        **os.environ,
        SMOKE_BOOTSTRAP_ENV_VAR: "1",
    }
    result = subprocess.run([str(python_path), str(Path(__file__).resolve()), *sys.argv[1:]], env=env)
    raise SystemExit(result.returncode)


def compile_sources() -> None:
    for source_path in sorted(PAGE_PROCESSOR_ROOT.rglob("*.py")):
        source = source_path.read_text(encoding="utf-8")
        compile(source, str(source_path.relative_to(PROJECT_ROOT)), "exec")


def run_lightweight_cli() -> None:
    env = {
        **os.environ,
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    result = subprocess.run(
        [
            sys.executable,
            str(PAGE_PROCESSOR_ROOT / "main.py"),
            "list-stages",
        ],
        cwd=PAGE_PROCESSOR_ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    if payload.get("type") != "result" or payload.get("stages") != [
        "rotation",
        "split",
        "deskew",
        "dewarp",
    ]:
        raise AssertionError(f"Unexpected page-processor list-stages output: {result.stdout}")


def run_generated_scan_pipeline() -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "Page processor smoke requires core runtime dependencies. "
            "Install python/page-processor/requirements.txt or at least numpy and opencv-python-headless."
        ) from error

    with tempfile.TemporaryDirectory(prefix="evb-page-processor-smoke-") as temp_dir:
        temp_root = Path(temp_dir)
        input_path = temp_root / "one-page-scan.png"
        output_dir = temp_root / "out"
        output_dir.mkdir()

        image = np.full((220, 160, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (42, 48), (122, 172), (0, 0, 0), 2)
        cv2.line(image, (54, 76), (110, 76), (0, 0, 0), 2)
        cv2.line(image, (54, 100), (112, 100), (0, 0, 0), 2)
        cv2.line(image, (54, 124), (104, 124), (0, 0, 0), 2)
        if not cv2.imwrite(str(input_path), image, [cv2.IMWRITE_PNG_COMPRESSION, 0]):
            raise AssertionError("Failed to write generated scan fixture")

        env = {
            **os.environ,
            "PYTHONDONTWRITEBYTECODE": "1",
            "PAGE_PROCESSOR_PNG_COMPRESSION": "0",
        }
        result = subprocess.run(
            [
                sys.executable,
                str(PAGE_PROCESSOR_ROOT / "main.py"),
                "process",
                str(input_path),
                str(output_dir),
                "--operations",
                "crop",
                "deskew",
                "--no-auto-detect",
                "--min-skew-angle",
                "90",
                "--crop-padding",
                "6",
            ],
            cwd=PAGE_PROCESSOR_ROOT,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )

        json_lines = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        final_payloads = [payload for payload in json_lines if payload.get("type") == "result"]
        if len(final_payloads) != 1:
            raise AssertionError(f"Expected one result payload, got: {result.stdout}")

        payload = final_payloads[0]
        if not payload.get("success"):
            raise AssertionError(f"Generated scan pipeline did not report success: {payload}")
        if payload.get("operations_applied") != ["crop"]:
            raise AssertionError(f"Expected only crop to apply deterministically: {payload}")
        if payload.get("original_size") != {"width": 160, "height": 220}:
            raise AssertionError(f"Unexpected original size: {payload}")

        output_paths = payload.get("output_paths")
        output_sizes = payload.get("output_sizes")
        if not isinstance(output_paths, list) or len(output_paths) != 1:
            raise AssertionError(f"Expected exactly one output image: {payload}")
        if not isinstance(output_sizes, list) or len(output_sizes) != 1:
            raise AssertionError(f"Expected exactly one output size: {payload}")

        output_size = output_sizes[0]
        if output_size.get("width") >= 160 or output_size.get("height") >= 220:
            raise AssertionError(f"Expected generated scan to be cropped smaller: {payload}")

        output_image = cv2.imread(output_paths[0])
        if output_image is None:
            raise AssertionError(f"Failed to read generated pipeline output: {output_paths[0]}")
        if output_image.shape[1] != output_size["width"] or output_image.shape[0] != output_size["height"]:
            raise AssertionError(f"Output metadata does not match image dimensions: {payload}")

        dark_pixels = int(np.count_nonzero(np.any(output_image < 80, axis=2)))
        if dark_pixels < 100:
            raise AssertionError("Generated pipeline output lost the scan content")


def main() -> None:
    ensure_smoke_dependencies()
    compile_sources()
    run_lightweight_cli()
    run_generated_scan_pipeline()
    print("Page processor smoke check passed.")


if __name__ == "__main__":
    main()
