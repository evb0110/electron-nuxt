"""
Page Splitting

Splits facing page scans (double-page spreads) into individual pages.
"""

import cv2
import numpy as np
from typing import Tuple


_IMAGE_ANALYSIS_EXCEPTIONS = (cv2.error, ValueError, TypeError, FloatingPointError, IndexError)


def _to_gray(image: np.ndarray) -> np.ndarray:
    if len(image.shape) == 3:
        return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return image


def _resize_for_analysis(gray: np.ndarray, max_dim: int = 1500) -> tuple[np.ndarray, float]:
    h, w = gray.shape[:2]
    if max(h, w) <= max_dim:
        return gray, 1.0

    scale = max_dim / float(max(h, w))
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    resized = cv2.resize(gray, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized, scale


def _smooth_1d(values: np.ndarray, kernel_size: int) -> np.ndarray:
    if values.size == 0:
        return values
    k = max(3, int(kernel_size))
    if k % 2 == 0:
        k += 1
    return cv2.GaussianBlur(values.reshape(1, -1).astype(np.float32), (k, 1), 0).reshape(-1)


def _confidence_from_valley(curve: np.ndarray, idx: int) -> float:
    if curve.size == 0:
        return 0.0
    mean_val = float(np.mean(curve))
    if not np.isfinite(mean_val) or mean_val <= 0:
        return 0.0
    min_val = float(curve[int(idx)])
    if not np.isfinite(min_val):
        return 0.0
    depth = (mean_val - min_val) / mean_val
    return float(min(1.0, max(0.0, depth * 2.0)))


def _band_edges(curve: np.ndarray, idx: int) -> tuple[int, int]:
    """
    Given a 1D curve where a gutter corresponds to a *low* region, estimate the
    contiguous low band that contains idx.

    Returns (left_idx, right_idx) inclusive.
    """
    if curve.size == 0:
        return 0, 0

    n = int(curve.size)
    idx = int(max(0, min(n - 1, idx)))

    v = curve.astype(np.float64)
    if not np.isfinite(v[idx]):
        return idx, idx

    finite = v[np.isfinite(v)]
    mean_v = float(np.mean(finite)) if finite.size > 0 else float(v[idx])
    if not np.isfinite(mean_v):
        return idx, idx

    min_v = float(v[idx])
    if mean_v <= 0 or mean_v <= min_v:
        return idx, idx

    # Threshold roughly tracks the "gutter band" width while being tolerant of noise.
    thresh = min_v + (mean_v - min_v) * 0.35
    mask = v <= thresh
    if not bool(mask[idx]):
        return idx, idx

    left = idx
    while left > 0 and bool(mask[left - 1]):
        left -= 1

    right = idx
    while right < n - 1 and bool(mask[right + 1]):
        right += 1

    return int(left), int(right)


def analyze_gutter_position(image: np.ndarray) -> dict:
    """
    Analyze the vertical gutter (fold line) position.

    Uses multiple methods:
    1. Vertical projection valley (low ink/edges)
    2. Gutter shadow band (dark vertical stripe)
    3. Fallback to center

    Args:
        image: Input image (BGR format)

    Returns:
        Dictionary with pixel/normalized gutter position and signal debug data.
    """
    h, w = image.shape[:2]

    def fallback(reason: str) -> dict:
        gutter_x = w // 2
        return {
            "gutter_x": int(gutter_x),
            "position": float(gutter_x) / float(max(1, w)),
            "confidence": 0.0,
            "method": "fallback_center",
            "debug": {
                "reason": reason,
                "image_size": {"width": int(w), "height": int(h)},
            },
        }

    if h < 1 or w < 1:
        return fallback("empty_image")

    gray = _to_gray(image)
    gray_small, scale = _resize_for_analysis(gray, max_dim=1500)
    hs, ws = gray_small.shape[:2]

    # Gutter is usually near the middle, but allow real-world off-center scans.
    # Keeping this away from extreme borders avoids mistakenly locking onto scanner edges.
    start = int(ws * 0.10)
    end = int(ws * 0.90)
    if end <= start + 10:
        return fallback("search_region_too_small")

    region = gray_small[:, start:end]
    region_w = int(region.shape[1])

    inverted = 255 - region
    proj = np.sum(inverted.astype(np.float64), axis=0)
    proj_s = _smooth_1d(proj, kernel_size=max(9, region_w // 25))

    edges = cv2.Canny(gray_small, 50, 150)
    edge_region = edges[:, start:end]
    edge_proj = np.sum((edge_region > 0).astype(np.uint8), axis=0).astype(np.float64)
    edge_s = _smooth_1d(edge_proj, kernel_size=max(9, region_w // 25))

    # Gutter shadow is often most visible in the page margins (top/bottom) where
    # there is less ink. Measure darkness there to avoid being misled by text.
    shadow_s = np.array([], dtype=np.float64)
    try:
        band_h = max(1, int(round(hs * 0.12)))
        top = region[:band_h:4, :].astype(np.float32)
        bot = region[max(0, hs - band_h)::4, :].astype(np.float32)
        if top.size > 0 and bot.size > 0:
            sample = np.concatenate([top, bot], axis=0)
        elif top.size > 0:
            sample = top
        elif bot.size > 0:
            sample = bot
        else:
            sample = region[::4, :].astype(np.float32) if hs > 4 else region.astype(np.float32)

        # Lower mean brightness => darker band (likely gutter shadow).
        shadow_curve = np.mean(sample, axis=0).astype(np.float64)
        shadow_s = _smooth_1d(shadow_curve, kernel_size=max(11, region_w // 20))
    except _IMAGE_ANALYSIS_EXCEPTIONS:
        shadow_s = np.array([], dtype=np.float64)

    def norm_low(curve: np.ndarray) -> np.ndarray:
        """Normalize where low values become high scores (0..1)."""
        if curve.size == 0:
            return np.zeros((region_w,), dtype=np.float64)
        c = curve.astype(np.float64)
        mn = float(np.min(c))
        mx = float(np.max(c))
        if not np.isfinite(mn) or not np.isfinite(mx) or mx - mn < 1e-9:
            return np.zeros_like(c, dtype=np.float64)
        return (mx - c) / (mx - mn)

    ink_score = norm_low(proj_s)
    edge_score = norm_low(edge_s)
    shadow_score = norm_low(shadow_s) if shadow_s.size > 0 else np.zeros((region_w,), dtype=np.float64)

    # If one side is mostly blank, projection valleys are not informative; lean on gutter shadow.
    left_ink = float(np.sum(proj_s[: region_w // 2])) if proj_s.size > 0 else 0.0
    right_ink = float(np.sum(proj_s[region_w // 2 :])) if proj_s.size > 0 else 0.0
    denom = max(1.0, min(left_ink, right_ink))
    asym_ratio = max(left_ink, right_ink) / denom

    if asym_ratio >= 2.5:
        # If one side is mostly blank, projection valleys are unreliable; rely more on gutter shadow.
        w_ink, w_edge, w_shadow = 0.20, 0.20, 0.60
    else:
        w_ink, w_edge, w_shadow = 0.45, 0.20, 0.35

    score = (ink_score * w_ink) + (edge_score * w_edge) + (shadow_score * w_shadow)

    # Soft prior toward center to avoid selecting scanner borders when ambiguous.
    xs = np.arange(region_w, dtype=np.float64)
    center = (region_w - 1) / 2.0
    if center > 1:
        dist = np.abs(xs - center) / center
        score = score - (dist ** 2) * 0.22

    # Hard ignore a thin band near the search region edges.
    edge_pad = max(3, region_w // 50)
    score[:edge_pad] = -np.inf
    score[-edge_pad:] = -np.inf

    idx = int(np.argmax(score))
    if not np.isfinite(float(score[idx])):
        idx = region_w // 2

    # Decide which signal to use to estimate the gutter *band* width.
    comp_ink = float(ink_score[idx]) * w_ink
    comp_edge = float(edge_score[idx]) * w_edge
    comp_shadow = float(shadow_score[idx]) * w_shadow if shadow_score.size > 0 else 0.0

    if shadow_s.size > 0 and comp_shadow >= max(comp_ink, comp_edge) + 0.05:
        band_curve = shadow_s
        method = "shadow"
    elif comp_ink >= comp_edge and proj_s.size > 0:
        band_curve = proj_s
        method = "ink_valley"
    elif edge_s.size > 0:
        band_curve = edge_s
        method = "edge_valley"
    else:
        band_curve = proj_s
        method = "ink_valley"

    # Split on the gutter itself (center of the gutter band). This produces a clean separation
    # between pages without "assigning" the whole gutter/shadow to one side.
    left_edge_idx, right_edge_idx = _band_edges(band_curve, idx)
    band_center_idx = int((int(left_edge_idx) + int(right_edge_idx)) // 2)
    split_small = start + band_center_idx
    split_small = int(np.clip(split_small, start + 1, end - 1))

    # Map back to original coordinates
    inv = 1.0 / float(scale)
    gutter_x = int(round(split_small * inv))

    # Clamp away from extreme borders (still allow off-center gutters).
    min_x = int(w * 0.03)
    max_x = int(w * 0.97)
    gutter_x = max(min_x, min(max_x, gutter_x))

    ink_conf = _confidence_from_valley(proj_s, idx)
    edge_conf = _confidence_from_valley(edge_s, idx)
    shadow_conf = _confidence_from_valley(shadow_s, idx) if shadow_s.size > 0 else 0.0
    weighted_conf = (ink_conf * w_ink) + (edge_conf * w_edge) + (shadow_conf * w_shadow)
    confidence = max(weighted_conf, ink_conf, edge_conf, shadow_conf)

    return {
        "gutter_x": int(gutter_x),
        "position": float(gutter_x) / float(max(1, w)),
        "confidence": float(min(1.0, max(0.0, confidence))),
        "method": method,
        "debug": {
            "analysis_size": {"width": int(ws), "height": int(hs)},
            "analysis_scale": float(scale),
            "search_start_x": int(start),
            "search_end_x": int(end),
            "selected_index": int(idx),
            "band_left_index": int(left_edge_idx),
            "band_right_index": int(right_edge_idx),
            "band_center_index": int(band_center_idx),
            "ink_confidence": float(ink_conf),
            "edge_confidence": float(edge_conf),
            "shadow_confidence": float(shadow_conf),
            "weighted_confidence": float(weighted_conf),
            "asymmetry_ratio": float(asym_ratio),
            "weights": {
                "ink": float(w_ink),
                "edge": float(w_edge),
                "shadow": float(w_shadow),
            },
            "image_size": {"width": int(w), "height": int(h)},
        },
    }


def find_gutter_position(image: np.ndarray) -> int:
    """
    Find the vertical gutter (fold line) position.

    Args:
        image: Input image (BGR format)

    Returns:
        X coordinate of the gutter
    """
    analysis = analyze_gutter_position(image)
    return int(analysis["gutter_x"])


def split_facing_pages(
    image: np.ndarray,
    gutter_x: int = None,
    overlap: int = 0,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Split a facing pages image into left and right pages.

    Args:
        image: Input image (BGR format)
        gutter_x: X coordinate of split (auto-detected if None)
        overlap: Pixels to include from each side of the gutter

    Returns:
        Tuple of (left_page, right_page) images
    """
    w = image.shape[1]

    if gutter_x is None:
        gutter_x = find_gutter_position(image)
    elif w > 1:
        gutter_x = max(1, min(w - 1, int(gutter_x)))
    else:
        gutter_x = 0

    overlap = max(0, int(overlap))

    # Split with optional overlap
    left_end = min(gutter_x + overlap, w)
    right_start = max(gutter_x - overlap, 0)

    left_page = image[:, :left_end].copy()
    right_page = image[:, right_start:].copy()

    return left_page, right_page
