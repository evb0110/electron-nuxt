"""
Deskew Wrapper

Applies a rotation correction given an angle. (Detection happens elsewhere.)
"""

import numpy as np

from stages.geometry import deskew_interpolation_flag, rotate_angle


def deskew_page(image: np.ndarray, angle: float = None) -> np.ndarray:
    """
    Correct page rotation (skew).

    Args:
        image: Input image (BGR format)
        angle: Rotation angle in degrees (auto-detected if None)

    Returns:
        Deskewed image
    """
    if angle is None:
        # Fallback for direct use: run our fast detector.
        from detection import detect_skew_angle

        angle = detect_skew_angle(image)

    if abs(angle) < 0.1:
        return image  # No rotation needed

    rotated = rotate_angle(
        image,
        angle,
        (255, 255, 255),
        expand=True,
        interpolation=deskew_interpolation_flag(),
    )

    return rotated
