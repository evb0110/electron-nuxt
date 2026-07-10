"""Resource and numeric-input policy shared by every page-processor pipeline."""

from __future__ import annotations

import math
from pathlib import Path

MAX_COMPRESSED_IMAGE_BYTES = 128 * 1024 * 1024
MAX_DECODED_IMAGE_BYTES = 512 * 1024 * 1024
MAX_IMAGE_DIMENSION = 16_384
MAX_IMAGE_PIXELS = 50_000_000
MAX_PAD_PIXELS = 64_000_000
MAX_PAD_EXPANSION_RATIO = 16.0
MAX_PADDING_PIXELS = 32_768
MAX_DPI = 2_400


def validate_finite_range(name: str, value: float, minimum: float, maximum: float) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be finite and in [{minimum}, {maximum}]")
    return parsed


def validate_integer_range(name: str, value: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer in [{minimum}, {maximum}]")
    parsed = int(value)
    if parsed != value or parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be an integer in [{minimum}, {maximum}]")
    return parsed


def validate_dimensions(width: int, height: int, *, max_pixels: int = MAX_IMAGE_PIXELS) -> tuple[int, int]:
    width = validate_integer_range("image width", width, 1, MAX_IMAGE_DIMENSION)
    height = validate_integer_range("image height", height, 1, MAX_IMAGE_DIMENSION)
    pixels = width * height
    if pixels > max_pixels:
        raise ValueError(f"Image has {pixels} pixels; limit is {max_pixels}")
    return width, height


def validate_image_file(path: Path) -> tuple[int, int]:
    """Validate bytes and header dimensions before OpenCV allocates decoded pixels."""
    if not path.exists():
        raise ValueError(f"Image file does not exist: {path}")
    if not path.is_file():
        raise ValueError(f"Image path is not a file: {path}")

    try:
        byte_size = path.stat().st_size
    except OSError as error:
        raise ValueError(f"Failed to stat image: {path}: {error}") from error
    if byte_size <= 0:
        raise ValueError(f"Image file is empty: {path}")
    if byte_size > MAX_COMPRESSED_IMAGE_BYTES:
        raise ValueError(
            f"Compressed image is {byte_size} bytes; limit is {MAX_COMPRESSED_IMAGE_BYTES}: {path}"
        )

    try:
        from PIL import Image  # type: ignore

        with Image.open(path) as image:
            width, height = image.size
    except Exception as error:
        raise ValueError(f"Failed to inspect image header: {path}: {error}") from error
    return validate_dimensions(width, height)


def validate_decoded_image(image, *, expected: tuple[int, int] | None = None) -> tuple[int, int]:
    if image is None or getattr(image, "ndim", 0) not in (2, 3):
        raise ValueError("Decoded image has an unsupported shape")
    height, width = image.shape[:2]
    dimensions = validate_dimensions(int(width), int(height))
    decoded_bytes = int(getattr(image, "nbytes", 0))
    if decoded_bytes <= 0 or decoded_bytes > MAX_DECODED_IMAGE_BYTES:
        raise ValueError(
            f"Decoded image uses {decoded_bytes} bytes; limit is {MAX_DECODED_IMAGE_BYTES}"
        )
    if expected is not None and dimensions != expected:
        raise ValueError(
            f"Decoded image dimensions {dimensions[0]}x{dimensions[1]} do not match header "
            f"{expected[0]}x{expected[1]}"
        )
    return dimensions


def validate_pad_target(
    input_width: int,
    input_height: int,
    target_width: int,
    target_height: int,
    *,
    channels: int = 1,
    itemsize: int = 1,
) -> tuple[int, int]:
    validate_dimensions(input_width, input_height)
    target_width, target_height = validate_dimensions(
        target_width,
        target_height,
        max_pixels=MAX_PAD_PIXELS,
    )
    if target_width < input_width or target_height < input_height:
        raise ValueError(
            f"Target size too small: input={input_width}x{input_height}, "
            f"target={target_width}x{target_height}"
        )
    input_pixels = input_width * input_height
    output_pixels = target_width * target_height
    output_bytes = output_pixels * channels * itemsize
    if output_bytes > MAX_DECODED_IMAGE_BYTES:
        raise ValueError(
            f"Padded image would use {output_bytes} bytes; limit is {MAX_DECODED_IMAGE_BYTES}"
        )
    if output_pixels > input_pixels * MAX_PAD_EXPANSION_RATIO:
        raise ValueError(
            f"Pad expansion ratio {output_pixels / input_pixels:.2f} exceeds "
            f"{MAX_PAD_EXPANSION_RATIO:.0f}x"
        )
    return target_width, target_height
