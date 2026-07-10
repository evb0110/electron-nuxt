"""
Stage-based processing modules for page processing pipeline.

Each stage has:
- detect_<stage>(image_path) -> StageResult: Run detection and return results
- apply_<stage>(image_path, output_path, params) -> dict: Apply transformation

Stages follow ScanTailor's proven workflow:
1. Rotation - Fix page orientation (0/90/180/270)
2. Split - Separate facing pages
3. Deskew - Correct skew angle
4. Dewarp - Fix perspective/curvature
"""

from importlib import import_module

# Preserve the original package-level API without eager stage imports. Eagerly
# importing ``stages.split`` while the legacy top-level ``split`` adapter imports
# ``stages.image_utils`` forms a cycle; resolving exports on first access keeps
# lightweight helpers and optional dependencies isolated.
_EXPORTS = {
    "detect_rotation": ("rotation", "detect_rotation"),
    "apply_rotation": ("rotation", "apply_rotation"),
    "RotationResult": ("rotation", "RotationResult"),
    "detect_split": ("split", "detect_split"),
    "apply_split": ("split", "apply_split"),
    "SplitResult": ("split", "SplitResult"),
    "detect_deskew": ("deskew", "detect_deskew"),
    "apply_deskew": ("deskew", "apply_deskew"),
    "DeskewResult": ("deskew", "DeskewResult"),
    "detect_dewarp": ("dewarp", "detect_dewarp"),
    "apply_dewarp": ("dewarp", "apply_dewarp"),
    "DewarpResult": ("dewarp", "DewarpResult"),
}

__all__ = list(_EXPORTS)


def __getattr__(name: str):
    try:
        module_name, attribute_name = _EXPORTS[name]
    except KeyError as error:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from error
    value = getattr(import_module(f"{__name__}.{module_name}"), attribute_name)
    globals()[name] = value
    return value
