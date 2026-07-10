"""
Stage 3b: Dewarp Detection and Correction

Detects and corrects page curvature (warping from book spine).
Uses page_dewarp library for cubic spline-based dewarping.

This stage typically runs after deskew and before split detection.
"""

import warnings
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np

from .io import load_grayscale, load_image, save_image

try:
    from numpy.exceptions import RankWarning as NumpyRankWarning
except Exception:
    NumpyRankWarning = getattr(np, "RankWarning", Warning)

@dataclass
class DewarpResult:
    """Result of dewarp detection."""
    needs_dewarp: bool
    curvature_score: float  # 0-1, higher = more curvature
    confidence: float
    method_used: str
    tool_available: bool
    debug: dict

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dictionary."""
        return asdict(self)


def detect_dewarp(
    image_path: str,
    min_curvature: float = 0.1,
) -> DewarpResult:
    """
    Detect if page has significant curvature that needs correction.

    Uses text line curvature analysis to estimate warping.

    Args:
        image_path: Path to input image
        min_curvature: Minimum curvature score to trigger dewarping

    Returns:
        DewarpResult with curvature assessment
    """
    gray = load_grayscale(image_path)
    h, w = gray.shape

    # Detect curvature using text line analysis
    curvature_result = detect_curvature_lines(gray)
    from dewarp import is_page_dewarp_available, is_page_dewarp_module_found

    module_found = is_page_dewarp_module_found()
    tool_available = is_page_dewarp_available()
    threshold_met = bool(curvature_result['score'] >= min_curvature)

    if not threshold_met:
        reason = 'curvature_below_threshold'
    elif not module_found:
        reason = 'page_dewarp_not_installed'
    elif not tool_available:
        reason = 'page_dewarp_runtime_unavailable'
    else:
        reason = 'curvature_threshold_met'

    needs_dewarp = bool(threshold_met and tool_available)

    return DewarpResult(
        needs_dewarp=needs_dewarp,
        curvature_score=float(curvature_result['score']),
        confidence=float(curvature_result['confidence']),
        method_used='text_line_curvature',
        tool_available=bool(tool_available),
        debug={
            'curvature_score': float(curvature_result['score']),
            'num_lines_analyzed': int(curvature_result['num_lines']),
            'avg_curvature': float(curvature_result['avg_curvature']),
            'max_curvature': float(curvature_result['max_curvature']),
            'min_curvature_threshold': float(min_curvature),
            'threshold_met': bool(threshold_met),
            'page_dewarp_module_found': bool(module_found),
            'page_dewarp_available': bool(tool_available),
            'reason': reason,
            'image_size': {'width': w, 'height': h},
        }
    )


def detect_curvature_lines(gray: np.ndarray) -> dict:
    """
    Detect page curvature by analyzing text line bending.

    Args:
        gray: Grayscale image

    Returns:
        Dictionary with curvature analysis results
    """
    h, w = gray.shape
    if h < 1 or w < 1:
        return {
            'score': 0.0,
            'confidence': 0.0,
            'num_lines': 0,
            'avg_curvature': 0.0,
            'max_curvature': 0.0,
        }

    # Threshold to get binary image
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Morphological operations to connect text into lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(1, w // 20), 1))
    dilated = cv2.dilate(binary, kernel, iterations=1)

    # Find contours (text lines)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Filter for likely text lines (wide, not too tall)
    text_lines = []
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        if cw > w * 0.3 and ch < h * 0.1:  # Wide and not too tall
            text_lines.append(contour)

    if len(text_lines) < 3:
        return {
            'score': 0.0,
            'confidence': 0.0,
            'num_lines': 0,
            'avg_curvature': 0.0,
            'max_curvature': 0.0,
        }

    # Analyze curvature of each text line
    curvatures = []

    for contour in text_lines:
        # Fit a polynomial to the contour points
        points = contour.reshape(-1, 2)

        if len(points) < 10:
            continue

        # Sort by x coordinate
        sorted_indices = points[:, 0].argsort()
        points = points[sorted_indices]
        x_coords = points[:, 0].astype(np.float64)
        y_coords = points[:, 1].astype(np.float64)

        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", NumpyRankWarning)
                # Fit quadratic polynomial (parabola)
                coeffs = np.polyfit(x_coords, y_coords, 2)

            # Curvature is related to the quadratic coefficient
            # Normalize by width for scale independence
            curvature = abs(coeffs[0]) * w
            curvatures.append(curvature)
        except (NumpyRankWarning, np.linalg.LinAlgError, ValueError):
            continue

    if not curvatures:
        return {
            'score': 0.0,
            'confidence': 0.0,
            'num_lines': len(text_lines),
            'avg_curvature': 0.0,
            'max_curvature': 0.0,
        }

    # Calculate statistics
    avg_curvature = float(np.mean(curvatures))
    max_curvature = float(np.max(curvatures))

    # Normalize score to 0-1 range
    # Typical curvature values: 0-2 for flat, 2-10 for slight curve, 10+ for significant
    score = min(1.0, avg_curvature / 10)

    # Confidence based on number of lines analyzed
    confidence = min(1.0, len(curvatures) / 10)

    return {
        'score': score,
        'confidence': confidence,
        'num_lines': len(curvatures),
        'avg_curvature': avg_curvature,
        'max_curvature': max_curvature,
    }


def apply_dewarp(
    image_path: str,
    output_path: str,
) -> dict:
    """
    Apply dewarping to image using page_dewarp library.

    Args:
        image_path: Path to input image
        output_path: Path for output image

    Returns:
        Result dictionary with output path and metadata
    """
    image = load_image(image_path)
    h, w = image.shape[:2]
    from dewarp import dewarp_page_with_metadata

    output_stem = Path(output_path).stem or Path(image_path).stem or 'page'
    dewarp_result = dewarp_page_with_metadata(image, output_stem=output_stem)
    result_image = dewarp_result.image

    new_h, new_w = result_image.shape[:2]
    saved_path = save_image(result_image, output_path)

    result = {
        'success': True,
        'output_path': saved_path,
        'attempted': bool(dewarp_result.attempted),
        'tool_available': bool(dewarp_result.tool_available),
        'dewarp_applied': bool(dewarp_result.dewarp_applied),
        'changed': bool(dewarp_result.changed),
        'reason': dewarp_result.reason,
        'original_size': {'width': w, 'height': h},
        'output_size': {'width': new_w, 'height': new_h},
        'debug': dewarp_result.debug,
    }

    return result
