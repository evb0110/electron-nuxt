"""
I/O utilities for stage processing.

Provides consistent image loading and saving with proper error handling.
"""

import os
import tempfile
from pathlib import Path
from typing import Tuple
import json
import sys
import math

import cv2
import numpy as np


def _encode_extension(path: Path) -> str:
    suffix = path.suffix.lower()
    return suffix if suffix else ".png"


def _fsync_parent(path: Path) -> None:
    try:
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
    except OSError:
        return

    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _read_image_unicode(path: Path, flags: int) -> np.ndarray | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if not data:
        return None

    buffer = np.frombuffer(data, dtype=np.uint8)
    return cv2.imdecode(buffer, flags)


def write_image_atomically(path: Path, image: np.ndarray, params: list[int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    success, encoded = cv2.imencode(_encode_extension(path), image, params)
    if not success:
        raise ValueError(f"Failed to encode image: {path}")

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='wb',
            dir=str(path.parent),
            prefix=f'.{path.name}.',
            suffix='.tmp',
            delete=False,
        ) as tmp_file:
            tmp_path = Path(tmp_file.name)
            tmp_file.write(encoded.tobytes())
            tmp_file.flush()
            os.fsync(tmp_file.fileno())

        os.replace(tmp_path, path)
        tmp_path = None
        _fsync_parent(path)
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass


def load_image_unchanged(image_path: str) -> np.ndarray:
    path = Path(image_path)

    if not path.exists():
        raise ValueError(f"Image file does not exist: {image_path}")

    image = _read_image_unicode(path, cv2.IMREAD_UNCHANGED)

    if image is None:
        raise ValueError(f"Failed to load image: {image_path}")

    return image


def load_image(image_path: str) -> np.ndarray:
    """
    Load an image from disk.

    Args:
        image_path: Path to image file (PNG, JPEG, TIFF, etc.)

    Returns:
        Image as numpy array in BGR format

    Raises:
        ValueError: If image cannot be loaded
    """
    path = Path(image_path)

    if not path.exists():
        raise ValueError(f"Image file does not exist: {image_path}")

    image = _read_image_unicode(path, cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError(f"Failed to load image: {image_path}")

    return image


def load_grayscale(image_path: str) -> np.ndarray:
    """
    Load an image as grayscale.

    Args:
        image_path: Path to image file

    Returns:
        Image as numpy array in grayscale

    Raises:
        ValueError: If image cannot be loaded
    """
    path = Path(image_path)

    if not path.exists():
        raise ValueError(f"Image file does not exist: {image_path}")

    image = _read_image_unicode(path, cv2.IMREAD_GRAYSCALE)

    if image is None:
        raise ValueError(f"Failed to load image: {image_path}")

    return image


def save_image(
    image: np.ndarray,
    output_path: str,
    quality: int = 95,
) -> str:
    """
    Save an image to disk.

    Args:
        image: Image as numpy array
        output_path: Path to save image
        quality: JPEG quality (1-100) or PNG compression (0-9)

    Returns:
        Absolute path to saved image

    Raises:
        ValueError: If image cannot be saved
    """
    path = Path(output_path)

    # Ensure parent directory exists
    path.parent.mkdir(parents=True, exist_ok=True)

    # Determine format from extension
    ext = path.suffix.lower()

    if ext in ['.jpg', '.jpeg']:
        params = [cv2.IMWRITE_JPEG_QUALITY, quality]
    elif ext == '.png':
        # For PNG, quality is compression level (0-9)
        compression = min(9, max(0, 9 - quality // 10))
        params = [cv2.IMWRITE_PNG_COMPRESSION, compression]
    elif ext in ['.tif', '.tiff']:
        params = []
    else:
        # Default to lossless PNG
        params = [cv2.IMWRITE_PNG_COMPRESSION, 3]

    write_image_atomically(path, image, params)

    return str(path.absolute())


def to_grayscale(image: np.ndarray) -> np.ndarray:
    """
    Convert image to grayscale if not already.

    Args:
        image: Input image (BGR or grayscale)

    Returns:
        Grayscale image
    """
    if len(image.shape) == 3:
        return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return image


def get_image_size(image: np.ndarray) -> Tuple[int, int]:
    """
    Get image dimensions.

    Args:
        image: Input image

    Returns:
        Tuple of (width, height)
    """
    h, w = image.shape[:2]
    return w, h


def get_aspect_ratio(image: np.ndarray) -> float:
    """
    Get image aspect ratio (width / height).

    Args:
        image: Input image

    Returns:
        Aspect ratio as float
    """
    h, w = image.shape[:2]
    return w / h


def _to_jsonable(value):
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(_to_jsonable(k)): _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]

    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _to_jsonable(item())
        except Exception:
            pass

    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        try:
            return _to_jsonable(tolist())
        except Exception:
            pass

    return value


def send_json(data: dict, stream=sys.stdout):
    """
    Send JSON data to output stream.

    Args:
        data: Dictionary to serialize
        stream: Output stream (default: stdout)
    """
    print(json.dumps(_to_jsonable(data), allow_nan=False), file=stream, flush=True)


def send_progress(stage: str, message: str, **kwargs):
    """
    Send progress update as JSON line.

    Args:
        stage: Current stage name
        message: Progress message
        **kwargs: Additional fields
    """
    send_json({
        "type": "progress",
        "stage": stage,
        "message": message,
        **kwargs
    })


def send_result(data: dict):
    """
    Send result as JSON line.

    Args:
        data: Result dictionary
    """
    send_json({"type": "result", **data})


def send_error(message: str, code: str = "UNKNOWN_ERROR"):
    """
    Send error to stderr.

    Args:
        message: Error message
        code: Error code for programmatic handling
    """
    send_json({
        "type": "error",
        "message": message,
        "code": code
    }, stream=sys.stderr)
