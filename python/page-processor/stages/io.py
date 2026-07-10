"""
I/O utilities for stage processing.

Provides consistent image loading and saving with proper error handling.
"""

import json
import math
import os
import sys
import tempfile
from pathlib import Path
from typing import Tuple

import cv2
import numpy as np
from resource_policy import validate_decoded_image, validate_image_file


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
        # np.fromfile supports Unicode paths and avoids materializing an additional
        # immutable ``bytes`` copy before OpenCV decodes the compressed buffer.
        buffer = np.fromfile(str(path), dtype=np.uint8)
    except OSError:
        return None
    if buffer.size == 0:
        return None
    return cv2.imdecode(buffer, flags)


def write_image_atomically(path: Path, image: np.ndarray, params: list[int]) -> None:
    publish_image_set_atomically([(path, image, params)])


def publish_image_set_atomically(
    outputs: list[tuple[Path, np.ndarray, list[int]]],
    *,
    obsolete_paths: list[Path] | None = None,
) -> None:
    """Encode/stage a complete output set, then publish it with rollback.

    Individual renames are atomic. The rollback journal additionally guarantees
    that an exception while publishing page N restores the entire previous set.
    """
    targets = [path for path, _, _ in outputs]
    obsolete = [path for path in (obsolete_paths or []) if path not in targets]
    if len(set(targets)) != len(targets):
        raise ValueError("Output image set contains duplicate target paths")

    staged: dict[Path, Path] = {}
    backups: dict[Path, Path] = {}
    published: set[Path] = set()
    affected = list(dict.fromkeys([*targets, *obsolete]))
    try:
        # Encode and fsync every image before the first visible target changes.
        for path, image, params in outputs:
            path.parent.mkdir(parents=True, exist_ok=True)
            success, encoded = cv2.imencode(_encode_extension(path), image, params)
            if not success:
                raise ValueError(f"Failed to encode image: {path}")
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=str(path.parent),
                prefix=f".{path.name}.",
                suffix=".stage",
                delete=False,
            ) as file:
                stage_path = Path(file.name)
                file.write(encoded)
                file.flush()
                os.fsync(file.fileno())
            staged[path] = stage_path

        # Move the old set aside before publishing the new set. Backups live on
        # the same filesystem as their targets so all journal operations rename.
        for path in affected:
            if not path.exists():
                continue
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=str(path.parent),
                prefix=f".{path.name}.",
                suffix=".backup",
                delete=False,
            ) as file:
                backup_path = Path(file.name)
            backup_path.unlink()
            os.replace(path, backup_path)
            backups[path] = backup_path

        for path in targets:
            os.replace(staged[path], path)
            staged.pop(path)
            published.add(path)

        for parent in {path.parent for path in affected}:
            _fsync_parent(parent / ".")

        # Publication is committed once all targets and parent directories have
        # been synced. Backup cleanup is best-effort: a cleanup failure must not
        # enter rollback after another backup has already been deleted, because
        # that could discard the newly published target without a restorable old
        # target.
        for backup_path in backups.values():
            try:
                backup_path.unlink(missing_ok=True)
            except OSError:
                pass
        backups.clear()
    except Exception:
        for path in published:
            path.unlink(missing_ok=True)
        for path, backup_path in backups.items():
            if backup_path.exists():
                os.replace(backup_path, path)
        backups.clear()
        raise
    finally:
        for path in staged.values():
            path.unlink(missing_ok=True)
        for path in backups.values():
            path.unlink(missing_ok=True)


def load_image_unchanged(image_path: str) -> np.ndarray:
    path = Path(image_path)
    expected = validate_image_file(path)

    image = _read_image_unicode(path, cv2.IMREAD_UNCHANGED)

    if image is None:
        raise ValueError(f"Failed to load image: {image_path}")
    validate_decoded_image(image, expected=expected)
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
    expected = validate_image_file(path)

    image = _read_image_unicode(path, cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError(f"Failed to load image: {image_path}")
    validate_decoded_image(image, expected=expected)
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
    expected = validate_image_file(path)

    image = _read_image_unicode(path, cv2.IMREAD_GRAYSCALE)

    if image is None:
        raise ValueError(f"Failed to load image: {image_path}")
    validate_decoded_image(image, expected=expected)
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
