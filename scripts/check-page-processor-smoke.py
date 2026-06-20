#!/usr/bin/env python3

import json
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from importlib.util import find_spec, module_from_spec, spec_from_file_location
from io import StringIO
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PAGE_PROCESSOR_ROOT = PROJECT_ROOT / "python" / "page-processor"
SMOKE_DEPENDENCIES = (
    "numpy>=2.0.0",
    "opencv-python-headless>=4.10.0",
    "img2pdf>=0.6.3",
    "Pillow>=10.0.0",
)
SMOKE_BOOTSTRAP_ENV_VAR = "EVB_PAGE_PROCESSOR_SMOKE_BOOTSTRAPPED"
SMOKE_VENV_ROOT = PROJECT_ROOT / ".devkit" / "python-page-processor-smoke"


def has_smoke_dependencies() -> bool:
    return all(find_spec(module_name) is not None for module_name in ("cv2", "numpy", "img2pdf", "PIL"))


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


def load_page_processor_main():
    spec = spec_from_file_location("page_processor_main_smoke", PAGE_PROCESSOR_ROOT / "main.py")
    if spec is None or spec.loader is None:
        raise AssertionError("Failed to load page processor main module spec")

    module = module_from_spec(spec)
    spec.loader.exec_module(module)
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

    with tempfile.TemporaryDirectory(prefix="evb-page-processor-reencode-paths-") as temp_dir:
        work_dir = Path(temp_dir)
        first = module.reencode_temp_path("/tmp/a/page.png", work_dir, 0, ".jpg")
        second = module.reencode_temp_path("/tmp/b/page.png", work_dir, 1, ".jpg")
        if first == second:
            raise AssertionError("Same-stem reencode temp paths should not collide")
        if first.name != "000000-page.jpg" or second.name != "000001-page.jpg":
            raise AssertionError(f"Unexpected reencode temp path names: {first.name}, {second.name}")


def assert_invalid_params(result: subprocess.CompletedProcess[str], field: str) -> None:
    if result.returncode == 0:
        raise AssertionError(f"Expected INVALID_PARAMS failure for {field}, got success: {result.stdout}")

    payload = json.loads(result.stderr)
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
    run_lightweight_cli()
    run_main_helper_regressions()
    run_generated_scan_pipeline()
    run_stage_and_padding_cli()
    run_pdf_cli()
    run_legacy_deskew_sign_cli()
    print("Page processor smoke check passed.")


if __name__ == "__main__":
    main()
