"""
Content Cropping Module

Crops pages to content bounds, removing excessive margins.
"""

from typing import Optional

import numpy as np


def crop_to_content(
    image: np.ndarray,
    bounds: Optional[dict] = None,
    padding: int = 30,
) -> np.ndarray:
    """
    Crop image to content bounds with optional padding.

    Args:
        image: Input image (BGR format)
        bounds: Content bounds dict with x, y, width, height
                (auto-detected if None)
        padding: Pixels to add around content

    Returns:
        Cropped image
    """
    h, w = image.shape[:2]

    if bounds is None:
        # Auto-detect bounds (fast projection-based bbox; avoids cv2.findNonZero).
        from detection import detect_content_bounds

        bounds = detect_content_bounds(image)
        if bounds is None:
            return image

    # Apply padding
    x = max(0, bounds["x"] - padding)
    y = max(0, bounds["y"] - padding)
    x2 = min(w, bounds["x"] + bounds["width"] + padding)
    y2 = min(h, bounds["y"] + bounds["height"] + padding)

    return image[y:y2, x:x2].copy()
