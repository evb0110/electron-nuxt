#!/usr/bin/env python3
"""
Page Processor - Main Entry Point

Processes scanned book page images with:
- Facing page detection and splitting
- Deskewing (rotation correction)
- Dewarping (curvature removal)
- Content detection and margin cropping

Usage:
    page-processor process <input_image> <output_dir> [options]
    page-processor detect <input_image>
    page-processor detect <stage> <input_image>
    page-processor apply <stage> <input_image> <output> --params <json>
    page-processor pad <input_image> <output_image> --width <px> --height <px>
    page-processor img2pdf <input_image> <output_pdf> [--dpi <dpi>]
    page-processor img2pdf-pages <output_pdf> <image1> [image2 ...] [--dpi <dpi>]
    page-processor --version

Stages:
    rotation  - Detect/apply page orientation (0/90/180/270)
    split     - Detect/apply facing page split
    deskew    - Detect/apply skew correction
    dewarp    - Detect/apply curvature correction

Communication:
    - Progress: JSON lines to stdout
    - Errors: stderr
    - Results: JSON file in output directory
"""

import argparse
import json
import math
import sys
import os
import tempfile
from pathlib import Path
from typing import Optional

VERSION = "2.0.0"

STAGES = ['rotation', 'split', 'deskew', 'dewarp']


class CommandError(Exception):
    def __init__(self, message: str, code: str = "UNKNOWN_ERROR", details: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.details = details


def to_jsonable(value):
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(to_jsonable(k)): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]

    item = getattr(value, "item", None)
    if callable(item):
        try:
            return to_jsonable(item())
        except Exception:
            pass

    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        try:
            return to_jsonable(tolist())
        except Exception:
            pass

    return value


def dumps_json(data: dict) -> str:
    return json.dumps(to_jsonable(data), allow_nan=False)


def send_progress(data: dict):
    """Send progress update as JSON line to stdout."""
    print(dumps_json({"type": "progress", **data}), flush=True)


def send_result(data: dict):
    """Send result as JSON line to stdout."""
    print(dumps_json({"type": "result", **data}), flush=True)


def send_error(message: str, code: str = "UNKNOWN_ERROR", details: Optional[dict] = None):
    """Send error to stderr."""
    payload = {
        "type": "error",
        "message": message,
        "code": code
    }
    if details is not None:
        payload["details"] = details
    print(dumps_json(payload), file=sys.stderr, flush=True)


def invalid_param(field: str, value, expected: str) -> CommandError:
    return CommandError(
        f"Invalid {field}: expected {expected}",
        "INVALID_PARAMS",
        {
            "field": field,
            "value": value,
            "expected": expected,
        },
    )


def coerce_split_position(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise invalid_param("position", value, "number in the open interval (0, 1)")

    position = float(value)
    if not math.isfinite(position) or position <= 0.0 or position >= 1.0:
        raise invalid_param("position", value, "number in the open interval (0, 1)")

    return position


def coerce_split_overlap(value) -> int:
    if isinstance(value, bool):
        raise invalid_param("overlap", value, "nonnegative integer")

    if isinstance(value, int):
        overlap = value
    elif isinstance(value, float) and math.isfinite(value) and value.is_integer():
        overlap = int(value)
    else:
        raise invalid_param("overlap", value, "nonnegative integer")

    if overlap < 0:
        raise invalid_param("overlap", value, "nonnegative integer")

    return overlap


def coerce_rotation(value) -> int:
    if isinstance(value, bool):
        raise invalid_param("rotation", value, "one of: 0, 90, 180, 270")

    if isinstance(value, int):
        rotation = value
    elif isinstance(value, float) and math.isfinite(value) and value.is_integer():
        rotation = int(value)
    else:
        raise invalid_param("rotation", value, "one of: 0, 90, 180, 270")

    if rotation not in (0, 90, 180, 270):
        raise invalid_param("rotation", value, "one of: 0, 90, 180, 270")

    return rotation


def coerce_deskew_angle(value) -> float:
    expected = "finite number of degrees in [-45, 45]"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise invalid_param("angle", value, expected)

    angle = float(value)
    if not math.isfinite(angle) or abs(angle) > 45.0:
        raise invalid_param("angle", value, expected)

    return angle


def coerce_background_color(value) -> tuple[int, int, int]:
    expected = "array of three integers in [0, 255]"
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise invalid_param("background_color", value, expected)

    channels = []
    for channel in value:
        if isinstance(channel, bool):
            raise invalid_param("background_color", value, expected)
        if isinstance(channel, int):
            parsed = channel
        elif isinstance(channel, float) and math.isfinite(channel) and channel.is_integer():
            parsed = int(channel)
        else:
            raise invalid_param("background_color", value, expected)
        if parsed < 0 or parsed > 255:
            raise invalid_param("background_color", value, expected)
        channels.append(parsed)

    return channels[0], channels[1], channels[2]


def validate_apply_deskew_params(params: dict) -> tuple[float, tuple[int, int, int]]:
    angle = coerce_deskew_angle(params.get('angle', 0.0))
    background = coerce_background_color(params.get('background_color', [255, 255, 255]))
    return angle, background


def read_image_dimensions(input_path: str) -> tuple[int, int]:
    from stages.io import load_image_unchanged

    image = load_image_unchanged(input_path)

    h, w = image.shape[:2]
    return int(w), int(h)


def validate_apply_split_params(input_path: str, params: dict) -> tuple[str, float, int]:
    split_type = params.get('split_type', 'none')
    if split_type not in ('none', 'vertical', 'horizontal'):
        raise invalid_param("split_type", split_type, "one of: none, vertical, horizontal")

    if split_type == 'none':
        return split_type, 0.5, 0

    position = coerce_split_position(params.get('position', 0.5))
    overlap = coerce_split_overlap(params.get('overlap', 0))

    width, height = read_image_dimensions(input_path)
    dimension = width if split_type == 'vertical' else height
    split_pixel = int(dimension * position)

    if split_pixel <= 0 or split_pixel >= dimension:
        raise invalid_param(
            "position",
            position,
            f"position that leaves at least 1 pixel on each side for {dimension}px input",
        )

    max_overlap = max(0, min(split_pixel, dimension - split_pixel) - 1)
    if overlap > max_overlap:
        raise invalid_param(
            "overlap",
            overlap,
            f"integer between 0 and {max_overlap} for this {split_type} split",
        )

    return split_type, position, overlap


def invalid_img2pdf_input(field: str, path: str, index: int, expected: str, reason: Optional[str] = None) -> CommandError:
    details = {
        "field": field,
        "path": path,
        "index": index,
        "expected": expected,
    }
    if reason:
        details["reason"] = reason

    return CommandError(
        f"Invalid {field}[{index}]: expected {expected}: {path}",
        "INVALID_PARAMS",
        details,
    )


def prevalidate_img2pdf_input(path_value: str, field: str, index: int) -> None:
    from PIL import Image  # type: ignore

    expected = "existing decodable image file"
    path_text = str(path_value)
    try:
        path = Path(path_text)
        exists = path.exists()
        is_file = path.is_file() if exists else False
    except OSError as e:
        raise invalid_img2pdf_input(field, path_text, index, expected, str(e))

    if not exists:
        raise invalid_img2pdf_input(field, path_text, index, expected, "path does not exist")
    if not is_file:
        raise invalid_img2pdf_input(field, path_text, index, expected, "path is not a file")

    try:
        with Image.open(path) as image:
            image.verify()
    except Exception as e:
        raise invalid_img2pdf_input(field, path_text, index, expected, str(e))


def prevalidate_img2pdf_inputs(paths: list[str], field: str) -> None:
    for index, path in enumerate(paths):
        prevalidate_img2pdf_input(path, field, index)


def white_value_for_dtype(dtype):
    kind = getattr(dtype, "kind", None)
    itemsize = int(getattr(dtype, "itemsize", 0) or 0)

    if kind == "b":
        return True
    if kind == "u" and itemsize > 0:
        return (1 << (8 * itemsize)) - 1
    if kind == "i" and itemsize > 0:
        return (1 << (8 * itemsize - 1)) - 1
    if kind == "f":
        return 1.0

    return 255


def reencode_temp_path(input_path: str, work_dir: Path, index: int, suffix: str) -> Path:
    stem = Path(input_path).stem or "page"
    return work_dir / f"{index:06d}-{stem}{suffix}"


def write_output_atomically(output_path: str, write_fn) -> None:
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Optional[Path] = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=str(target.parent),
            prefix=f".{target.name}.",
            suffix=".tmp",
            delete=False,
        ) as f:
            tmp_path = Path(f.name)
            write_fn(f)
            f.flush()
            os.fsync(f.fileno())

        os.replace(tmp_path, target)
        tmp_path = None

        try:
            dir_fd = os.open(str(target.parent), os.O_RDONLY)
        except OSError:
            dir_fd = None
        if dir_fd is not None:
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass


def process_image(
    input_path: str,
    output_dir: str,
    operations: list[str],
    options: dict,
) -> dict:
    """
    Process a single image through the pipeline.

    Args:
        input_path: Path to input PNG image
        output_dir: Directory for output images
        operations: List of operations to perform
        options: Processing options

    Returns:
        Result dictionary with output paths and metadata
    """
    # Import heavy dependencies lazily so `--version` and lightweight commands are instant.
    from processor import PageProcessor

    processor = PageProcessor(
        min_skew_angle=options.get('min_skew_angle', 0.5),
        min_curvature=options.get('min_curvature', 0.1),
        crop_padding=options.get('crop_padding', 30),
        auto_detect=options.get('auto_detect', True),
        force_split=options.get('force_split', False),
    )

    send_progress({
        "stage": "loading",
        "message": f"Loading image: {input_path}",
    })

    result = processor.process(
        input_path=input_path,
        output_dir=output_dir,
        operations=operations,
        progress_callback=send_progress,
    )

    return result


def detect_characteristics(input_path: str) -> dict:
    """
    Detect page characteristics without processing.

    Returns detection results for UI preview.
    """
    from detection import detect_page_characteristics
    return detect_page_characteristics(input_path)


def run_stage_detect(stage: str, input_path: str, options: dict) -> dict:
    """
    Run detection for a specific stage.

    Args:
        stage: Stage name (rotation, split, deskew, dewarp)
        input_path: Path to input image
        options: Stage-specific options

    Returns:
        Detection result dictionary
    """
    if stage == 'rotation':
        from stages.rotation import detect_rotation
        result = detect_rotation(input_path)
        return result.to_dict()

    elif stage == 'split':
        from stages.split import detect_split
        min_confidence = options.get('min_confidence', 0.6)
        result = detect_split(input_path, min_confidence)
        return result.to_dict()

    elif stage == 'deskew':
        from stages.deskew import detect_deskew
        min_angle = options.get('min_angle', 0.5)
        max_angle = options.get('max_angle', 15.0)
        result = detect_deskew(input_path, min_angle, max_angle)
        return result.to_dict()

    elif stage == 'dewarp':
        from stages.dewarp import detect_dewarp
        min_curvature = options.get('min_curvature', 0.1)
        result = detect_dewarp(input_path, min_curvature)
        return result.to_dict()

    else:
        raise ValueError(f"Unknown stage: {stage}")


def run_stage_apply(
    stage: str,
    input_path: str,
    output_path: str,
    params: dict,
) -> dict:
    """
    Apply a stage transformation.

    Args:
        stage: Stage name
        input_path: Path to input image
        output_path: Path for output image (or directory for split)
        params: Stage parameters (from detection or manual)

    Returns:
        Result dictionary
    """
    if stage == 'rotation':
        rotation = coerce_rotation(params.get('rotation', 0))
        from stages.rotation import apply_rotation
        return apply_rotation(input_path, output_path, rotation)

    elif stage == 'split':
        from stages.split import apply_split
        split_type, position, overlap = validate_apply_split_params(input_path, params)
        return apply_split(input_path, output_path, split_type, position, overlap)

    elif stage == 'deskew':
        angle, background = validate_apply_deskew_params(params)
        from stages.deskew import apply_deskew
        return apply_deskew(input_path, output_path, angle, background)

    elif stage == 'dewarp':
        from stages.dewarp import apply_dewarp
        return apply_dewarp(input_path, output_path)

    else:
        raise ValueError(f"Unknown stage: {stage}")


def main():
    parser = argparse.ArgumentParser(
        description="Page Processor for scanned book pages",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--version', action='version', version=f'page-processor {VERSION}')

    subparsers = parser.add_subparsers(dest='command', required=True)

    # Process command (legacy full pipeline)
    process_parser = subparsers.add_parser('process', help='Process an image (legacy)')
    process_parser.add_argument('input', help='Input image path')
    process_parser.add_argument('output_dir', help='Output directory')
    process_parser.add_argument(
        '--operations',
        nargs='+',
        choices=['split', 'deskew', 'dewarp', 'crop'],
        default=['split', 'deskew', 'dewarp', 'crop'],
        help='Operations to perform',
    )
    process_parser.add_argument('--force-split', action='store_true', help='Force page splitting')
    process_parser.add_argument('--no-auto-detect', action='store_true', help='Disable auto-detection')
    process_parser.add_argument('--min-skew-angle', type=float, default=0.5, help='Minimum skew angle')
    process_parser.add_argument('--min-curvature', type=float, default=0.1, help='Minimum curvature')
    process_parser.add_argument('--crop-padding', type=int, default=30, help='Crop padding in pixels')

    # Detect command - with optional stage argument
    detect_parser = subparsers.add_parser('detect', help='Detect page characteristics or run stage detection')
    detect_parser.add_argument('stage_or_input', help='Stage name or input image path')
    detect_parser.add_argument('input', nargs='?', help='Input image path (when stage is specified)')
    detect_parser.add_argument('--min-confidence', type=float, default=0.6, help='Min split confidence')
    detect_parser.add_argument('--min-angle', type=float, default=0.5, help='Min deskew angle')
    detect_parser.add_argument('--max-angle', type=float, default=15.0, help='Max deskew angle')
    detect_parser.add_argument('--min-curvature', type=float, default=0.1, help='Min dewarp curvature')

    # Apply command
    apply_parser = subparsers.add_parser('apply', help='Apply stage transformation')
    apply_parser.add_argument('stage', choices=STAGES, help='Stage to apply')
    apply_parser.add_argument('input', help='Input image path')
    apply_parser.add_argument('output', help='Output image path (or directory for split)')
    apply_parser.add_argument('--params', type=str, required=True, help='JSON parameters')

    # List-stages command
    list_parser = subparsers.add_parser('list-stages', help='List available stages')

    # Pad command - symmetric white padding to a target canvas size (no scaling/cropping)
    pad_parser = subparsers.add_parser('pad', help='Pad an image to a target size (symmetric, white)')
    pad_parser.add_argument('input', help='Input image path')
    pad_parser.add_argument('output', help='Output image path')
    pad_parser.add_argument('--width', type=int, required=True, help='Target width in pixels')
    pad_parser.add_argument('--height', type=int, required=True, help='Target height in pixels')

    # img2pdf command - wrap an image into a single-page PDF (lossless, fast).
    img2pdf_parser = subparsers.add_parser('img2pdf', help='Convert image to single-page PDF (lossless)')
    img2pdf_parser.add_argument('input', help='Input image path')
    img2pdf_parser.add_argument('output', help='Output PDF path')
    img2pdf_parser.add_argument('--dpi', type=int, default=300, help='Assumed DPI for page size (default: 300)')

    img2pdf_pages_parser = subparsers.add_parser('img2pdf-pages', help='Convert images to a multi-page PDF (lossless)')
    img2pdf_pages_parser.add_argument('output', help='Output PDF path')
    img2pdf_pages_parser.add_argument('images', nargs='+', help='One or more input image paths')
    img2pdf_pages_parser.add_argument('--dpi', type=int, default=300, help='Assumed DPI for page size (default: 300)')
    img2pdf_pages_parser.add_argument(
        '--reencode',
        choices=['none', 'jpeg', 'ccitt'],
        default='none',
        help='Optional re-encoding for smaller scanned PDFs (default: none)',
    )
    img2pdf_pages_parser.add_argument(
        '--jpeg-quality',
        type=int,
        default=95,
        help='JPEG quality when --reencode=jpeg (default: 95)',
    )
    img2pdf_pages_parser.add_argument(
        '--jpeg-subsampling',
        type=int,
        default=0,
        help='JPEG chroma subsampling when --reencode=jpeg (0=4:4:4, default: 0)',
    )

    args = parser.parse_args()

    try:
        if args.command == 'process':
            os.makedirs(args.output_dir, exist_ok=True)

            options = {
                'force_split': args.force_split,
                'auto_detect': not args.no_auto_detect,
                'min_skew_angle': args.min_skew_angle,
                'min_curvature': args.min_curvature,
                'crop_padding': args.crop_padding,
            }

            result = process_image(
                input_path=args.input,
                output_dir=args.output_dir,
                operations=args.operations,
                options=options,
            )

            send_result(result)

        elif args.command == 'detect':
            # Check if first arg is a stage name or an input file
            if args.stage_or_input in STAGES:
                # Stage-specific detection
                stage = args.stage_or_input
                input_path = args.input

                if not input_path:
                    send_error(f"Input path required for stage detection", "MISSING_INPUT")
                    sys.exit(1)

                options = {
                    'min_confidence': args.min_confidence,
                    'min_angle': args.min_angle,
                    'max_angle': args.max_angle,
                    'min_curvature': args.min_curvature,
                }

                result = run_stage_detect(stage, input_path, options)
                send_result({
                    'stage': stage,
                    **result
                })

            else:
                # Legacy full detection (first arg is input path)
                input_path = args.stage_or_input
                result = detect_characteristics(input_path)
                send_result(result)

        elif args.command == 'apply':
            # Parse params JSON
            try:
                params = json.loads(args.params)
            except json.JSONDecodeError as e:
                send_error(
                    f"Invalid JSON params: {e}",
                    "INVALID_PARAMS",
                    {"field": "params", "expected": "JSON object"},
                )
                sys.exit(1)
            if not isinstance(params, dict):
                send_error(
                    "Params must be a JSON object",
                    "INVALID_PARAMS",
                    {"field": "params", "value": params, "expected": "JSON object"},
                )
                sys.exit(1)

            result = run_stage_apply(
                stage=args.stage,
                input_path=args.input,
                output_path=args.output,
                params=params,
            )

            send_result({
                'stage': args.stage,
                **result
            })

        elif args.command == 'list-stages':
            send_result({
                'stages': STAGES,
                'version': VERSION,
            })

        elif args.command == 'pad':
            # Keep this import local so `--version` and other lightweight commands stay fast.
            import cv2  # type: ignore
            import numpy as np  # type: ignore
            from stages.io import load_image_unchanged, write_image_atomically

            try:
                image = load_image_unchanged(args.input)
            except ValueError as e:
                send_error(str(e), "LOAD_FAILED")
                sys.exit(1)

            h, w = image.shape[:2]
            target_w = int(args.width)
            target_h = int(args.height)
            if target_w <= 0 or target_h <= 0:
                send_error("Target width/height must be positive", "INVALID_TARGET")
                sys.exit(1)
            if w > target_w or h > target_h:
                send_error(
                    f"Target size too small: input={w}x{h}, target={target_w}x{target_h}",
                    "TARGET_TOO_SMALL",
                )
                sys.exit(1)

            # Match channel count; always white padding.
            white_value = white_value_for_dtype(image.dtype)
            if len(image.shape) == 3:
                canvas = np.full((target_h, target_w, image.shape[2]), white_value, dtype=image.dtype)
            else:
                canvas = np.full((target_h, target_w), white_value, dtype=image.dtype)

            x_off = max(0, (target_w - w) // 2)
            y_off = max(0, (target_h - h) // 2)
            canvas[y_off:y_off + h, x_off:x_off + w] = image

            # Use the same env-driven PNG compression as the legacy processor.
            try:
                png_compression = int(os.environ.get("PAGE_PROCESSOR_PNG_COMPRESSION", "1"))
            except Exception:
                png_compression = 1
            png_compression = max(0, min(9, png_compression))

            try:
                write_image_atomically(
                    Path(args.output),
                    canvas,
                    [cv2.IMWRITE_PNG_COMPRESSION, png_compression],
                )
            except Exception as e:
                send_error(f"Failed to write output image: {args.output}: {e}", "WRITE_FAILED")
                sys.exit(1)

            send_result({
                "success": True,
                "input_path": args.input,
                "output_path": args.output,
                "input_size": {"width": int(w), "height": int(h)},
                "output_size": {"width": int(target_w), "height": int(target_h)},
            })

        elif args.command == 'img2pdf':
            dpi = int(args.dpi or 300)
            if dpi <= 0:
                send_error("DPI must be positive", "INVALID_DPI")
                sys.exit(1)

            prevalidate_img2pdf_inputs([args.input], "input")

            # Keep this import local to avoid penalizing non-PDF workflows.
            import img2pdf  # type: ignore

            # img2pdf needs a (x_dpi, y_dpi) tuple.
            layout_fun = img2pdf.get_fixed_dpi_layout_fun((dpi, dpi))

            try:
                write_output_atomically(
                    args.output,
                    lambda f: img2pdf.convert(args.input, outputstream=f, layout_fun=layout_fun),
                )
            except Exception as e:
                send_error(f"img2pdf failed: {e}", "IMG2PDF_FAILED")
                sys.exit(1)

            send_result({
                "success": True,
                "input_path": args.input,
                "output_path": args.output,
                "dpi": dpi,
            })

        elif args.command == 'img2pdf-pages':
            from PIL import Image  # type: ignore

            dpi = int(args.dpi or 300)
            if dpi <= 0:
                send_error("DPI must be positive", "INVALID_DPI")
                sys.exit(1)

            if not args.images:
                send_error("At least one image is required", "MISSING_INPUT")
                sys.exit(1)

            prevalidate_img2pdf_inputs(list(args.images), "images")

            import img2pdf  # type: ignore

            layout_fun = img2pdf.get_fixed_dpi_layout_fun((dpi, dpi))

            def _otsu_threshold(gray: Image.Image) -> int:
                # Compute Otsu threshold on a downscaled grayscale image for speed.
                # Returns a value in [0, 255].
                hist = gray.histogram()
                if not hist or len(hist) < 256:
                    return 128
                total = sum(hist[:256])
                if total <= 0:
                    return 128

                sum_total = 0
                for i in range(256):
                    sum_total += i * hist[i]

                sum_b = 0
                w_b = 0
                w_f = 0
                var_max = -1.0
                threshold = 128

                for t in range(256):
                    w_b += hist[t]
                    if w_b == 0:
                        continue
                    w_f = total - w_b
                    if w_f == 0:
                        break
                    sum_b += t * hist[t]
                    m_b = sum_b / w_b
                    m_f = (sum_total - sum_b) / w_f
                    var_between = w_b * w_f * (m_b - m_f) * (m_b - m_f)
                    if var_between > var_max:
                        var_max = var_between
                        threshold = t
                return int(threshold)

            def _reencode_one(inp: str, mode: str, work_dir: Path, index: int) -> str:
                if mode == "none":
                    return inp

                src = Image.open(inp)
                try:
                    if mode == "jpeg":
                        # JPEG can't store alpha; flatten to white.
                        if src.mode in ("RGBA", "LA"):
                            bg = Image.new("RGB", src.size, (255, 255, 255))
                            bg.paste(src, mask=src.split()[-1])
                            src_rgb = bg
                        elif src.mode != "RGB":
                            src_rgb = src.convert("RGB")
                        else:
                            src_rgb = src

                        q = int(args.jpeg_quality or 95)
                        q = max(1, min(100, q))
                        subs = int(args.jpeg_subsampling or 0)
                        subs = max(0, min(2, subs))

                        outp = reencode_temp_path(inp, work_dir, index, ".jpg")
                        src_rgb.save(
                            str(outp),
                            format="JPEG",
                            quality=q,
                            subsampling=subs,
                            optimize=True,
                        )
                        return str(outp)

                    if mode == "ccitt":
                        # Convert to 1-bit and store as TIFF G4 so img2pdf embeds CCITT Fax (lossless for bitonal).
                        if src.mode != "L":
                            gray = src.convert("L")
                        else:
                            gray = src

                        # Downscale for threshold estimation.
                        w, h = gray.size
                        max_w = 900
                        if w > max_w:
                            scale = max_w / float(w)
                            small = gray.resize((max_w, max(1, int(h * scale))), Image.Resampling.BILINEAR)
                        else:
                            small = gray

                        thr = _otsu_threshold(small)
                        bw_l = gray.point(lambda p: 255 if p > thr else 0)
                        bw = bw_l.convert("1", dither=Image.Dither.NONE)

                        outp = reencode_temp_path(inp, work_dir, index, ".tif")
                        bw.save(str(outp), format="TIFF", compression="group4")
                        return str(outp)

                    raise ValueError(f"Unknown reencode mode: {mode}")
                finally:
                    try:
                        src.close()
                    except Exception:
                        pass

            try:
                tmp_dir: Optional[tempfile.TemporaryDirectory[str]] = None
                try:
                    if args.reencode and args.reencode != "none":
                        tmp_dir = tempfile.TemporaryDirectory(prefix="pp-img2pdf-")
                        work_dir = Path(tmp_dir.name)
                        inputs = [
                            _reencode_one(p, args.reencode, work_dir, i)
                            for i, p in enumerate(args.images)
                        ]
                    else:
                        inputs = list(args.images)

                    write_output_atomically(
                        args.output,
                        lambda f: img2pdf.convert(*inputs, outputstream=f, layout_fun=layout_fun),
                    )
                finally:
                    if tmp_dir is not None:
                        tmp_dir.cleanup()
            except Exception as e:
                send_error(f"img2pdf failed: {e}", "IMG2PDF_FAILED")
                sys.exit(1)

            send_result({
                "success": True,
                "output_path": args.output,
                "inputs": list(args.images),
                "dpi": dpi,
                "reencode": getattr(args, "reencode", "none"),
            })

    except CommandError as e:
        send_error(str(e), e.code, e.details)
        sys.exit(1)
    except Exception as e:
        send_error(str(e), "PROCESSING_ERROR")
        sys.exit(1)


if __name__ == '__main__':
    main()
