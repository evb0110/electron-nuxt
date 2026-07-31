#!/usr/bin/env python3
"""Ground-truth audit for the compact synthetic scan-cleanup PDF."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-pdf", required=True, type=Path)
    parser.add_argument("--output-pdf", required=True, type=Path)
    parser.add_argument("--fixture-spec", required=True, type=Path)
    parser.add_argument("--metadata-dir", required=True, type=Path)
    parser.add_argument(
        "--analysis-metadata-dir",
        type=Path,
        help=(
            "Optional directory containing analysis-N.json classifier evidence. "
            "Final output transforms are always read from --metadata-dir."
        ),
    )
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--dpi", default=200, type=int)
    return parser.parse_args()


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def run_text(command: list[str]) -> str:
    return subprocess.run(
        command,
        check=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout


def rasterize(pdf: Path, dpi: int, prefix: Path) -> list[Path]:
    run(["pdftoppm", "-r", str(dpi), "-png", str(pdf), str(prefix)])
    return sorted(
        prefix.parent.glob(f"{prefix.name}-*.png"),
        key=lambda path: int(path.stem.rsplit("-", 1)[1]),
    )


def rasterize_fixture_sources(
    pdf: Path,
    pages: list[dict[str, Any]],
    temporary_path: Path,
) -> list[Path]:
    paths: list[Path] = []
    for page_number, page_spec in enumerate(pages, start=1):
        prefix = temporary_path / f"source-page-{page_number}"
        run([
            "pdftoppm",
            "-f",
            str(page_number),
            "-l",
            str(page_number),
            "-r",
            str(int(page_spec["sourceDpi"])),
            "-png",
            str(pdf),
            str(prefix),
        ])
        matches = list(prefix.parent.glob(f"{prefix.name}-*.png"))
        if len(matches) != 1:
            raise RuntimeError(
                f"Could not rasterize synthetic source page {page_number}"
            )
        paths.append(matches[0])
    return paths


def native_artifact_paths(
    metadata_dir: Path,
    pages: list[dict[str, Any]],
) -> tuple[list[Path], dict[int, int]] | None:
    listing_path = metadata_dir / "pdfimages-list.txt"
    if not listing_path.is_file():
        return None
    primary_image_by_page: dict[int, int] = {}
    for line in listing_path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) < 3 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        page_number = int(parts[0])
        if parts[2] == "image" and page_number not in primary_image_by_page:
            primary_image_by_page[page_number] = int(parts[1])
    source_paths: list[Path] = []
    for page_number, page_spec in enumerate(pages, start=1):
        source_dpi = int(page_spec.get("sourceDpi", 0))
        matches = sorted(metadata_dir.glob(f"source-{page_number}-{source_dpi}dpi*.png"))
        if len(matches) != 1:
            return None
        if page_number not in primary_image_by_page:
            return None
        source_paths.append(matches[0])
    return source_paths, primary_image_by_page


def primary_image_numbers(pdf: Path) -> dict[int, int]:
    primary_image_by_page: dict[int, int] = {}
    for line in run_text(["pdfimages", "-list", str(pdf)]).splitlines():
        parts = line.split()
        if len(parts) < 3 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        page_number = int(parts[0])
        if parts[2] == "image" and page_number not in primary_image_by_page:
            primary_image_by_page[page_number] = int(parts[1])
    return primary_image_by_page


def embedded_page_images(
    pdf: Path,
    page_count: int,
    temporary_path: Path,
    name: str,
) -> list[Path] | None:
    primary_image_by_page = primary_image_numbers(pdf)
    if set(primary_image_by_page) != set(range(1, page_count + 1)):
        return None
    prefix = temporary_path / name
    run(["pdfimages", "-png", str(pdf), str(prefix)])
    paths = [
        prefix.parent / f"{prefix.name}-{primary_image_by_page[page]:03d}.png"
        for page in range(1, page_count + 1)
    ]
    return paths if all(path.is_file() for path in paths) else None


def extracted_output_paths(
    output_pdf: Path,
    metadata_dir: Path,
    primary_image_by_page: dict[int, int],
    temporary_path: Path,
) -> list[Path]:
    existing = [
        metadata_dir / f"extracted-{primary_image_by_page[page]:03d}.png"
        for page in sorted(primary_image_by_page)
    ]
    if all(path.is_file() for path in existing):
        return existing
    prefix = temporary_path / "embedded-output"
    run(["pdfimages", "-png", str(output_pdf), str(prefix)])
    extracted = [
        prefix.parent / f"{prefix.name}-{primary_image_by_page[page]:03d}.png"
        for page in sorted(primary_image_by_page)
    ]
    if not all(path.is_file() for path in extracted):
        raise RuntimeError("Could not extract every synthetic output page image")
    return extracted


def compose_layered_output(
    background: Image.Image,
    metadata_dir: Path,
    page_number: int,
    mode: str,
) -> Image.Image:
    """Reconstruct the pixels a PDF viewer displays for an MRC Mixed page.

    `pdfimages` exposes the continuous-tone plate as the page's primary image.
    Treating that plate as the published page made the verifier grade JPEG
    speckles as missing text and completely ignored the separate foreground.
    Mixed output uses either a bilevel mask or an eight-bit soft-alpha plane as
    its authoritative text representation.
    """

    if mode != "mixed":
        return background.convert("RGB")
    alpha_path = metadata_dir / f"clean-{page_number}-0-alpha.pgm"
    mask_path = metadata_dir / f"clean-{page_number}-0-mask.pbm"
    foreground_path = alpha_path if alpha_path.is_file() else mask_path
    if not foreground_path.is_file():
        raise RuntimeError(
            f"Mixed output page {page_number} has no foreground mask or alpha artifact"
        )
    with Image.open(foreground_path) as foreground_file:
        foreground = foreground_file.convert("L")
    composite = background.convert("RGB")
    if composite.size != foreground.size:
        composite = composite.resize(foreground.size, Image.Resampling.LANCZOS)
    if foreground_path == mask_path:
        foreground = foreground.point(lambda value: 255 if value < 128 else 0)
    composite.paste((0, 0, 0), mask=foreground)
    return composite


def percentile(histogram: list[int], fraction: float) -> int:
    total = sum(histogram)
    rank = round(max(0, total - 1) * fraction)
    cumulative = 0
    for value, count in enumerate(histogram):
        cumulative += count
        if cumulative > rank:
            return value
    return 255


def color_distance_mask(image: Image.Image, color: list[int], tolerance: int) -> Image.Image:
    red, green, blue = image.convert("RGB").split()
    differences = [
        ImageChops.difference(channel, Image.new("L", image.size, expected))
        for channel, expected in zip((red, green, blue), color, strict=True)
    ]
    maximum = ImageChops.lighter(
        ImageChops.lighter(differences[0], differences[1]),
        differences[2],
    )
    return maximum.point(lambda value: 255 if value <= tolerance else 0)


def region_box(region: dict[str, Any], scale_x: float, scale_y: float) -> tuple[int, int, int, int]:
    left = round(float(region["x"]) * scale_x)
    top = round(float(region["y"]) * scale_y)
    right = round((float(region["x"]) + float(region["width"])) * scale_x)
    bottom = round((float(region["y"]) + float(region["height"])) * scale_y)
    return left, top, right, bottom


def region_mask(
    size: tuple[int, int],
    regions: list[dict[str, Any]],
    scale_x: float,
    scale_y: float,
) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for region in regions:
        box = region_box(region, scale_x, scale_y)
        if region.get("shape") == "ellipse":
            rotation = float(region.get("rotationRadians", 0.0))
            if abs(rotation) < 1e-9:
                draw.ellipse(box, fill=255)
            else:
                center_x = (box[0] + box[2]) / 2
                center_y = (box[1] + box[3]) / 2
                radius_x = (box[2] - box[0]) / 2
                radius_y = (box[3] - box[1]) / 2
                cosine = math.cos(rotation)
                sine = math.sin(rotation)
                points = []
                for index in range(180):
                    angle = index / 180 * math.tau
                    local_x = radius_x * math.cos(angle)
                    local_y = radius_y * math.sin(angle)
                    points.append((
                        round(center_x + local_x * cosine - local_y * sine),
                        round(center_y + local_x * sine + local_y * cosine),
                    ))
                draw.polygon(points, fill=255)
        else:
            draw.rectangle(box, fill=255)
    return mask


def align_output_to_source(
    output: Image.Image,
    metadata: dict[str, Any],
    source_size: tuple[int, int],
) -> Image.Image:
    canvas_width = max(1.0, float(metadata["canvasWidthPx"]))
    canvas_height = max(1.0, float(metadata["canvasHeightPx"]))
    output_scale_x = output.width / canvas_width
    output_scale_y = output.height / canvas_height
    left = round(float(metadata["placementOffsetXPx"]) * output_scale_x)
    top = round(float(metadata["placementOffsetYPx"]) * output_scale_y)
    width = round(float(metadata["matchedCanvasContentWidthPx"]) * output_scale_x)
    height = round(float(metadata["matchedCanvasContentHeightPx"]) * output_scale_y)
    content = output.convert("RGB").crop((left, top, left + width, top + height))

    input_width = max(1.0, float(metadata["inputWidthPx"]))
    input_height = max(1.0, float(metadata["inputHeightPx"]))
    source_scale_x = source_size[0] / input_width
    source_scale_y = source_size[1] / input_height
    crop = metadata["cropRect"]
    target_width = max(1, round(float(crop["widthPx"]) * source_scale_x))
    target_height = max(1, round(float(crop["heightPx"]) * source_scale_y))
    content = content.resize((target_width, target_height), Image.Resampling.LANCZOS)
    aligned = Image.new("RGB", source_size, "white")
    aligned.paste(
        content,
        (
            round(float(crop["xPx"]) * source_scale_x),
            round(float(crop["yPx"]) * source_scale_y),
        ),
    )
    return aligned


def align_source_to_output(
    source: Image.Image,
    metadata: dict[str, Any],
    output_size: tuple[int, int],
    *,
    fill: str | int,
    resample: Image.Resampling = Image.Resampling.LANCZOS,
) -> Image.Image:
    input_width = max(1.0, float(metadata["inputWidthPx"]))
    input_height = max(1.0, float(metadata["inputHeightPx"]))
    source_scale_x = source.width / input_width
    source_scale_y = source.height / input_height
    crop = metadata["cropRect"]
    crop_box = (
        round(float(crop["xPx"]) * source_scale_x),
        round(float(crop["yPx"]) * source_scale_y),
        round((float(crop["xPx"]) + float(crop["widthPx"])) * source_scale_x),
        round((float(crop["yPx"]) + float(crop["heightPx"])) * source_scale_y),
    )
    content = source.crop(crop_box)

    canvas_width = max(1.0, float(metadata["canvasWidthPx"]))
    canvas_height = max(1.0, float(metadata["canvasHeightPx"]))
    output_scale_x = output_size[0] / canvas_width
    output_scale_y = output_size[1] / canvas_height
    target_width = max(
        1,
        round(float(metadata["matchedCanvasContentWidthPx"]) * output_scale_x),
    )
    target_height = max(
        1,
        round(float(metadata["matchedCanvasContentHeightPx"]) * output_scale_y),
    )
    content = content.resize((target_width, target_height), resample)
    aligned = Image.new(source.mode, output_size, fill)
    aligned.paste(
        content,
        (
            round(float(metadata["placementOffsetXPx"]) * output_scale_x),
            round(float(metadata["placementOffsetYPx"]) * output_scale_y),
        ),
    )
    return aligned


def chroma_image(image: Image.Image) -> Image.Image:
    channels = image.convert("RGB").split()
    maximum = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    minimum = ImageChops.darker(ImageChops.darker(channels[0], channels[1]), channels[2])
    return ImageChops.subtract(maximum, minimum)


def independent_color_evidence_mask(
    source: Image.Image,
    region: Image.Image,
    paper_color: list[int],
    ink_color: list[int],
) -> Image.Image:
    """Select color that cannot be explained by tinted paper and its ink.

    Measuring the whole declared region made whitening the tinted paper inside
    a hollow seal look like lost seal chroma. The cleanup contract is to remove
    that paper tint while retaining the independent object, so the audit must
    grade only the source pixels that establish independent color.
    """

    pixels = np.asarray(source.convert("RGB"), dtype=np.float32)
    paper = np.asarray(paper_color, dtype=np.float32)
    ink = np.asarray(ink_color, dtype=np.float32)
    direction = ink - paper
    length_squared = max(1.0, float(np.dot(direction, direction)))
    offset = pixels - paper
    projection = np.sum(offset * direction, axis=2) / length_squared
    closest = paper + np.clip(projection, -0.08, 1.20)[..., np.newaxis] * direction
    residual = np.linalg.norm(pixels - closest, axis=2)
    maximum = pixels.max(axis=2)
    minimum = pixels.min(axis=2)
    chroma = maximum - minimum
    saturation = chroma / np.maximum(1.0, maximum)
    region_values = np.asarray(region.convert("L"), dtype=np.uint8) > 0
    independent = (
        region_values
        & (
            (projection < -0.08)
            | (projection > 1.20)
            | (residual > 24.0)
        )
        & (chroma >= 18.0)
        & (saturation >= 0.08)
    )
    return Image.fromarray(np.where(independent, 255, 0).astype(np.uint8), mode="L")


def masked_mean(image: Image.Image, mask: Image.Image) -> float:
    histogram = image.histogram(mask=mask)
    count = sum(histogram)
    return sum(value * frequency for value, frequency in enumerate(histogram)) / max(1, count)


def masked_percentile(image: Image.Image, mask: Image.Image, fraction: float) -> int:
    return percentile(image.convert("L").histogram(mask=mask), fraction)


def threshold_mask(image: Image.Image, predicate) -> Image.Image:
    return image.convert("L").point(lambda value: 255 if predicate(value) else 0)


def coverage_from_exact_mask(page_spec: dict[str, Any], size: tuple[int, int]) -> Image.Image | None:
    mask_path = page_spec.get("groundTruth", {}).get("inkMaskPath")
    if not mask_path:
        return None
    with Image.open(mask_path) as mask_file:
        mask = mask_file.convert("L")
    if mask.size != size:
        mask = mask.resize(size, Image.Resampling.LANCZOS)
    return ImageOps.invert(mask)


def transfer_diagnostics(
    coverage: Image.Image,
    output_gray: Image.Image,
    allowed: Image.Image,
) -> dict[str, Any]:
    paper_mask = ImageChops.multiply(
        threshold_mask(coverage, lambda value: value <= 5),
        allowed,
    )
    core_mask = ImageChops.multiply(
        threshold_mask(coverage, lambda value: value >= 230),
        allowed,
    )
    midpoint_mask = ImageChops.multiply(
        threshold_mask(coverage, lambda value: 112 <= value <= 143),
        allowed,
    )
    paper_level = masked_percentile(output_gray, paper_mask, 0.50)
    core_level = masked_percentile(output_gray, core_mask, 0.50)
    midpoint_level = masked_percentile(output_gray, midpoint_mask, 0.50)
    if mask_area(midpoint_mask) == 0:
        midpoint_level = round((paper_level + core_level) / 2)

    bin_medians: list[dict[str, int]] = []
    for low in range(0, 256, 16):
        high = min(255, low + 15)
        band = ImageChops.multiply(
            threshold_mask(coverage, lambda value, low=low, high=high: low <= value <= high),
            allowed,
        )
        if mask_area(band) < 20:
            continue
        bin_medians.append({
            "alpha": round((low + high) / 2),
            "output": masked_percentile(output_gray, band, 0.50),
        })
    inversions = sum(
        current["output"] > previous["output"] + 3
        for previous, current in zip(bin_medians, bin_medians[1:])
    )
    correlation = pearson_correlation(
        [sample["alpha"] for sample in bin_medians],
        [sample["output"] for sample in bin_medians],
    )
    return {
        "coreLevel": core_level,
        "coverageOutputCorrelation": correlation,
        "midpointLevel": midpoint_level,
        "monotonicInversions": inversions,
        "paperLevel": paper_level,
        "samples": bin_medians,
    }


def pearson_correlation(left: list[int], right: list[int]) -> float | None:
    if len(left) < 3 or len(left) != len(right):
        return None
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    covariance = sum(
        (left_value - left_mean) * (right_value - right_mean)
        for left_value, right_value in zip(left, right, strict=True)
    )
    left_variance = sum((value - left_mean) ** 2 for value in left)
    right_variance = sum((value - right_mean) ** 2 for value in right)
    denominator = math.sqrt(left_variance * right_variance)
    return None if denominator == 0 else covariance / denominator


def infer_output_coverage(
    output_gray: Image.Image,
    transfer: dict[str, Any],
) -> Image.Image:
    """Undo the measured monotone tone curve without binarizing glyph edges."""

    samples = [
        (0.0, float(transfer["paperLevel"])),
        *[
            (float(sample["alpha"]), float(sample["output"]))
            for sample in transfer["samples"]
        ],
        (255.0, float(transfer["coreLevel"])),
    ]
    samples.sort()

    # Pool-adjacent-violators: output luminance must be non-increasing as ink
    # coverage rises. JPEG ringing may locally invert two narrow alpha bins;
    # fitting the closest monotone transfer keeps that noise from redefining a
    # glyph while retaining genuinely nonlinear text darkening.
    blocks: list[dict[str, float]] = []
    for alpha, output in samples:
        blocks.append({
            "alphaFirst": alpha,
            "alphaLast": alpha,
            "output": output,
            "weight": 1.0,
        })
        while len(blocks) >= 2 and blocks[-2]["output"] < blocks[-1]["output"]:
            right = blocks.pop()
            left = blocks.pop()
            weight = left["weight"] + right["weight"]
            blocks.append({
                "alphaFirst": left["alphaFirst"],
                "alphaLast": right["alphaLast"],
                "output": (
                    left["output"] * left["weight"]
                    + right["output"] * right["weight"]
                ) / weight,
                "weight": weight,
            })
    fitted_alpha: list[float] = []
    fitted_output: list[float] = []
    for block in blocks:
        fitted_alpha.extend([block["alphaFirst"], block["alphaLast"]])
        fitted_output.extend([block["output"], block["output"]])
    alpha_grid = np.arange(256, dtype=np.float32)
    output_by_alpha = np.interp(alpha_grid, fitted_alpha, fitted_output)
    inverse_lut = np.abs(
        np.arange(256, dtype=np.float32)[:, np.newaxis]
        - output_by_alpha[np.newaxis, :]
    ).argmin(axis=1).astype(np.uint8)
    output_values = np.asarray(output_gray.convert("L"), dtype=np.uint8)
    return Image.fromarray(inverse_lut[output_values])


def source_artifact_coverage(
    source: Image.Image,
    paper_color: list[int],
    ink_color: list[int],
) -> Image.Image:
    """Estimate coverage in the raster the PDF actually supplies to cleanup."""

    paper = np.asarray(paper_color, dtype=np.float32)
    ink = np.asarray(ink_color, dtype=np.float32)
    direction = np.maximum(0.0, paper - ink)
    direction_sum = float(direction.sum())
    if direction_sum <= 0:
        raise RuntimeError("Synthetic ink must be darker than its paper projection")
    weights = direction / direction_sum
    source_values = np.asarray(source.convert("RGB"), dtype=np.float32)
    projected = np.tensordot(source_values, weights, axes=([2], [0]))
    paper_level = float(np.dot(paper, weights))
    ink_level = float(np.dot(ink, weights))
    separation = max(1.0, paper_level - ink_level)
    coverage = np.clip((paper_level - projected) / separation, 0.0, 1.0)
    return Image.fromarray(np.rint(coverage * 255.0).astype(np.uint8), mode="L")


def soft_iou(expected: Image.Image, actual: Image.Image, allowed: Image.Image) -> float:
    expected = ImageChops.multiply(expected.convert("L"), allowed)
    actual = ImageChops.multiply(actual.convert("L"), allowed)
    bounds = ImageChops.lighter(expected, actual).getbbox()
    if bounds is None:
        return 1.0
    expected_values = np.asarray(expected.crop(bounds), dtype=np.uint8)
    actual_values = np.asarray(actual.crop(bounds), dtype=np.uint8)
    intersection = np.minimum(expected_values, actual_values).sum(dtype=np.uint64)
    union = np.maximum(expected_values, actual_values).sum(dtype=np.uint64)
    return float(intersection) / max(1, int(union))


def translated(image: Image.Image, x: int, y: int, fill: int = 0) -> Image.Image:
    return image.transform(
        image.size,
        Image.Transform.AFFINE,
        (1, 0, -x, 0, 1, -y),
        resample=Image.Resampling.NEAREST,
        fillcolor=fill,
    )


def best_integer_registration(
    expected: Image.Image,
    actual: Image.Image,
) -> tuple[Image.Image, int, int, float]:
    best = actual
    best_x = 0
    best_y = 0
    best_iou = -1.0
    expected_area = mask_area(expected)
    for y in range(-2, 3):
        for x in range(-2, 3):
            candidate = translated(actual, x, y)
            candidate_area = mask_area(candidate)
            intersection = mask_intersection_count(expected, candidate)
            union = expected_area + candidate_area - intersection
            iou = intersection / max(1, union)
            if iou > best_iou:
                best = candidate
                best_x = x
                best_y = y
                best_iou = iou
    return best, best_x, best_y, best_iou


def otsu_threshold_masked(image: Image.Image, mask: Image.Image) -> int:
    histogram = image.convert("L").histogram(mask=mask)
    total = sum(histogram)
    if total == 0:
        return 127
    weighted_total = sum(value * count for value, count in enumerate(histogram))
    background_weight = 0
    background_sum = 0
    best_threshold = 127
    best_variance = -1.0
    for threshold, count in enumerate(histogram):
        background_weight += count
        if background_weight == 0:
            continue
        foreground_weight = total - background_weight
        if foreground_weight == 0:
            break
        background_sum += threshold * count
        background_mean = background_sum / background_weight
        foreground_mean = (weighted_total - background_sum) / foreground_weight
        between_variance = (
            background_weight
            * foreground_weight
            * (background_mean - foreground_mean) ** 2
        )
        if between_variance > best_variance:
            best_variance = between_variance
            best_threshold = threshold
    return best_threshold


def relative_ink_mask(
    source: Image.Image,
    paper_color: list[int],
    ink_color: list[int],
    allowed: Image.Image,
) -> Image.Image:
    """Segment generated ink at 50% opacity without assuming gray paper.

    Projecting RGB onto the known paper-to-ink direction makes the mask
    invariant to whether the stock is gray, cream, blue, pink, or green. It
    also gives antialiased source edges one exact decision boundary instead of
    accepting any nearby dark output pixel.
    """

    direction = [
        max(0.0, float(paper) - float(ink))
        for paper, ink in zip(paper_color, ink_color, strict=True)
    ]
    direction_sum = sum(direction)
    if direction_sum <= 0:
        raise RuntimeError("Synthetic ink must be darker than its paper projection")
    weights = [component / direction_sum for component in direction]
    midpoint = sum(
        weight * (float(paper) + float(ink)) / 2.0
        for weight, paper, ink in zip(
            weights,
            paper_color,
            ink_color,
            strict=True,
        )
    )
    projection = source.convert(
        "L",
        (
            weights[0],
            weights[1],
            weights[2],
            0.0,
        ),
    )
    segmented = projection.point(lambda value: 255 if value <= midpoint else 0)
    return ImageChops.multiply(segmented, allowed)


def output_ink_mask(output: Image.Image, allowed: Image.Image) -> tuple[Image.Image, int]:
    gray = ImageOps.grayscale(output)
    # The source mask uses the generated glyph at 50% opacity. Cleanup maps the
    # paper endpoint to 255 and the ink endpoint toward zero, so 127 is the same
    # shape boundary in output space. An output-dependent Otsu threshold made
    # malformed output choose its own, more forgiving definition of a glyph.
    threshold = 127
    segmented = gray.point(lambda value: 255 if value <= threshold else 0)
    return ImageChops.multiply(segmented, allowed), threshold


def mask_area(mask: Image.Image) -> int:
    return sum(mask.histogram()[1:])


def mask_weight(mask: Image.Image) -> float:
    return sum(
        value * frequency
        for value, frequency in enumerate(mask.convert("L").histogram())
    ) / 255.0


def mask_intersection_count(left: Image.Image, right: Image.Image) -> int:
    return mask_area(ImageChops.multiply(left, right))


def shape_boundary(mask: Image.Image) -> Image.Image:
    return ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(3)))


def boundary_p95_distance(source: Image.Image, output: Image.Image, maximum: int = 8) -> int:
    source_boundary = shape_boundary(source)
    output_boundary = shape_boundary(output)

    def directed(left: Image.Image, right: Image.Image) -> int:
        left_area = mask_area(left)
        if left_area == 0:
            return maximum + 1
        expanded = right
        for radius in range(maximum + 1):
            coverage = mask_intersection_count(left, expanded) / left_area
            if coverage >= 0.95:
                return radius
            expanded = expanded.filter(ImageFilter.MaxFilter(3))
        return maximum + 1

    return max(
        directed(source_boundary, output_boundary),
        directed(output_boundary, source_boundary),
    )


def connected_components(mask: Image.Image, foreground: bool) -> tuple[int, int]:
    """Return component count and enclosed-background count for a binary mask."""

    width, height = mask.size
    pixels = mask.tobytes()
    visited = bytearray(width * height)
    components = 0
    enclosed = 0
    target_is_white = foreground
    for start in range(width * height):
        if visited[start] or ((pixels[start] != 0) != target_is_white):
            continue
        components += 1
        touches_border = False
        stack = [start]
        visited[start] = 1
        while stack:
            index = stack.pop()
            x = index % width
            y = index // width
            touches_border = touches_border or x == 0 or y == 0 or x + 1 == width or y + 1 == height
            if x > 0:
                neighbor = index - 1
                if not visited[neighbor] and ((pixels[neighbor] != 0) == target_is_white):
                    visited[neighbor] = 1
                    stack.append(neighbor)
            if x + 1 < width:
                neighbor = index + 1
                if not visited[neighbor] and ((pixels[neighbor] != 0) == target_is_white):
                    visited[neighbor] = 1
                    stack.append(neighbor)
            if y > 0:
                neighbor = index - width
                if not visited[neighbor] and ((pixels[neighbor] != 0) == target_is_white):
                    visited[neighbor] = 1
                    stack.append(neighbor)
            if y + 1 < height:
                neighbor = index + width
                if not visited[neighbor] and ((pixels[neighbor] != 0) == target_is_white):
                    visited[neighbor] = 1
                    stack.append(neighbor)
        if not foreground and not touches_border:
            enclosed += 1
    return components, enclosed


def glyph_shape_metrics(
    source: Image.Image,
    output: Image.Image,
    page_spec: dict[str, Any],
    regions: dict[str, list[dict[str, Any]]],
    fixture_width: int,
    fixture_height: int,
    exact_coverage_override: Image.Image | None = None,
    allowed_override: Image.Image | None = None,
    protected_override: Image.Image | None = None,
    evaluation_dpi: float | None = None,
    binary_output: bool = False,
) -> dict[str, Any] | None:
    if not regions["ink"]:
        return None
    comparison_size = (
        output.size
        if exact_coverage_override is not None
        else (
            int(page_spec.get("rasterWidth", fixture_width)),
            int(page_spec.get("rasterHeight", fixture_height)),
        )
    )
    source = source.resize(comparison_size, Image.Resampling.LANCZOS)
    output = output.resize(comparison_size, Image.Resampling.LANCZOS)
    allowed = (
        allowed_override
        if allowed_override is not None
        else region_mask(
            comparison_size,
            regions["ink"],
            comparison_size[0] / fixture_width,
            comparison_size[1] / fixture_height,
        )
    )
    protected = (
        protected_override
        if protected_override is not None
        else region_mask(
            comparison_size,
            [*regions["protectedTone"], *regions["independentColor"]],
            comparison_size[0] / fixture_width,
            comparison_size[1] / fixture_height,
        )
    )
    allowed = ImageChops.subtract(allowed, protected)
    exact_coverage = (
        exact_coverage_override
        if exact_coverage_override is not None
        else coverage_from_exact_mask(page_spec, comparison_size)
    )
    if exact_coverage is None:
        source_mask = relative_ink_mask(
            source,
            page_spec["paper"],
            page_spec["ink"],
            allowed,
        )
        transfer = None
        output_threshold = 127
    else:
        exact_coverage = ImageChops.multiply(exact_coverage, allowed)
        reference_coverage = source_artifact_coverage(
            source,
            page_spec["paper"],
            page_spec["ink"],
        )
        # The source and output masks must be graded over the same ownership
        # region. Without this intersection, an independent photo or seal can
        # be projected onto the paper-to-ink axis and counted as missing text
        # even though that object is deliberately owned by the Mixed plate.
        source_mask = ImageChops.multiply(
            threshold_mask(reference_coverage, lambda value: value >= 128),
            allowed,
        )
        transfer = transfer_diagnostics(
            exact_coverage,
            ImageOps.grayscale(output),
            allowed,
        )
        output_threshold = transfer["midpointLevel"]
    cleaned_mask = ImageChops.multiply(
        threshold_mask(
            ImageOps.grayscale(output),
            lambda value: value <= output_threshold,
        ),
        allowed,
    )
    cleaned_mask, shift_x, shift_y, registered_iou = best_integer_registration(
        source_mask,
        cleaned_mask,
    )
    soft_coverage_iou = None
    if transfer is not None:
        inferred_coverage = infer_output_coverage(
            ImageOps.grayscale(output),
            transfer,
        )
        inferred_coverage = translated(inferred_coverage, shift_x, shift_y)
        glyph_vicinity = threshold_mask(
            exact_coverage,
            lambda value: value >= 4,
        ).filter(ImageFilter.MaxFilter(9))
        evaluation_mask = ImageChops.multiply(allowed, glyph_vicinity)
        soft_coverage_iou = soft_iou(
            reference_coverage,
            inferred_coverage,
            evaluation_mask,
        )
    source_area = mask_area(source_mask)
    output_area = mask_area(cleaned_mask)
    intersection = mask_intersection_count(source_mask, cleaned_mask)
    union = source_area + output_area - intersection
    source_dpi = evaluation_dpi or float(page_spec.get("sourceDpi", 100))
    if binary_output:
        source_boundary_area = max(1, mask_area(shape_boundary(source_mask)))
        output_boundary_area = max(1, mask_area(shape_boundary(cleaned_mask)))
        union_bounds = ImageChops.lighter(source_mask, cleaned_mask).getbbox()
        if union_bounds is None:
            union_bounds = (0, 0, 1, 1)
        left, top, right, bottom = union_bounds
        component_bounds = (
            max(0, left - 2),
            max(0, top - 2),
            min(comparison_size[0], right + 2),
            min(comparison_size[1], bottom + 2),
        )
        source_components, _ = connected_components(source_mask.crop(component_bounds), True)
        output_components, _ = connected_components(cleaned_mask.crop(component_bounds), True)
        _, source_holes = connected_components(source_mask.crop(component_bounds), False)
        _, output_holes = connected_components(cleaned_mask.crop(component_bounds), False)
        source_stroke = 2.0 * source_area / source_boundary_area
        output_stroke = 2.0 * output_area / output_boundary_area
        boundary_distance = boundary_p95_distance(source_mask, cleaned_mask)
        stroke_width_ratio = output_stroke / max(0.001, source_stroke)
    else:
        source_components = None
        output_components = None
        source_holes = None
        output_holes = None
        boundary_distance = None
        stroke_width_ratio = None
    return {
        "boundaryP95DistancePx": boundary_distance,
        "boundaryP95DistanceAt100Dpi": (
            None
            if boundary_distance is None
            else boundary_distance * 100.0 / source_dpi
        ),
        "componentCountRatio": (
            None
            if source_components is None or output_components is None
            else output_components / max(1, source_components)
        ),
        "holeCountRatio": (
            None
            if source_holes is None or output_holes is None
            else output_holes / max(1, source_holes)
        ),
        "inkAreaRatio": output_area / max(1, source_area),
        "maskedIou": intersection / max(1, union),
        "outputComponents": output_components,
        "outputBounds": cleaned_mask.getbbox(),
        "outputHoles": output_holes,
        "outputThreshold": output_threshold,
        "registration": {
            "iou": registered_iou,
            "xPx": shift_x,
            "yPx": shift_y,
        },
        "sourceComponents": source_components,
        "sourceBounds": source_mask.getbbox(),
        "sourceHoles": source_holes,
        "softCoverageIou": soft_coverage_iou,
        "strokeWidthRatio": stroke_width_ratio,
        "transfer": transfer,
    }


def calibration_probe_metrics(
    page_spec: dict[str, Any],
    native_size: tuple[int, int],
    source: Image.Image,
    output: Image.Image,
    exact_coverage: Image.Image | None,
    metadata: dict[str, Any],
    shape_metrics: dict[str, Any] | None,
    fixture_width: int,
    fixture_height: int,
    binary_output: bool,
) -> list[dict[str, Any]]:
    probes = page_spec.get("groundTruth", {}).get("calibrationProbes", [])
    transfer = None if shape_metrics is None else shape_metrics.get("transfer")
    if not probes or exact_coverage is None or transfer is None:
        return []
    inferred = infer_output_coverage(ImageOps.grayscale(output), transfer)
    registration = shape_metrics["registration"]
    inferred = translated(inferred, registration["xPx"], registration["yPx"])
    source_coverage = source_artifact_coverage(
        source,
        page_spec["paper"],
        page_spec["ink"],
    )
    source_binary = threshold_mask(source_coverage, lambda value: value >= 128)
    output_binary = translated(
        threshold_mask(
            ImageOps.grayscale(output),
            lambda value: value <= transfer["midpointLevel"],
        ),
        registration["xPx"],
        registration["yPx"],
    )
    scale_x = native_size[0] / fixture_width
    scale_y = native_size[1] / fixture_height
    metrics: list[dict[str, Any]] = []
    for probe in probes:
        native_selection = Image.new("L", native_size, 0)
        draw = ImageDraw.Draw(native_selection)
        if probe["type"] == "bar":
            padding = 4.0
            box = (
                round((float(probe["x"]) - padding) * scale_x),
                round((float(probe["y"]) - padding) * scale_y),
                round(
                    (
                        float(probe["x"])
                        + float(probe["width"])
                        + padding
                    )
                    * scale_x
                ),
                round(
                    (
                        float(probe["y"])
                        + float(probe["height"])
                        + padding
                    )
                    * scale_y
                ),
            )
            draw.rectangle(box, fill=255)
            designed_width = float(probe["width"])
        else:
            padding = 4.0
            radius = float(probe["radius"]) + padding
            center_x = float(probe["centerX"])
            center_y = float(probe["centerY"])
            draw.ellipse(
                (
                    round((center_x - radius) * scale_x),
                    round((center_y - radius) * scale_y),
                    round((center_x + radius) * scale_x),
                    round((center_y + radius) * scale_y),
                ),
                fill=255,
            )
            designed_width = float(probe["lineWidth"])
        selection = align_source_to_output(
            native_selection,
            metadata,
            output.size,
            fill=0,
            resample=Image.Resampling.NEAREST,
        )
        probe_vicinity = threshold_mask(
            exact_coverage,
            lambda value: value >= 4,
        ).filter(ImageFilter.MaxFilter(5))
        probe_selection = ImageChops.multiply(selection, probe_vicinity)
        # The cleanup contract starts at the raster actually embedded in the
        # source PDF. JPEG ringing and resampling may already have changed a
        # synthetic design's ideal alpha mask, so comparing against that
        # pristine design would report source damage as cleanup damage. Limit
        # the comparison to the designed stroke vicinity so ordinary JPEG
        # paper noise inside the padded probe box is not counted as ink.
        expected_probe = ImageChops.multiply(source_coverage, probe_selection)
        actual_probe = ImageChops.multiply(inferred, probe_selection)
        expected_weight = mask_weight(expected_probe)
        actual_weight = mask_weight(actual_probe)
        metric: dict[str, Any] = {
            "designedWidthAt100Dpi": designed_width,
            "effectiveSourceWidthPx": (
                designed_width
                * float(page_spec.get("sourceDpi", 100))
                / 100.0
            ),
            "softCoverageIou": soft_iou(
                expected_probe,
                actual_probe,
                probe_selection,
            ),
            "type": probe["type"],
            "weightRatio": actual_weight / max(0.001, expected_weight),
        }
        if binary_output:
            expected_shape = ImageChops.multiply(source_binary, probe_selection)
            actual_shape = ImageChops.multiply(output_binary, probe_selection)
            expected_area = mask_area(expected_shape)
            actual_area = mask_area(actual_shape)
            intersection = mask_intersection_count(expected_shape, actual_shape)
            union = expected_area + actual_area - intersection
            metric["binaryShapeIou"] = intersection / max(1, union)
            metric["binaryAreaRatio"] = actual_area / max(1, expected_area)
        if probe["type"] == "ring":
            interior_radius = max(
                1.0,
                float(probe["radius"]) - float(probe["lineWidth"]) - 1.5,
            )
            native_interior = Image.new("L", native_size, 0)
            ImageDraw.Draw(native_interior).ellipse(
                (
                    round((float(probe["centerX"]) - interior_radius) * scale_x),
                    round((float(probe["centerY"]) - interior_radius) * scale_y),
                    round((float(probe["centerX"]) + interior_radius) * scale_x),
                    round((float(probe["centerY"]) + interior_radius) * scale_y),
                ),
                fill=255,
            )
            interior = align_source_to_output(
                native_interior,
                metadata,
                output.size,
                fill=0,
                resample=Image.Resampling.NEAREST,
            )
            metric["interiorMeanCoverage"] = masked_mean(inferred, interior) / 255.0
        metrics.append(metric)
    return metrics


def thumbnail_pair(source: Image.Image, output: Image.Image, label: str) -> Image.Image:
    tiles = []
    for image in (source, output):
        tile = image.convert("RGB").copy()
        tile.thumbnail((250, 330), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (258, 360), "white")
        canvas.paste(tile, ((258 - tile.width) // 2, 4))
        tiles.append(canvas)
    pair = Image.new("RGB", (516, 386), "#cccccc")
    pair.paste(tiles[0], (0, 0))
    pair.paste(tiles[1], (258, 0))
    ImageDraw.Draw(pair).text((6, 366), label, fill="black")
    return pair


def save_contact_sheet(tiles: list[Image.Image], path: Path) -> None:
    columns = 3
    rows = (len(tiles) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * 516, rows * 386), "#bdbdbd")
    for index, tile in enumerate(tiles):
        sheet.paste(tile, ((index % columns) * 516, (index // columns) * 386))
    sheet.save(path, quality=92)


def main() -> None:
    args = parse_args()
    analysis_metadata_dir = args.analysis_metadata_dir or args.metadata_dir
    if args.dpi < 150:
        raise RuntimeError("--dpi must be at least 150")
    specification = json.loads(args.fixture_spec.read_text(encoding="utf-8"))
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    page_metrics: list[dict[str, Any]] = []
    tiles: list[Image.Image] = []
    with tempfile.TemporaryDirectory(prefix="evb-synthetic-audit-") as temporary:
        temporary_path = Path(temporary)
        native_artifacts = native_artifact_paths(args.metadata_dir, specification["pages"])
        if native_artifacts is None:
            source_paths = rasterize_fixture_sources(
                args.source_pdf,
                specification["pages"],
                temporary_path,
            )
            output_paths = embedded_page_images(
                args.output_pdf,
                len(specification["pages"]),
                temporary_path,
                "output-image",
            ) or rasterize(args.output_pdf, args.dpi, temporary_path / "output")
        else:
            source_paths, primary_image_by_page = native_artifacts
            output_paths = extracted_output_paths(
                args.output_pdf,
                args.metadata_dir,
                primary_image_by_page,
                temporary_path,
            )
        if len(source_paths) != len(specification["pages"]) or len(output_paths) != len(source_paths):
            raise RuntimeError("Synthetic fixture, source, and output page counts differ")
        for page_number, (page_spec, source_path, output_path) in enumerate(
            zip(specification["pages"], source_paths, output_paths, strict=True),
            start=1,
        ):
            metadata = json.loads(
                (args.metadata_dir / f"clean-{page_number}-0.json").read_text(encoding="utf-8")
            )
            analysis = json.loads(
                (
                    analysis_metadata_dir / f"analysis-{page_number}.json"
                ).read_text(encoding="utf-8")
            )
            mode = str(analysis.get("recommendedOutputMode"))
            with Image.open(source_path) as source_file, Image.open(output_path) as output_file:
                native_source = source_file.convert("RGB")
                output = compose_layered_output(
                    output_file,
                    args.metadata_dir,
                    page_number,
                    mode,
                )
            native_scale_x = native_source.width / float(specification["width"])
            native_scale_y = native_source.height / float(specification["height"])
            regions = page_spec["groundTruth"]["regions"]
            native_protected = region_mask(
                native_source.size,
                [*regions["protectedTone"], *regions["independentColor"]],
                native_scale_x,
                native_scale_y,
            )
            native_allowed = region_mask(
                native_source.size,
                regions["ink"],
                native_scale_x,
                native_scale_y,
            )
            native_exact_coverage = coverage_from_exact_mask(
                page_spec,
                native_source.size,
            )
            source = align_source_to_output(
                native_source,
                metadata,
                output.size,
                fill="white",
            )
            protected = align_source_to_output(
                native_protected,
                metadata,
                output.size,
                fill=0,
                resample=Image.Resampling.NEAREST,
            )
            allowed = align_source_to_output(
                native_allowed,
                metadata,
                output.size,
                fill=0,
                resample=Image.Resampling.NEAREST,
            )
            page_region = align_source_to_output(
                Image.new("L", native_source.size, 255),
                metadata,
                output.size,
                fill=0,
                resample=Image.Resampling.NEAREST,
            )
            exact_coverage = (
                None
                if native_exact_coverage is None
                else align_source_to_output(
                    native_exact_coverage,
                    metadata,
                    output.size,
                    fill=0,
                )
            )
            if exact_coverage is None:
                paper = color_distance_mask(source, page_spec["paper"], 30)
                ink = color_distance_mask(source, page_spec["ink"], 32)
                required_coverage = color_distance_mask(
                    native_source,
                    page_spec["ink"],
                    32,
                )
            else:
                paper = threshold_mask(exact_coverage, lambda value: value <= 5)
                ink = threshold_mask(exact_coverage, lambda value: value >= 230)
                required_coverage = native_exact_coverage
            paper = ImageChops.multiply(paper, page_region)
            paper = ImageChops.subtract(paper, protected)
            # Exact alpha makes a two-pixel source-grid exclusion sufficient;
            # it avoids grading antialiased glyph edges as paper without the
            # old 9x9 erosion that could hide entire tiny characters.
            paper = paper.filter(ImageFilter.MinFilter(5))
            source_gray = ImageOps.grayscale(source)
            output_gray = ImageOps.grayscale(output)
            paper_histogram = output_gray.histogram(mask=paper)
            paper_pixels = max(1, sum(paper_histogram))
            paper_p05 = percentile(paper_histogram, 0.05)
            paper_below_245 = sum(paper_histogram[:245]) / paper_pixels

            ink = ImageChops.subtract(ink, protected)
            # Measure the output at the source glyph coordinates. The previous
            # 7x7 minimum filter let a dark pixel displaced by three audit
            # pixels stand in for a missing stroke, so visibly broken and
            # thickened glyphs passed as "ink retained."
            ink_histogram = output_gray.histogram(mask=ink)
            ink_pixels = sum(ink_histogram)
            ink_p90 = percentile(ink_histogram, 0.90) if ink_pixels else None
            ink_dark_fraction = (
                sum(ink_histogram[:180]) / ink_pixels if ink_pixels else None
            )

            failures: list[str] = []
            if paper_p05 < 245:
                failures.append(f"paper-p05={paper_p05}<245")
            if paper_below_245 > 0.015:
                failures.append(f"paper-below-245={paper_below_245:.4f}>0.0150")
            crop = metadata["cropRect"]
            crop_mask = Image.new("L", native_source.size, 0)
            ImageDraw.Draw(crop_mask).rectangle(
                (
                    round(
                        float(crop["xPx"])
                        * native_source.width
                        / float(metadata["inputWidthPx"])
                    ),
                    round(
                        float(crop["yPx"])
                        * native_source.height
                        / float(metadata["inputHeightPx"])
                    ),
                    round(
                        (float(crop["xPx"]) + float(crop["widthPx"]))
                        * native_source.width
                        / float(metadata["inputWidthPx"])
                    ),
                    round(
                        (float(crop["yPx"]) + float(crop["heightPx"]))
                        * native_source.height
                        / float(metadata["inputHeightPx"])
                    ),
                ),
                fill=255,
            )
            required_coverage = ImageChops.subtract(
                required_coverage,
                native_protected,
            )
            required_weight = mask_weight(required_coverage)
            cropped_weight = mask_weight(ImageChops.multiply(required_coverage, crop_mask))
            crop_loss_fraction = (
                0.0
                if required_weight == 0
                else 1.0 - cropped_weight / required_weight
            )
            if crop_loss_fraction > 0.001:
                failures.append(
                    f"required-ink-crop-loss={crop_loss_fraction:.4f}>0.0010"
                )

            binary_mode = mode == "bw" or (
                mode == "mixed"
                and metadata.get("layeredForegroundKind") != "soft-alpha"
            )
            shape_metrics = glyph_shape_metrics(
                source,
                output,
                page_spec,
                regions,
                int(specification["width"]),
                int(specification["height"]),
                exact_coverage,
                allowed,
                protected,
                float(page_spec.get("sourceDpi", 100))
                * output.width
                / native_source.width,
                binary_mode,
            )
            probe_metrics = calibration_probe_metrics(
                page_spec,
                native_source.size,
                source,
                output,
                exact_coverage,
                metadata,
                shape_metrics,
                int(specification["width"]),
                int(specification["height"]),
                binary_mode,
            )
            if shape_metrics is not None:
                if binary_mode:
                    if shape_metrics["maskedIou"] < 0.82:
                        failures.append(
                            f"shape-iou={shape_metrics['maskedIou']:.3f}<0.820"
                        )
                    if not 0.82 <= shape_metrics["inkAreaRatio"] <= 1.18:
                        failures.append(
                            f"ink-area-ratio={shape_metrics['inkAreaRatio']:.3f}"
                            " outside [0.820,1.180]"
                        )
                    if not 0.85 <= shape_metrics["strokeWidthRatio"] <= 1.15:
                        failures.append(
                            f"stroke-width-ratio={shape_metrics['strokeWidthRatio']:.3f}"
                            " outside [0.850,1.150]"
                        )
                    if shape_metrics["boundaryP95DistanceAt100Dpi"] > 1:
                        failures.append(
                            "boundary-p95-distance="
                            f"{shape_metrics['boundaryP95DistanceAt100Dpi']:.3f}"
                            "px-at-100dpi>1px"
                        )
                    if not 0.85 <= shape_metrics["componentCountRatio"] <= 1.15:
                        failures.append(
                            "component-count-ratio="
                            f"{shape_metrics['componentCountRatio']:.3f}"
                            " outside [0.850,1.150]"
                        )
                    if (
                        shape_metrics["sourceHoles"] >= 10
                        and not 0.75 <= shape_metrics["holeCountRatio"] <= 1.25
                    ):
                        failures.append(
                            f"hole-count-ratio={shape_metrics['holeCountRatio']:.3f}"
                            " outside [0.750,1.250]"
                        )
                elif (
                    shape_metrics["softCoverageIou"] is not None
                    and shape_metrics["softCoverageIou"] < 0.65
                ):
                    # Grayscale cleanup may intentionally steepen a faint
                    # paper-to-ink transfer curve. Treat that as enhancement,
                    # not loss, when the supplied raster's glyph boundary and
                    # total ink area still survive independently.
                    shape_survives = (
                        shape_metrics["maskedIou"] >= 0.82
                        and 0.80 <= shape_metrics["inkAreaRatio"] <= 1.20
                    )
                    if not shape_survives:
                        failures.append(
                            "soft-coverage-iou="
                            f"{shape_metrics['softCoverageIou']:.3f}<0.650"
                            " without preserved glyph shape"
                        )
                registration = shape_metrics["registration"]
                evaluation_dpi = (
                    float(page_spec.get("sourceDpi", 100))
                    * output.width
                    / native_source.width
                )
                normalized_shift = (
                    max(abs(registration["xPx"]), abs(registration["yPx"]))
                    * 100.0
                    / evaluation_dpi
                )
                registration["maximumShiftAt100Dpi"] = normalized_shift
                if normalized_shift > 0.75:
                    failures.append(
                        "registration-shift="
                        f"({registration['xPx']},{registration['yPx']})px"
                        f"={normalized_shift:.3f}px-at-100dpi>0.75px"
                    )
                transfer = shape_metrics.get("transfer")
                if transfer is not None:
                    if transfer["paperLevel"] < 250:
                        failures.append(
                            f"transfer-paper={transfer['paperLevel']}<250"
                        )
                    if transfer["coreLevel"] > 120:
                        failures.append(
                            f"transfer-core={transfer['coreLevel']}>120"
                        )
                    correlation = transfer["coverageOutputCorrelation"]
                    if correlation is not None and correlation > -0.80:
                        failures.append(
                            "coverage-output-correlation="
                            f"{correlation:.3f}>-0.800"
                        )
            resolvable_probes = [
                probe
                for probe in probe_metrics
                if probe["effectiveSourceWidthPx"] >= 3.0
            ]
            if resolvable_probes:
                maximum_ring_interior = max(
                    (
                        probe["interiorMeanCoverage"]
                        for probe in probe_metrics
                        if probe["type"] == "ring"
                        and probe["effectiveSourceWidthPx"] >= 1.5
                    ),
                    default=0.0,
                )
                if binary_mode:
                    minimum_probe_shape_iou = min(
                        probe["binaryShapeIou"]
                        for probe in resolvable_probes
                    )
                    minimum_probe_area = min(
                        probe["binaryAreaRatio"]
                        for probe in resolvable_probes
                    )
                    maximum_probe_area = max(
                        probe["binaryAreaRatio"]
                        for probe in resolvable_probes
                    )
                    if minimum_probe_shape_iou < 0.75:
                        failures.append(
                            "resolvable-probe-shape-iou="
                            f"{minimum_probe_shape_iou:.3f}<0.750"
                        )
                    if minimum_probe_area < 0.80:
                        failures.append(
                            "resolvable-probe-min-area="
                            f"{minimum_probe_area:.3f}<0.800"
                        )
                    if maximum_probe_area > 1.20:
                        failures.append(
                            "resolvable-probe-max-area="
                            f"{maximum_probe_area:.3f}>1.200"
                        )
                else:
                    minimum_probe_iou = min(
                        probe["softCoverageIou"]
                        for probe in resolvable_probes
                    )
                    minimum_probe_weight = min(
                        probe["weightRatio"]
                        for probe in resolvable_probes
                    )
                    maximum_probe_weight = max(
                        probe["weightRatio"]
                        for probe in resolvable_probes
                    )
                    if minimum_probe_iou < 0.45:
                        failures.append(
                            f"resolvable-probe-iou={minimum_probe_iou:.3f}<0.450"
                        )
                    if minimum_probe_weight < 0.90:
                        failures.append(
                            "resolvable-probe-min-weight="
                            f"{minimum_probe_weight:.3f}<0.900"
                        )
                    if maximum_probe_weight > 1.30:
                        failures.append(
                            "resolvable-probe-max-weight="
                            f"{maximum_probe_weight:.3f}>1.300"
                        )
                if maximum_ring_interior > 0.08:
                    failures.append(
                        "ring-interior-coverage="
                        f"{maximum_ring_interior:.3f}>0.080"
                    )

            protected_metrics = []
            for region in regions["protectedTone"]:
                native_mask = region_mask(
                    native_source.size,
                    [region],
                    native_scale_x,
                    native_scale_y,
                )
                mask = align_source_to_output(
                    native_mask,
                    metadata,
                    output.size,
                    fill=0,
                    resample=Image.Resampling.NEAREST,
                )
                source_histogram = source_gray.histogram(mask=mask)
                output_histogram = output_gray.histogram(mask=mask)
                output_pixels = max(1, sum(output_histogram))
                distinct = sum(frequency > 0 for frequency in output_histogram)
                endpoints = (output_histogram[0] + output_histogram[255]) / output_pixels
                source_range = percentile(source_histogram, 0.95) - percentile(source_histogram, 0.05)
                output_range = percentile(output_histogram, 0.95) - percentile(output_histogram, 0.05)
                range_ratio = output_range / max(1, source_range)
                protected_metrics.append({
                    "distinctGrayLevels": distinct,
                    "endpointFraction": endpoints,
                    "rangeRatio": range_ratio,
                })
                if distinct < 16:
                    failures.append(f"protected-tone-levels={distinct}<16")
                if endpoints > 0.20:
                    failures.append(f"protected-endpoints={endpoints:.3f}>0.200")
                if range_ratio < 0.40:
                    failures.append(f"protected-range-ratio={range_ratio:.3f}<0.400")

            color_metrics = []
            source_chroma = chroma_image(source)
            output_chroma = chroma_image(output)
            for region in regions["independentColor"]:
                native_mask = region_mask(
                    native_source.size,
                    [region],
                    native_scale_x,
                    native_scale_y,
                )
                mask = align_source_to_output(
                    native_mask,
                    metadata,
                    output.size,
                    fill=0,
                    resample=Image.Resampling.NEAREST,
                )
                evidence_mask = independent_color_evidence_mask(
                    source,
                    mask,
                    page_spec["paper"],
                    page_spec["ink"],
                )
                source_mean = masked_mean(source_chroma, evidence_mask)
                output_mean = masked_mean(output_chroma, evidence_mask)
                ratio = output_mean / max(1.0, source_mean)
                color_metrics.append({
                    "evidencePixels": mask_area(evidence_mask),
                    "outputMeanChroma": output_mean,
                    "retentionRatio": ratio,
                    "sourceMeanChroma": source_mean,
                })
                if mask_area(evidence_mask) == 0:
                    failures.append("independent-color-evidence=0")
                elif source_mean >= 12 and ratio < 0.55:
                    failures.append(f"color-chroma-ratio={ratio:.3f}<0.550")

            if page_spec["kind"] == "color" and mode != "color":
                failures.append(f"color-plate-mode={mode}!=color")

            page_metrics.append({
                "failures": failures,
                "id": page_spec["id"],
                "inkDarkFraction": ink_dark_fraction,
                "inkP90": ink_p90,
                "mode": mode,
                "page": page_number,
                "requiredInkCropLoss": crop_loss_fraction,
                "paperBelow245": paper_below_245,
                "paperP05": paper_p05,
                "glyphShape": shape_metrics,
                "calibrationProbes": probe_metrics,
                "protectedTone": protected_metrics,
                "independentColor": color_metrics,
            })
            tiles.append(
                thumbnail_pair(
                    source,
                    output,
                    f"p{page_number} {page_spec['id']} mode={mode} failures={len(failures)}",
                )
            )

    summary = {
        "acceptanceFailures": [
            {"page": page["page"], "id": page["id"], "failures": page["failures"]}
            for page in page_metrics
            if page["failures"]
        ],
        "pageCount": len(page_metrics),
        "sourcePdf": str(args.source_pdf.resolve()),
        "outputPdf": str(args.output_pdf.resolve()),
    }
    (args.artifact_dir / "page-metrics.json").write_text(
        json.dumps(page_metrics, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.artifact_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )
    save_contact_sheet(tiles, args.artifact_dir / "source-output-contact.jpg")
    print(json.dumps(summary, indent=2))
    if summary["acceptanceFailures"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
