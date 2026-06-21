"""
Dewarping Module

Removes page curvature from scanned book pages.

Uses the page-dewarp library for cubic sheet-based dewarping when it is
installed. The library is file-oriented and writes progress text to stdout, so
this module isolates all interaction with it behind temp files and captured
streams.
"""

from __future__ import annotations

import contextlib
import importlib.metadata
import importlib.util
import io
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np


IMAGE_EXTENSIONS = (".png", ".tif", ".tiff", ".jpg", ".jpeg", ".bmp")

_page_dewarp_runtime: tuple[Any, Any] | None = None
_page_dewarp_import_error: str | None = None


@dataclass
class DewarpPageResult:
    """Image plus metadata describing whether dewarp actually changed output."""

    image: np.ndarray
    attempted: bool
    tool_available: bool
    dewarp_applied: bool
    changed: bool
    reason: str
    original_size: dict
    output_size: dict
    debug: dict

    def metadata(self) -> dict:
        return {
            "attempted": self.attempted,
            "tool_available": self.tool_available,
            "dewarp_applied": self.dewarp_applied,
            "changed": self.changed,
            "reason": self.reason,
            "original_size": self.original_size,
            "output_size": self.output_size,
            "debug": self.debug,
        }


def is_page_dewarp_available() -> bool:
    """Return whether the page_dewarp runtime API can be imported."""
    return _load_page_dewarp_runtime() is not None


def is_page_dewarp_module_found() -> bool:
    """Return whether the page_dewarp package can be found without importing it."""
    return importlib.util.find_spec("page_dewarp") is not None


def _page_dewarp_version() -> str | None:
    try:
        return importlib.metadata.version("page-dewarp")
    except Exception:
        return None


def _load_page_dewarp_runtime() -> tuple[Any, Any] | None:
    """Import page_dewarp's programmatic API only when dewarp is requested."""
    global _page_dewarp_runtime, _page_dewarp_import_error

    if _page_dewarp_runtime is not None:
        return _page_dewarp_runtime
    if _page_dewarp_import_error is not None:
        return None

    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            from page_dewarp.image import WarpedImage  # type: ignore
            from page_dewarp.options import Config  # type: ignore

        _page_dewarp_runtime = (WarpedImage, Config)
        return _page_dewarp_runtime
    except Exception as exc:
        _page_dewarp_import_error = f"{type(exc).__name__}: {exc}"
        return None


def _image_size(image: np.ndarray) -> dict:
    h, w = image.shape[:2]
    return {"width": int(w), "height": int(h)}


def _safe_stem(stem: str) -> str:
    cleaned = "".join(
        ch if ch.isalnum() or ch in {"-", "_"} else "_"
        for ch in stem
    ).strip("._")
    return cleaned or "page"


def _bounded_text(text: str, limit: int = 4000) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}... [truncated {len(text) - limit} chars]"


@contextlib.contextmanager
def _temporary_cwd(path: Path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def _config_fields(config_cls: Any) -> set[str]:
    return set(getattr(config_cls, "__struct_fields__", ()) or ())


def _make_page_dewarp_config(config_cls: Any, output_dir: Path) -> tuple[Any, dict]:
    fields = _config_fields(config_cls)
    updates: dict[str, Any] = {
        "DEBUG_LEVEL": 0,
        "NO_BINARY": 1,
        "USE_BATCH": "off",
    }

    if "DEBUG_DEST" in fields:
        updates["DEBUG_DEST"] = "file"
    if "DEBUG_OUTPUT" in fields:
        updates["DEBUG_OUTPUT"] = "file"
    if "OUTPUT_DIR" in fields:
        updates["OUTPUT_DIR"] = str(output_dir)
    if "OUTPUT_FORMAT" in fields:
        updates["OUTPUT_FORMAT"] = "png"
    if "OUTPUT_JSON" in fields:
        updates["OUTPUT_JSON"] = 0

    supported_updates = {key: value for key, value in updates.items() if key in fields}
    debug = {
        "config_fields": sorted(fields),
        "config_updates": supported_updates,
        "output_dir_configured": "OUTPUT_DIR" in supported_updates,
        "no_binary_requested": "NO_BINARY" in supported_updates,
    }

    try:
        return config_cls(**supported_updates), debug
    except Exception as construct_error:
        config = config_cls()
        applied: dict[str, Any] = {}
        failed: dict[str, str] = {}
        for key, value in supported_updates.items():
            try:
                setattr(config, key, value)
                applied[key] = value
            except Exception as exc:
                failed[key] = f"{type(exc).__name__}: {exc}"
        debug["config_construct_error"] = f"{type(construct_error).__name__}: {construct_error}"
        debug["config_updates"] = applied
        if failed:
            debug["config_update_failures"] = failed
        return config, debug


def _binary_like(image: np.ndarray) -> bool:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
    unique_values = np.unique(gray)
    if len(unique_values) > 2:
        return False
    return all(int(value) in {0, 255} for value in unique_values)


def _output_changed(original: np.ndarray, result: np.ndarray) -> bool:
    if original.shape != result.shape or original.dtype != result.dtype:
        return True
    return not np.array_equal(original, result)


def _candidate_output_paths(
    tmpdir: Path,
    output_stem: str,
    processed_image: Any,
    input_path: Path,
) -> list[Path]:
    candidates: list[Path] = []

    outfile = getattr(processed_image, "outfile", None)
    if outfile:
        outfile_path = Path(outfile)
        if not outfile_path.is_absolute():
            outfile_path = tmpdir / outfile_path
        candidates.append(outfile_path)

    for ext in IMAGE_EXTENSIONS:
        candidates.append(tmpdir / f"{output_stem}_thresh{ext}")
        candidates.append(tmpdir / f"{output_stem}_dewarped{ext}")

    for path in sorted(tmpdir.iterdir()):
        if path == input_path or not path.is_file():
            continue
        if path.suffix.lower() in IMAGE_EXTENSIONS and path not in candidates:
            candidates.append(path)

    return candidates


def _read_first_output(
    tmpdir: Path,
    output_stem: str,
    processed_image: Any,
    input_path: Path,
) -> tuple[np.ndarray | None, Path | None, list[str]]:
    seen: set[Path] = set()
    existing: list[str] = []

    for candidate in _candidate_output_paths(tmpdir, output_stem, processed_image, input_path):
        candidate = candidate.resolve()
        if candidate in seen:
            continue
        seen.add(candidate)
        if not candidate.exists() or candidate == input_path.resolve():
            continue
        existing.append(str(candidate))
        result = cv2.imread(str(candidate), cv2.IMREAD_COLOR)
        if result is not None:
            return result, candidate, existing

    return None, None, existing


def _no_output_reason(stdout_text: str) -> str:
    lowered = stdout_text.lower()
    if "skipping" in lowered and "spans" in lowered:
        return "page_dewarp_skipped_insufficient_spans"
    return "page_dewarp_produced_no_output"


def _original_result(image: np.ndarray, reason: str, *, attempted: bool, debug: dict) -> DewarpPageResult:
    size = _image_size(image)
    tool_available = debug.get("page_dewarp_available")
    if tool_available is None:
        tool_available = is_page_dewarp_available()
    return DewarpPageResult(
        image=image,
        attempted=attempted,
        tool_available=bool(tool_available),
        dewarp_applied=False,
        changed=False,
        reason=reason,
        original_size=size,
        output_size=size,
        debug=debug,
    )


def dewarp_page_with_metadata(
    image: np.ndarray,
    output_stem: str = "page",
) -> DewarpPageResult:
    """
    Remove page curvature and report whether the output was actually used.

    page-dewarp writes its output to disk and prints progress to stdout. This
    function captures stdout/stderr so the page processor's JSON-lines protocol
    remains clean.
    """
    original_size = _image_size(image)
    output_stem = _safe_stem(output_stem)
    module_found = is_page_dewarp_module_found()
    tool_available = is_page_dewarp_available()
    debug: dict[str, Any] = {
        "page_dewarp_module_found": module_found,
        "page_dewarp_available": tool_available,
        "page_dewarp_version": _page_dewarp_version(),
        "output_stem": output_stem,
    }
    if _page_dewarp_import_error is not None:
        debug["page_dewarp_import_error"] = _page_dewarp_import_error

    if not tool_available:
        return _original_result(
            image,
            "page_dewarp_runtime_unavailable" if module_found else "page_dewarp_not_installed",
            attempted=False,
            debug=debug,
        )

    with tempfile.TemporaryDirectory(prefix="evb-page-dewarp-") as tmp:
        tmpdir = Path(tmp)
        input_path = tmpdir / f"{output_stem}.png"
        debug["temp_dir"] = str(tmpdir)
        debug["input_temp_path"] = str(input_path)

        if not cv2.imwrite(str(input_path), image):
            return _original_result(
                image,
                "temp_input_write_failed",
                attempted=False,
                debug=debug,
            )

        stdout_buffer = io.StringIO()
        stderr_buffer = io.StringIO()

        try:
            with (
                contextlib.redirect_stdout(stdout_buffer),
                contextlib.redirect_stderr(stderr_buffer),
                _temporary_cwd(tmpdir),
            ):
                runtime = _load_page_dewarp_runtime()
                if runtime is None:
                    raise RuntimeError(_page_dewarp_import_error or "page_dewarp import failed")

                WarpedImage, Config = runtime
                config, config_debug = _make_page_dewarp_config(Config, tmpdir)
                debug.update(config_debug)
                processed_image = WarpedImage(str(input_path), config=config)

            stdout_text = stdout_buffer.getvalue()
            stderr_text = stderr_buffer.getvalue()
            debug["captured_stdout"] = _bounded_text(stdout_text)
            debug["captured_stderr"] = _bounded_text(stderr_text)
            debug["page_dewarp_written"] = bool(getattr(processed_image, "written", False))
            debug["page_dewarp_outfile"] = str(getattr(processed_image, "outfile", "") or "")

            result_image, output_path, existing_outputs = _read_first_output(
                tmpdir,
                output_stem,
                processed_image,
                input_path,
            )
            debug["existing_outputs"] = existing_outputs
            debug["selected_output_path"] = str(output_path) if output_path else None

            if result_image is None:
                return _original_result(
                    image,
                    _no_output_reason(stdout_text),
                    attempted=True,
                    debug=debug,
                )

            changed = _output_changed(image, result_image)
            output_size = _image_size(result_image)
            debug["binary_like_output"] = _binary_like(result_image)

            if not changed:
                return DewarpPageResult(
                    image=image,
                    attempted=True,
                    tool_available=True,
                    dewarp_applied=False,
                    changed=False,
                    reason="page_dewarp_output_unchanged",
                    original_size=original_size,
                    output_size=original_size,
                    debug=debug,
                )

            return DewarpPageResult(
                image=result_image,
                attempted=True,
                tool_available=True,
                dewarp_applied=True,
                changed=True,
                reason="page_dewarp_output_changed",
                original_size=original_size,
                output_size=output_size,
                debug=debug,
            )

        except Exception as exc:
            debug["captured_stdout"] = _bounded_text(stdout_buffer.getvalue())
            debug["captured_stderr"] = _bounded_text(stderr_buffer.getvalue())
            debug["exception_type"] = type(exc).__name__
            debug["exception"] = str(exc)
            return _original_result(
                image,
                "page_dewarp_failed",
                attempted=True,
                debug=debug,
            )


def dewarp_page(image: np.ndarray) -> np.ndarray:
    """
    Remove page curvature (dewarping).

    Args:
        image: Input image (BGR format)

    Returns:
        Dewarped image, or the original image when dewarping is unavailable,
        fails, or produces no changed output.
    """
    return dewarp_page_with_metadata(image).image


def order_points(pts: np.ndarray) -> np.ndarray:
    """
    Order points in clockwise order: top-left, top-right, bottom-right, bottom-left.
    """
    rect = np.zeros((4, 2), dtype=np.float32)

    # Top-left has smallest sum, bottom-right has largest sum
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]

    # Top-right has smallest difference, bottom-left has largest difference
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]

    return rect
