#!/usr/bin/env python3

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from contextlib import redirect_stdout
from importlib.util import find_spec, module_from_spec, spec_from_file_location
from io import StringIO
from pathlib import Path

sys.dont_write_bytecode = True

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PAGE_PROCESSOR_ROOT = PROJECT_ROOT / "python" / "page-processor"
LOCK_PATH = PAGE_PROCESSOR_ROOT / "requirements-lock.txt"
SMOKE_BOOTSTRAP_ENV_VAR = "EVB_PAGE_PROCESSOR_SMOKE_BOOTSTRAPPED"
SMOKE_VENV_ROOT = PROJECT_ROOT / ".devkit" / "python-page-processor-smoke"


def has_smoke_dependencies() -> bool:
    return all(
        find_spec(module_name) is not None
        for module_name in ("cv2", "numpy", "img2pdf", "PIL", "page_dewarp")
    )


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
                    "--require-hashes",
                    "--only-binary=:all:",
                    "-r",
                    str(LOCK_PATH),
                ],
                check=True,
            )
            subprocess.run(
                [
                    str(python_path),
                    "-c",
                    "import cv2; import img2pdf; import numpy; import page_dewarp; from PIL import Image",
                ],
                check=True,
            )
            subprocess.run([str(python_path), "-m", "pip", "check"], check=True)
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
            f"Expected the complete hashed lock at {LOCK_PATH}."
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


def run_python_quality_gates() -> None:
    subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "scripts" / "check-page-processor-quality.py")],
        cwd=PROJECT_ROOT,
        check=True,
    )


def load_page_processor_main():
    spec = spec_from_file_location("page_processor_main_smoke", PAGE_PROCESSOR_ROOT / "main.py")
    if spec is None or spec.loader is None:
        raise AssertionError("Failed to load page processor main module spec")

    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_ocr_benchmark():
    module_name = "ocr_profile_benchmark_smoke"
    spec = spec_from_file_location(
        module_name,
        PROJECT_ROOT / "scripts" / "devkit" / "ocr-profile-benchmark.py",
    )
    if spec is None or spec.loader is None:
        raise AssertionError("Failed to load OCR benchmark module spec")

    module = module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(module_name, None)
    return module


def run_page_processor(
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(PAGE_PROCESSOR_ROOT / "main.py"),
            *args,
        ],
        cwd=PAGE_PROCESSOR_ROOT,
        env={
            **os.environ,
            "PYTHONDONTWRITEBYTECODE": "1",
            **(env or {}),
        },
        check=check,
        capture_output=True,
        text=True,
    )


def json_lines(stdout: str) -> list[dict]:
    return [json.loads(line) for line in stdout.splitlines() if line.strip()]


def result_payload(stdout: str) -> dict:
    results = [payload for payload in json_lines(stdout) if payload.get("type") == "result"]
    if len(results) != 1:
        raise AssertionError(f"Expected one result payload, got: {stdout}")
    return results[0]


def error_payload(stderr: str) -> dict:
    lines = [line for line in stderr.splitlines() if line.strip()]
    if len(lines) != 1:
        raise AssertionError(f"Expected one error payload, got: {stderr}")
    return json.loads(lines[0])


def assert_pdf_header(path: Path) -> None:
    with path.open("rb") as handle:
        header = handle.read(5)
    if header != b"%PDF-":
        raise AssertionError(f"Expected PDF header for {path}, got {header!r}")


def run_lightweight_cli() -> None:
    version_result = run_page_processor(["--version"])
    if version_result.stdout.strip() != "page-processor 2.0.0":
        raise AssertionError(f"Unexpected page-processor version output: {version_result.stdout}")

    result = run_page_processor(["list-stages"])
    payload = json.loads(result.stdout)
    if payload.get("type") != "result" or payload.get("stages") != [
        "rotation",
        "split",
        "deskew",
        "dewarp",
    ]:
        raise AssertionError(f"Unexpected page-processor list-stages output: {result.stdout}")


def run_main_helper_regressions() -> None:
    import numpy as np  # type: ignore

    module = load_page_processor_main()

    result_stdout = StringIO()
    with redirect_stdout(result_stdout):
        module.send_result({
            "count": np.int64(3),
            "ratio": np.float32(0.25),
            "ok": np.bool_(True),
            "values": np.array([np.int64(1), np.int64(2)]),
        })
    result = json.loads(result_stdout.getvalue())
    if result.get("count") != 3 or result.get("ratio") != 0.25:
        raise AssertionError(f"NumPy scalar result output was not JSON-safe: {result}")
    if result.get("ok") is not True or result.get("values") != [1, 2]:
        raise AssertionError(f"NumPy nested result output was not JSON-safe: {result}")

    progress_stdout = StringIO()
    with redirect_stdout(progress_stdout):
        module.send_progress({"stage": "smoke", "pages": np.uint16(2)})
    progress = json.loads(progress_stdout.getvalue())
    if progress.get("type") != "progress" or progress.get("pages") != 2:
        raise AssertionError(f"NumPy progress output was not JSON-safe: {progress}")

    if module.white_value_for_dtype(np.dtype("uint16")) != 65535:
        raise AssertionError("uint16 padding white value should use full dtype range")
    if module.white_value_for_dtype(np.dtype("float32")) != 1.0:
        raise AssertionError("float padding white value should be normalized white")
    for invalid_angle in (float("nan"), -45.01, 45.01):
        try:
            module.coerce_deskew_angle(invalid_angle)
        except Exception as error:
            if getattr(error, "code", None) != "INVALID_PARAMS":
                raise AssertionError(f"Unexpected deskew angle error for {invalid_angle}: {error}") from error
        else:
            raise AssertionError(f"Deskew angle should reject {invalid_angle}")
    if module.coerce_deskew_angle(45.0) != 45.0 or module.coerce_deskew_angle(-45.0) != -45.0:
        raise AssertionError("Deskew angle should allow boundary values")

    with tempfile.TemporaryDirectory(prefix="evb-page-processor-reencode-paths-") as temp_dir:
        work_dir = Path(temp_dir)
        first = module.reencode_temp_path("/tmp/a/page.png", work_dir, 0, ".jpg")
        second = module.reencode_temp_path("/tmp/b/page.png", work_dir, 1, ".jpg")
        if first == second:
            raise AssertionError("Same-stem reencode temp paths should not collide")
        if first.name != "000000-page.jpg" or second.name != "000001-page.jpg":
            raise AssertionError(f"Unexpected reencode temp path names: {first.name}, {second.name}")


def run_ocr_benchmark_regressions() -> None:
    module = load_ocr_benchmark()
    with tempfile.TemporaryDirectory(prefix="evb-ocr-benchmark-regressions-") as temp_dir:
        temp_root = Path(temp_dir)
        first = temp_root / "a" / "scan.pdf"
        second = temp_root / "b" / "scan.pdf"
        first.parent.mkdir()
        second.parent.mkdir()
        if module.stable_source_key(first) == module.stable_source_key(second):
            raise AssertionError("Same-stem OCR benchmark sources must have distinct artifact keys")
        if module.stable_source_key(first) != module.stable_source_key(first):
            raise AssertionError("OCR benchmark source artifact keys must be deterministic")

        captured: dict[str, object] = {}
        original_run_command = module.run_command

        def fake_run_command(command, *, env=None, timeout=None):
            captured["command"] = command
            captured["timeout"] = timeout
            Path(command[-1]).with_suffix(".png").write_bytes(b"rendered")
            return subprocess.CompletedProcess(command, 0, "", "")

        module.run_command = fake_run_command
        try:
            rendered = module.render_pdf_page(
                Path("/fake/pdftoppm"),
                first,
                7,
                300,
                temp_root / "rendered",
                23,
            )
        finally:
            module.run_command = original_run_command
        if captured.get("timeout") != 23 or not rendered.exists():
            raise AssertionError(f"PDF benchmark rendering did not propagate its timeout: {captured}")


def assert_invalid_params(result: subprocess.CompletedProcess[str], field: str) -> None:
    if result.returncode == 0:
        raise AssertionError(f"Expected INVALID_PARAMS failure for {field}, got success: {result.stdout}")

    payload = error_payload(result.stderr)
    if payload.get("code") != "INVALID_PARAMS":
        raise AssertionError(f"Expected INVALID_PARAMS for {field}, got: {payload}")

    details = payload.get("details")
    if not isinstance(details, dict) or details.get("field") != field:
        raise AssertionError(f"Expected structured INVALID_PARAMS details for {field}, got: {payload}")


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

        result = run_page_processor(
            [
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
            env={"PAGE_PROCESSOR_PNG_COMPRESSION": "0"},
        )

        payload = result_payload(result.stdout)
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


def run_stage_and_padding_cli() -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "Page processor smoke requires core runtime dependencies. "
            "Install python/page-processor/requirements.txt or at least numpy and opencv-python-headless."
        ) from error

    with tempfile.TemporaryDirectory(prefix="evb-page-processor-stage-smoke-") as temp_dir:
        temp_root = Path(temp_dir)
        spread_path = temp_root / "spread.png"
        split_dir = temp_root / "split"
        padded_path = temp_root / "padded.png"

        spread = np.full((140, 260, 3), 255, dtype=np.uint8)
        cv2.rectangle(spread, (18, 24), (108, 116), (0, 0, 0), 2)
        cv2.rectangle(spread, (152, 24), (242, 116), (0, 0, 0), 2)
        cv2.rectangle(spread, (124, 0), (136, 139), (210, 210, 210), -1)
        if not cv2.imwrite(str(spread_path), spread, [cv2.IMWRITE_PNG_COMPRESSION, 0]):
            raise AssertionError("Failed to write generated spread fixture")

        detect_payload = result_payload(run_page_processor([
            "detect",
            "split",
            str(spread_path),
            "--min-confidence",
            "0.0",
        ]).stdout)
        if detect_payload.get("stage") != "split":
            raise AssertionError(f"Unexpected split detect payload: {detect_payload}")
        if detect_payload.get("debug", {}).get("image_size") != {"width": 260, "height": 140}:
            raise AssertionError(f"Split detect did not report fixture dimensions: {detect_payload}")

        split_payload = result_payload(run_page_processor([
            "apply",
            "split",
            str(spread_path),
            str(split_dir),
            "--params",
            json.dumps({"split_type": "vertical", "position": 0.5, "overlap": 4}),
        ]).stdout)
        if not split_payload.get("success") or split_payload.get("page_count") != 2:
            raise AssertionError(f"Split apply did not produce two pages: {split_payload}")

        output_paths = [Path(path) for path in split_payload.get("output_paths", [])]
        output_sizes = split_payload.get("output_sizes")
        if len(output_paths) != 2 or not all(path.exists() for path in output_paths):
            raise AssertionError(f"Split apply outputs are missing: {split_payload}")
        if output_sizes != [{"width": 134, "height": 140}, {"width": 134, "height": 140}]:
            raise AssertionError(f"Unexpected split output sizes: {split_payload}")

        assert_invalid_params(run_page_processor([
            "apply",
            "split",
            str(spread_path),
            str(temp_root / "invalid-position"),
            "--params",
            json.dumps({"split_type": "vertical", "position": 0, "overlap": 0}),
        ], check=False), "position")
        assert_invalid_params(run_page_processor([
            "apply",
            "split",
            str(spread_path),
            str(temp_root / "negative-overlap"),
            "--params",
            json.dumps({"split_type": "vertical", "position": 0.5, "overlap": -1}),
        ], check=False), "overlap")
        assert_invalid_params(run_page_processor([
            "apply",
            "split",
            str(spread_path),
            str(temp_root / "large-overlap"),
            "--params",
            json.dumps({"split_type": "vertical", "position": 0.5, "overlap": 130}),
        ], check=False), "overlap")
        assert_invalid_params(run_page_processor([
            "apply",
            "rotation",
            str(spread_path),
            str(temp_root / "bad-rotation.png"),
            "--params",
            json.dumps({"rotation": 45}),
        ], check=False), "rotation")
        assert_invalid_params(run_page_processor([
            "apply",
            "deskew",
            str(spread_path),
            str(temp_root / "bad-deskew-angle.png"),
            "--params",
            json.dumps({"angle": 90, "background_color": [255, 255, 255]}),
        ], check=False), "angle")
        assert_invalid_params(run_page_processor([
            "apply",
            "deskew",
            str(spread_path),
            str(temp_root / "bad-deskew-nan.png"),
            "--params",
            '{"angle": NaN, "background_color": [255, 255, 255]}',
        ], check=False), "angle")
        assert_invalid_params(run_page_processor([
            "apply",
            "deskew",
            str(spread_path),
            str(temp_root / "bad-background.png"),
            "--params",
            json.dumps({"angle": 1.5, "background_color": [255, -1, 255]}),
        ], check=False), "background_color")

        pad_payload = result_payload(run_page_processor([
            "pad",
            str(output_paths[0]),
            str(padded_path),
            "--width",
            "150",
            "--height",
            "160",
        ]).stdout)
        if not pad_payload.get("success") or pad_payload.get("output_size") != {"width": 150, "height": 160}:
            raise AssertionError(f"Pad command did not report expected size: {pad_payload}")

        padded = cv2.imread(str(padded_path))
        if padded is None or padded.shape[:2] != (160, 150):
            raise AssertionError(f"Failed to read padded output with expected dimensions: {pad_payload}")
        if not np.all(padded[0, :, :] == 255) or not np.all(padded[:, 0, :] == 255):
            raise AssertionError("Pad output did not add a white border")
        dark_pixels = int(np.count_nonzero(np.any(padded < 80, axis=2)))
        if dark_pixels < 100:
            raise AssertionError("Pad output lost split page content")

        uint16_path = temp_root / "uint16.png"
        uint16_padded_path = temp_root / "uint16-padded.png"
        uint16_image = np.zeros((2, 3), dtype=np.uint16)
        uint16_image[0, 0] = 1234
        if not cv2.imwrite(str(uint16_path), uint16_image, [cv2.IMWRITE_PNG_COMPRESSION, 0]):
            raise AssertionError("Failed to write uint16 pad fixture")

        run_page_processor([
            "pad",
            str(uint16_path),
            str(uint16_padded_path),
            "--width",
            "5",
            "--height",
            "4",
        ], env={"PAGE_PROCESSOR_PNG_COMPRESSION": "0"})
        uint16_padded = cv2.imread(str(uint16_padded_path), cv2.IMREAD_UNCHANGED)
        if uint16_padded is None:
            raise AssertionError("Failed to read uint16 padded output")
        if uint16_padded.dtype != np.uint16:
            raise AssertionError(f"Expected uint16 padded output, got {uint16_padded.dtype}")
        if int(uint16_padded[0, 0]) != 65535:
            raise AssertionError(f"Expected uint16 padding to be white, got {int(uint16_padded[0, 0])}")
        if int(uint16_padded[1, 1]) != 1234:
            raise AssertionError("Padded output did not preserve centered source pixels")

        unicode_input = temp_root / "\u0441\u043a\u0430\u043d.png"
        unicode_output = temp_root / "\u0432\u044b\u0445\u043e\u0434" / "\u043f\u0430\u0434.png"
        encoded_ok, encoded = cv2.imencode(".png", spread, [cv2.IMWRITE_PNG_COMPRESSION, 0])
        if not encoded_ok:
            raise AssertionError("Failed to encode unicode path fixture")
        unicode_input.write_bytes(encoded.tobytes())
        unicode_pad_payload = result_payload(run_page_processor([
            "pad",
            str(unicode_input),
            str(unicode_output),
            "--width",
            "280",
            "--height",
            "160",
        ], env={"PAGE_PROCESSOR_PNG_COMPRESSION": "0"}).stdout)
        if not unicode_pad_payload.get("success") or not unicode_output.exists():
            raise AssertionError(f"Unicode pad path did not produce output: {unicode_pad_payload}")
        unicode_padded = cv2.imdecode(np.frombuffer(unicode_output.read_bytes(), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if unicode_padded is None or unicode_padded.shape[:2] != (160, 280):
            raise AssertionError(f"Unicode pad output could not be decoded: {unicode_pad_payload}")

        unicode_detect_payload = result_payload(run_page_processor([
            "detect",
            str(unicode_input),
        ]).stdout)
        if unicode_detect_payload.get("size") != {"width": 260, "height": 140}:
            raise AssertionError(f"Unicode detect did not report fixture size: {unicode_detect_payload}")

        unicode_process_dir = temp_root / "\u0432\u044b\u0445\u043e\u0434 split path"
        unicode_process_payload = result_payload(run_page_processor([
            "process",
            str(unicode_input),
            str(unicode_process_dir),
            "--operations",
            "split",
            "--force-split",
            "--no-auto-detect",
        ], env={
            "PAGE_PROCESSOR_DEBUG_SPLIT": "1",
            "PAGE_PROCESSOR_PNG_COMPRESSION": "0",
        }).stdout)
        unicode_output_paths = [Path(path) for path in unicode_process_payload.get("output_paths", [])]
        if not unicode_process_payload.get("success") or len(unicode_output_paths) != 2:
            raise AssertionError(f"Unicode process did not split into two outputs: {unicode_process_payload}")
        if not all(path.exists() for path in unicode_output_paths):
            raise AssertionError(f"Unicode process outputs are missing: {unicode_process_payload}")
        debug_overlay = unicode_process_payload.get("split_debug", {}).get("debug_overlay_path")
        if not debug_overlay or not Path(debug_overlay).exists():
            raise AssertionError(f"Unicode process did not write split debug overlay: {unicode_process_payload}")

        tiny_path = temp_root / "tiny.png"
        tiny_image = np.full((8, 8, 3), 255, dtype=np.uint8)
        if not cv2.imwrite(str(tiny_path), tiny_image, [cv2.IMWRITE_PNG_COMPRESSION, 0]):
            raise AssertionError("Failed to write tiny stage fixture")
        for stage in ("rotation", "split", "deskew", "dewarp"):
            tiny_payload = result_payload(run_page_processor([
                "detect",
                stage,
                str(tiny_path),
                "--min-confidence",
                "0.0",
            ]).stdout)
            if tiny_payload.get("stage") != stage:
                raise AssertionError(f"Tiny {stage} detection returned unexpected payload: {tiny_payload}")


def run_pdf_cli() -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "Page processor smoke requires core runtime dependencies. "
            "Install python/page-processor/requirements.txt or at least numpy and opencv-python-headless."
        ) from error

    with tempfile.TemporaryDirectory(prefix="evb-page-processor-pdf-smoke-") as temp_dir:
        temp_root = Path(temp_dir)
        image_one = temp_root / "a" / "page.png"
        image_two = temp_root / "b" / "page.png"
        single_pdf = temp_root / "single.pdf"
        multi_pdf = temp_root / "multi.pdf"

        for index, path in enumerate((image_one, image_two), start=1):
            path.parent.mkdir(parents=True, exist_ok=True)
            image = np.full((48, 64, 3), 255, dtype=np.uint8)
            cv2.putText(
                image,
                str(index),
                (20, 34),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 0, 0),
                2,
                cv2.LINE_AA,
            )
            if not cv2.imwrite(str(path), image, [cv2.IMWRITE_PNG_COMPRESSION, 0]):
                raise AssertionError(f"Failed to write generated PDF fixture: {path}")

        missing_path = temp_root / "missing.png"
        missing_single = run_page_processor([
            "img2pdf",
            str(missing_path),
            str(temp_root / "missing-single.pdf"),
        ], check=False)
        assert_invalid_params(missing_single, "input")
        details = error_payload(missing_single.stderr).get("details", {})
        if details.get("index") != 0 or details.get("path") != str(missing_path):
            raise AssertionError(f"Missing single image did not report input index/path: {details}")

        missing_page = run_page_processor([
            "img2pdf-pages",
            str(temp_root / "missing-pages.pdf"),
            str(image_one),
            str(missing_path),
        ], check=False)
        assert_invalid_params(missing_page, "images")
        details = error_payload(missing_page.stderr).get("details", {})
        if details.get("index") != 1 or details.get("path") != str(missing_path):
            raise AssertionError(f"Missing page image did not report page index/path: {details}")

        single_payload = result_payload(run_page_processor([
            "img2pdf",
            str(image_one),
            str(single_pdf),
            "--dpi",
            "200",
        ]).stdout)
        if not single_payload.get("success") or single_payload.get("dpi") != 200:
            raise AssertionError(f"img2pdf did not report success: {single_payload}")
        assert_pdf_header(single_pdf)

        multi_payload = result_payload(run_page_processor([
            "img2pdf-pages",
            str(multi_pdf),
            str(image_one),
            str(image_two),
            "--dpi",
            "200",
            "--reencode",
            "jpeg",
            "--jpeg-quality",
            "90",
        ]).stdout)
        if (
            not multi_payload.get("success")
            or multi_payload.get("dpi") != 200
            or multi_payload.get("reencode") != "jpeg"
            or multi_payload.get("inputs") != [str(image_one), str(image_two)]
        ):
            raise AssertionError(f"img2pdf-pages did not report expected metadata: {multi_payload}")
        assert_pdf_header(multi_pdf)


def write_fake_page_dewarp_package(fake_root: Path) -> None:
    package = fake_root / "page_dewarp"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("__version__ = '9.9.9'\n", encoding="utf-8")
    (package / "options.py").write_text(
        """
class Config:
    __struct_fields__ = (
        "DEBUG_LEVEL",
        "NO_BINARY",
        "USE_BATCH",
        "DEBUG_DEST",
        "OUTPUT_DIR",
        "OUTPUT_FORMAT",
        "OUTPUT_JSON",
    )

    def __init__(self, **kwargs):
        self.DEBUG_LEVEL = 1
        self.NO_BINARY = 0
        self.USE_BATCH = "on"
        self.DEBUG_DEST = "screen"
        self.OUTPUT_DIR = "."
        self.OUTPUT_FORMAT = "jpg"
        self.OUTPUT_JSON = 1
        for key, value in kwargs.items():
            setattr(self, key, value)
""".lstrip(),
        encoding="utf-8",
    )
    (package / "image.py").write_text(
        """
import os
import sys
from pathlib import Path

import cv2


class WarpedImage:
    def __init__(self, image_path, config=None):
        self.written = False
        self.outfile = ""
        print("fake page-dewarp stdout noise")
        print("fake page-dewarp stderr noise", file=sys.stderr)
        if os.environ.get("FAKE_PAGE_DEWARP_MODE") == "no_output":
            print("skipping page because no spans were found")
            return

        source = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if source is None:
            raise RuntimeError("fake page-dewarp could not read input")

        result = source.copy()
        result[:, : max(1, result.shape[1] // 4)] = (0, 0, 0)
        output_dir = Path(getattr(config, "OUTPUT_DIR", Path(image_path).parent))
        output_dir.mkdir(parents=True, exist_ok=True)
        self.outfile = str(output_dir / f"{Path(image_path).stem}_thresh.png")
        if not cv2.imwrite(self.outfile, result):
            raise RuntimeError("fake page-dewarp could not write output")
        self.written = True
""".lstrip(),
        encoding="utf-8",
    )


def run_fake_dewarp_cli() -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "Page processor smoke requires core runtime dependencies. "
            "Install python/page-processor/requirements.txt or at least numpy and opencv-python-headless."
        ) from error

    with tempfile.TemporaryDirectory(prefix="evb-page-processor-dewarp-smoke-") as temp_dir:
        temp_root = Path(temp_dir)
        fake_root = temp_root / "fakepkg"
        write_fake_page_dewarp_package(fake_root)
        input_path = temp_root / "page.png"
        output_path = temp_root / "dewarped.png"
        skipped_output_path = temp_root / "dewarp-skipped.png"

        image = np.full((64, 80, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (20, 18), (60, 46), (0, 0, 0), 2)
        if not cv2.imwrite(str(input_path), image, [cv2.IMWRITE_PNG_COMPRESSION, 0]):
            raise AssertionError("Failed to write dewarp fixture")

        fake_python_path = f"{fake_root}{os.pathsep}{os.environ.get('PYTHONPATH', '')}"
        dewarp_result = run_page_processor([
            "apply",
            "dewarp",
            str(input_path),
            str(output_path),
            "--params",
            "{}",
        ], env={
            "PYTHONPATH": fake_python_path,
            "FAKE_PAGE_DEWARP_MODE": "changed",
            "PAGE_PROCESSOR_PNG_COMPRESSION": "0",
        })
        payload = result_payload(dewarp_result.stdout)
        if not payload.get("success") or not payload.get("dewarp_applied") or not payload.get("changed"):
            raise AssertionError(f"Fake dewarp output was not applied: {payload}")
        debug = payload.get("debug", {})
        updates = debug.get("config_updates", {})
        if updates.get("NO_BINARY") != 1 or not updates.get("OUTPUT_DIR"):
            raise AssertionError(f"Fake dewarp did not receive safe config updates: {debug}")
        if "fake page-dewarp stdout noise" not in debug.get("captured_stdout", ""):
            raise AssertionError(f"Fake dewarp stdout was not captured in debug metadata: {debug}")
        dewarped_image = cv2.imread(str(output_path), cv2.IMREAD_UNCHANGED)
        if dewarped_image is None or not np.any(dewarped_image[:, :20] == 0):
            raise AssertionError("Fake dewarp changed output was not saved")

        skipped_result = run_page_processor([
            "apply",
            "dewarp",
            str(input_path),
            str(skipped_output_path),
            "--params",
            "{}",
        ], env={
            "PYTHONPATH": fake_python_path,
            "FAKE_PAGE_DEWARP_MODE": "no_output",
            "PAGE_PROCESSOR_PNG_COMPRESSION": "0",
        })
        skipped_payload = result_payload(skipped_result.stdout)
        if skipped_payload.get("dewarp_applied") or skipped_payload.get("changed"):
            raise AssertionError(f"No-output fake dewarp should preserve original image: {skipped_payload}")
        if skipped_payload.get("reason") != "page_dewarp_skipped_insufficient_spans":
            raise AssertionError(f"No-output fake dewarp reported wrong reason: {skipped_payload}")

        broken_root = temp_root / "brokenpkg"
        broken_package = broken_root / "page_dewarp"
        broken_package.mkdir(parents=True)
        (broken_package / "__init__.py").write_text("", encoding="utf-8")
        (broken_package / "image.py").write_text(
            "raise ImportError('fake transitive dependency missing')\n",
            encoding="utf-8",
        )
        (broken_package / "options.py").write_text("class Config:\n    pass\n", encoding="utf-8")
        broken_detect_payload = result_payload(run_page_processor([
            "detect",
            "dewarp",
            str(input_path),
            "--min-curvature",
            "0.0",
        ], env={
            "PYTHONPATH": f"{broken_root}{os.pathsep}{os.environ.get('PYTHONPATH', '')}",
        }).stdout)
        if broken_detect_payload.get("needs_dewarp"):
            raise AssertionError(f"Broken page-dewarp runtime should not be reported usable: {broken_detect_payload}")
        broken_debug = broken_detect_payload.get("debug", {})
        if (
            broken_debug.get("reason") != "page_dewarp_runtime_unavailable"
            or broken_debug.get("page_dewarp_module_found") is not True
            or broken_debug.get("page_dewarp_available") is not False
        ):
            raise AssertionError(f"Broken page-dewarp runtime reported wrong debug payload: {broken_detect_payload}")


def run_real_locked_dewarp_cli() -> None:
    """Exercise the installed locked page-dewarp API through the real CLI path."""
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    with tempfile.TemporaryDirectory(prefix="evb-page-processor-real-dewarp-") as temp_dir:
        temp_root = Path(temp_dir)
        input_path = temp_root / "curved-text.png"
        output_path = temp_root / "dewarped.png"
        image = np.full((900, 700, 3), 255, dtype=np.uint8)
        for row, y in enumerate(range(100, 800, 42)):
            curve = 12 * np.sin(np.linspace(0, np.pi, 520) + row * 0.04)
            points = np.column_stack((np.arange(90, 610), (y + curve).astype(np.int32))).astype(np.int32)
            cv2.polylines(image, [points], False, (0, 0, 0), 2, cv2.LINE_AA)
        if not cv2.imwrite(str(input_path), image, [cv2.IMWRITE_PNG_COMPRESSION, 0]):
            raise AssertionError("Failed to write real dewarp fixture")

        payload = result_payload(run_page_processor([
            "apply",
            "dewarp",
            str(input_path),
            str(output_path),
            "--params",
            "{}",
        ], env={"PAGE_PROCESSOR_PNG_COMPRESSION": "0"}).stdout)
        debug = payload.get("debug", {})
        if debug.get("page_dewarp_version") != "0.3.4":
            raise AssertionError(f"Real dewarp did not use the locked page-dewarp version: {payload}")
        if not payload.get("tool_available") or not payload.get("attempted"):
            raise AssertionError(f"Real page-dewarp operation was not attempted: {payload}")
        if debug.get("execution_model") != "one-command-per-process-with-serialized-global-state":
            raise AssertionError(f"Dewarp execution isolation is not explicit: {payload}")
        if not output_path.exists() or cv2.imread(str(output_path)) is None:
            raise AssertionError(f"Real page-dewarp operation did not publish a readable output: {payload}")


def run_resource_and_transaction_regressions() -> None:
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    with tempfile.TemporaryDirectory(prefix="evb-page-processor-policy-") as temp_dir:
        temp_root = Path(temp_dir)
        one_pixel = temp_root / "one-pixel.png"
        if not cv2.imwrite(str(one_pixel), np.full((8, 1, 3), 255, dtype=np.uint8)):
            raise AssertionError("Failed to write one-pixel fixture")
        forced = run_page_processor([
            "process", str(one_pixel), str(temp_root / "forced"),
            "--operations", "split", "--force-split", "--no-auto-detect",
        ], check=False)
        if forced.returncode == 0 or "at least 2 pixels wide" not in forced.stderr:
            raise AssertionError(f"One-pixel forced split was not rejected safely: {forced}")

        invalid_output_dir = temp_root / "invalid"
        invalid_process = run_page_processor([
            "process", str(one_pixel), str(invalid_output_dir),
            "--operations", "crop", "--min-curvature", "nan",
        ], check=False)
        assert_invalid_params(invalid_process, "min_curvature")
        if invalid_output_dir.exists():
            raise AssertionError("Invalid process options should not create an output directory")
        invalid_padding = run_page_processor([
            "process", str(one_pixel), str(temp_root / "invalid-padding"),
            "--operations", "crop", "--crop-padding", "-1",
        ], check=False)
        assert_invalid_params(invalid_padding, "crop_padding")

        oversized = temp_root / "oversized.bin"
        with oversized.open("wb") as file:
            file.truncate(256 * 1024 * 1024 + 1)
        rejected = run_page_processor(["detect", str(oversized)], check=False)
        if rejected.returncode == 0 or "Compressed image" not in rejected.stderr:
            raise AssertionError(f"Oversized compressed input was not rejected before decode: {rejected}")

        def png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
            checksum = zlib.crc32(chunk_type)
            checksum = zlib.crc32(payload, checksum)
            return struct.pack(">I", len(payload)) + chunk_type + payload + struct.pack(">I", checksum)

        oversized_dimensions = temp_root / "oversized-dimensions.png"
        oversized_dimensions.write_bytes(
            b"\x89PNG\r\n\x1a\n"
            + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 16_385, 1, 8, 2, 0, 0, 0))
            + png_chunk(b"IEND", b"")
        )
        rejected_dimensions = run_page_processor(["detect", str(oversized_dimensions)], check=False)
        if rejected_dimensions.returncode == 0 or "image width" not in rejected_dimensions.stderr:
            raise AssertionError(
                f"Oversized header dimensions were not rejected before decode: {rejected_dimensions}"
            )

        rejected_pad = run_page_processor([
            "pad", str(one_pixel), str(temp_root / "oversized-pad.png"),
            "--width", "100", "--height", "100",
        ], check=False)
        if rejected_pad.returncode == 0 or "Pad expansion ratio" not in rejected_pad.stderr:
            raise AssertionError(f"Excessive pad expansion was not rejected before allocation: {rejected_pad}")

        sys.path.insert(0, str(PAGE_PROCESSOR_ROOT))
        try:
            from stages import io as image_io  # type: ignore

            first = temp_root / "set-1.png"
            second = temp_root / "set-2.png"
            first.write_bytes(b"old-first")
            second.write_bytes(b"old-second")
            original_replace = image_io.os.replace

            def fail_second_publish(source, target):
                source_path = Path(source)
                target_path = Path(target)
                if source_path.suffix == ".stage" and target_path == second:
                    raise OSError("injected second-page publication failure")
                return original_replace(source, target)

            image_io.os.replace = fail_second_publish  # type: ignore[assignment]
            try:
                try:
                    image_io.publish_image_set_atomically([
                        (first, np.zeros((4, 4, 3), dtype=np.uint8), [cv2.IMWRITE_PNG_COMPRESSION, 0]),
                        (second, np.zeros((4, 4, 3), dtype=np.uint8), [cv2.IMWRITE_PNG_COMPRESSION, 0]),
                    ])
                except OSError as error:
                    if "injected" not in str(error):
                        raise
                else:
                    raise AssertionError("Injected multi-page publication failure unexpectedly succeeded")
            finally:
                image_io.os.replace = original_replace  # type: ignore[assignment]
            if first.read_bytes() != b"old-first" or second.read_bytes() != b"old-second":
                raise AssertionError("Multi-page publication failure did not restore the previous complete set")
            if list(temp_root.glob("*.stage")) or list(temp_root.glob("*.backup")):
                raise AssertionError("Transactional publication left staging artifacts behind")
        finally:
            sys.path.remove(str(PAGE_PROCESSOR_ROOT))


def run_legacy_deskew_sign_cli() -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "Page processor smoke requires core runtime dependencies. "
            "Install python/page-processor/requirements.txt or at least numpy and opencv-python-headless."
        ) from error

    sys.path.insert(0, str(PAGE_PROCESSOR_ROOT))
    try:
        from detection import detect_skew_angle  # type: ignore
    finally:
        try:
            sys.path.remove(str(PAGE_PROCESSOR_ROOT))
        except ValueError:
            pass

    with tempfile.TemporaryDirectory(prefix="evb-page-processor-deskew-smoke-") as temp_dir:
        temp_root = Path(temp_dir)
        input_path = temp_root / "skewed.png"
        output_dir = temp_root / "out"

        base = np.full((420, 320, 3), 255, dtype=np.uint8)
        for y in range(58, 365, 26):
            cv2.line(base, (36, y), (284, y), (0, 0, 0), 2, cv2.LINE_AA)
        matrix = cv2.getRotationMatrix2D((160, 210), 4.0, 1.0)
        skewed = cv2.warpAffine(base, matrix, (320, 420), borderValue=(255, 255, 255))
        if not cv2.imwrite(str(input_path), skewed, [cv2.IMWRITE_PNG_COMPRESSION, 0]):
            raise AssertionError("Failed to write deskew sign fixture")

        detected_before = abs(float(detect_skew_angle(skewed)))
        if detected_before < 1.0:
            raise AssertionError(f"Deskew sign fixture was not detected as skewed enough: {detected_before}")

        payload = result_payload(run_page_processor([
            "process",
            str(input_path),
            str(output_dir),
            "--operations",
            "deskew",
            "--no-auto-detect",
            "--min-skew-angle",
            "0.1",
        ], env={"PAGE_PROCESSOR_PNG_COMPRESSION": "0"}).stdout)
        output_paths = payload.get("output_paths")
        if not payload.get("success") or not isinstance(output_paths, list) or len(output_paths) != 1:
            raise AssertionError(f"Deskew process did not report one output: {payload}")

        output_image = cv2.imread(output_paths[0])
        if output_image is None:
            raise AssertionError(f"Failed to read deskew output: {output_paths[0]}")

        detected_after = abs(float(detect_skew_angle(output_image)))
        if detected_after > max(0.5, detected_before * 0.5):
            raise AssertionError(
                f"Legacy process deskew did not improve skew enough: before={detected_before}, after={detected_after}"
            )


def main() -> None:
    ensure_smoke_dependencies()
    compile_sources()
    run_python_quality_gates()
    run_lightweight_cli()
    run_main_helper_regressions()
    run_ocr_benchmark_regressions()
    run_generated_scan_pipeline()
    run_stage_and_padding_cli()
    run_pdf_cli()
    run_real_locked_dewarp_cli()
    run_fake_dewarp_cli()
    run_resource_and_transaction_regressions()
    run_legacy_deskew_sign_cli()
    print("Page processor smoke check passed.")


if __name__ == "__main__":
    main()
