"""
Stage 3: Deskew Detection and Correction

Detects and corrects page skew (small rotation angles) using:
1. Shared guardrailed Hough transform line detection
2. Shared deskew interpolation policy
"""

from dataclasses import asdict, dataclass
from typing import Tuple

import numpy as np

from .geometry import deskew_interpolation_flag, rotate_angle
from .io import load_grayscale, load_image, save_image


@dataclass
class DeskewResult:
    """Result of deskew detection."""
    angle: float  # Degrees to rotate (positive = counterclockwise)
    confidence: float  # 0-1
    method_used: str
    needs_correction: bool
    debug: dict

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dictionary."""
        return asdict(self)


def detect_deskew(
    image_path: str,
    min_angle: float = 0.5,
    max_angle: float = 15.0,
) -> DeskewResult:
    """
    Detect skew angle of page.

    Uses the same guardrailed Hough transform as the legacy processor.

    Args:
        image_path: Path to input image
        min_angle: Minimum angle threshold for correction
        max_angle: Maximum expected angle (larger angles likely errors)

    Returns:
        DeskewResult with detected angle and confidence
    """
    gray = load_grayscale(image_path)
    h, w = gray.shape

    from detection import detect_skew_angle_with_confidence

    final_angle, final_confidence, guard_debug = detect_skew_angle_with_confidence(gray, max_angle)

    # Determine if correction is needed
    needs_correction = bool(final_confidence > 0 and abs(final_angle) >= min_angle)

    # Find best method
    method_scores = {'hough_guarded': float(final_confidence)}
    best_method = 'hough_guarded' if final_confidence > 0 else 'none'

    return DeskewResult(
        angle=float(round(float(final_angle), 3)),
        confidence=float(min(1.0, final_confidence)),
        method_used=best_method,
        needs_correction=needs_correction,
        debug={
            'hough_angle': float(guard_debug.get('raw_angle', 0.0)),
            'hough_confidence': float(guard_debug.get('raw_confidence', 0.0)),
            'hough_lines_count': int(guard_debug.get('hough_lines_count', 0)),
            'hough_angle_std': float(guard_debug.get('hough_angle_std', 0.0)),
            'projection_angle': 0.0,
            'projection_confidence': 0.0,
            'projection_used': False,
            'guardrail_reason': guard_debug.get('guardrail_reason'),
            'guardrail_debug': guard_debug,
            'library_available': False,
            'library_angle': 0.0,
            'library_confidence': 0.0,
            'method_scores': {k: float(v) for k, v in method_scores.items()},
            'min_angle_threshold': float(min_angle),
            'max_angle_limit': float(max_angle),
            'image_size': {'width': w, 'height': h},
        }
    )


def detect_skew_hough(
    gray: np.ndarray,
    max_angle: float = 15.0,
) -> dict:
    """
    Detect skew using Hough line transform.

    Delegates to the legacy Hough implementation so thresholds stay aligned.

    Args:
        gray: Grayscale image
        max_angle: Maximum expected skew angle

    Returns:
        Dictionary with angle and confidence
    """
    from detection import _detect_skew_hough_details

    result = _detect_skew_hough_details(gray, max_angle)
    return {
        'angle': float(result['angle']),
        'confidence': float(result['confidence']),
        'lines_count': int(result.get('lines_count', 0)),
        'angle_std': float(result.get('angle_std', 0.0)),
    }


def apply_deskew(
    image_path: str,
    output_path: str,
    angle: float,
    background_color: Tuple[int, int, int] = (255, 255, 255),
) -> dict:
    """
    Apply deskew (rotation) to image.

    Args:
        image_path: Path to input image
        output_path: Path for output image
        angle: Rotation angle in degrees (positive = counterclockwise)
        background_color: Color for exposed corners

    Returns:
        Result dictionary with output path and metadata
    """
    image = load_image(image_path)
    h, w = image.shape[:2]

    if abs(angle) < 0.01:
        # No rotation needed
        rotated = image.copy()
        rotation_applied = False
    else:
        rotated = rotate_angle(
            image,
            angle,
            background_color,
            expand=True,
            interpolation=deskew_interpolation_flag(),
        )
        rotation_applied = True

    new_h, new_w = rotated.shape[:2]
    saved_path = save_image(rotated, output_path)

    return {
        'success': True,
        'output_path': saved_path,
        'rotation_applied': rotation_applied,
        'angle_applied': angle if rotation_applied else 0.0,
        'original_size': {'width': w, 'height': h},
        'output_size': {'width': new_w, 'height': new_h},
    }
