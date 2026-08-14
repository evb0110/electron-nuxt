#!/usr/bin/env python3
"""Create labeled 2x source/current/rescue-off comparison crops."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from measure_components import align_variant, mapped_source


ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
LABEL_SIZE = 30
# The panel header is a fixed 48px, so the bitmap fallback leaves the labels unreadable.
# Try the platform bold faces in turn and let DIAG_CROP_FONT override.
FONT_CANDIDATES = [
    os.environ.get("DIAG_CROP_FONT"),
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


def label_font() -> ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if candidate and Path(candidate).exists():
            return ImageFont.truetype(candidate, LABEL_SIZE)
    print(
        f"warning: no bold TrueType font found (set DIAG_CROP_FONT); panel labels fall back to the "
        f"default bitmap font and ignore the {LABEL_SIZE}px size",
        file=sys.stderr,
    )
    return ImageFont.load_default()


FONT = label_font()


def geometry(variant: str, output_page: int) -> dict:
    summary = json.loads((ROOT / variant / f"{variant}.pdf.summary.json").read_text())
    return summary["perPageStreamSizes"][output_page - 1]["renderGeometry"]


def expanded(box: tuple[int, int, int, int], size: tuple[int, int], x_pad: int, y_pad: int) -> tuple[int, int, int, int]:
    left, top, right, bottom = box
    return max(0, left - x_pad), max(0, top - y_pad), min(size[0], right + x_pad), min(size[1], bottom + y_pad)


def panel(label: str, crop: Image.Image) -> Image.Image:
    crop = crop.convert("L").resize((crop.width * 2, crop.height * 2), Image.Resampling.NEAREST)
    header = 48
    output = Image.new("L", (crop.width, crop.height + header), 255)
    output.paste(crop, (0, header))
    draw = ImageDraw.Draw(output)
    draw.rectangle((0, 0, output.width, header), fill=20)
    draw.text((14, 7), label, font=FONT, fill=255)
    return output


def make_crop(name: str, output_page: int, box: tuple[int, int, int, int], x_pad: int = 60, y_pad: int = 25) -> None:
    current = Image.open(ROOT / "current" / f"leaf-{output_page:02d}.png").convert("L")
    rescue_raw = Image.open(ROOT / "rescue-off" / f"leaf-{output_page:02d}.png").convert("L")
    current_geometry = geometry("current", output_page)
    rescue = align_variant(rescue_raw, geometry("rescue-off", output_page), current_geometry, current.size)
    source_page = (output_page - 1) // 2 + 1
    source_raw = Image.open(ROOT / "source" / f"source299-{source_page:02d}.png").convert("L")
    source = mapped_source(source_raw, current_geometry, current.size)
    region = expanded(box, current.size, x_pad, y_pad)
    panels = [
        panel("SOURCE GRAYSCALE", source.crop(region)),
        panel("CURRENT", current.crop(region)),
        panel("RESCUE OFF", rescue.crop(region)),
    ]
    output = Image.new("L", (sum(item.width for item in panels), max(item.height for item in panels)), 255)
    x = 0
    for item in panels:
        output.paste(item, (x, 0))
        x += item.width
    (ROOT / "crops").mkdir(parents=True, exist_ok=True)
    output.save(ROOT / "crops" / f"{name}-source-current-rescue-off-2x.png")


def main() -> None:
    # The supplied fixture has no OCR-visible Barhebraeus token. This is the
    # Chronik paragraph in the representative introduction spread.
    make_crop("chronik-paragraph", 7, (190, 430, 2010, 1010), x_pad=15, y_pad=10)
    make_crop("handschrift-main-rescue-positive", 8, (210, 592, 2001, 652), x_pad=25, y_pad=20)
    make_crop("handschrift-footnote", 8, (205, 2603, 1696, 2668), x_pad=45, y_pad=22)
    make_crop("dies-wurde-aber-weder", 8, (206, 2823, 2000, 2892), x_pad=25, y_pad=20)
    make_crop("diyarbakir-amida", 14, (266, 2915, 1904, 2972), x_pad=25, y_pad=20)


if __name__ == "__main__":
    main()
