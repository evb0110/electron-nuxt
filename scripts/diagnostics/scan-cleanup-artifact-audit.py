#!/usr/bin/env python3
"""Measure and visually rank every page of a scan-cleanup PDF artifact.

This is intentionally an artifact-level verifier: it rasterizes the source and
the assembled output PDF, rather than trusting classifier or renderer metadata.
Pillow and Poppler's `pdfinfo`/`pdftoppm` commands are required.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import shutil
import subprocess
import tempfile
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

try:
    import numpy as np
except ModuleNotFoundError:
    np = None


@dataclass(frozen=True)
class ImageMetrics:
    p01: int
    p10: int
    p50: int
    p75: int
    p90: int
    p99: int
    white_fraction: float
    residual_gray_fraction: float
    dark_fraction: float
    relative_ink_fraction: float
    chromatic_fraction: float
    residual_chroma_p99: int
    distinct_gray_levels: int
    whole_dark_fraction: float
    whole_relative_ink_fraction: float
    whole_chromatic_fraction: float


@dataclass(frozen=True)
class CropMetrics:
    left_fraction: float
    top_fraction: float
    right_fraction: float
    bottom_fraction: float
    retained_area_fraction: float
    accepted_trim_count: int
    removed_text_evidence_count: int


@dataclass(frozen=True)
class ToneMetrics:
    coverage_fraction: float
    component_count: int
    source_p10: int
    source_p50: int
    source_p90: int
    output_p10: int
    output_p50: int
    output_p90: int
    p10_lift: int
    p50_lift: int
    range_ratio: float
    output_endpoint_fraction: float


@dataclass(frozen=True)
class SeamMetrics:
    count: int
    total_length_px: int
    longest_run_px: int
    maximum_jump: int
    dominant_single: bool = False


@dataclass(frozen=True)
class EdgeArtifactMetrics:
    boundary_depth_px: int
    introduced_black_fraction: float
    longest_column_fraction: float
    longest_row_fraction: float


@dataclass(frozen=True)
class SourceFidelityMetrics:
    mean_absolute_error: float
    p99_absolute_error: int
    new_edge_fraction: float
    new_edge_count: int


@dataclass(frozen=True)
class OwnershipMetrics:
    tone_coverage_fraction: float
    tone_source_p50: int
    tone_output_p50: int
    tone_p50_lift: int
    tone_range_ratio: float
    tone_output_endpoint_fraction: float
    tone_output_black_fraction: float
    source_ink_pixels: int
    output_ink_ratio: float
    small_component_count: int
    small_component_retention: float
    margin_small_component_count: int
    margin_small_component_retention: float
    paper_pixel_count: int
    paper_p75: int
    paper_p90: int
    zone_bright_fraction: float
    paper_residual_gray_fraction: float
    blank_largest_nonwhite_component_mm2: float
    ownership_boundary_fraction: float


@dataclass(frozen=True)
class PageAudit:
    page: int
    output_page: int
    output_index: int
    mode: str
    rule: str
    source: ImageMetrics
    output: ImageMetrics
    crop: CropMetrics | None
    tone: ToneMetrics | None
    seams: SeamMetrics
    edge_artifacts: EdgeArtifactMetrics
    tone_damage_score: float
    gray_severity: float
    white_fraction_gain: float
    dark_fraction_ratio: float
    relative_ink_fraction_ratio: float
    text_cleanup_candidate: bool
    acceptance_failures: tuple[str, ...]
    source_fidelity: SourceFidelityMetrics | None = None
    ownership: OwnershipMetrics | None = None


@dataclass(frozen=True)
class NeighborAudit:
    left_page: int
    right_page: int
    comparable: bool
    source_p75_delta: int
    source_ink_ratio: float
    output_paper_delta: int
    output_residual_gray_delta: float
    relative_ink_retention_delta: float
    acceptance_failures: tuple[str, ...]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-pdf", required=True, type=Path)
    parser.add_argument("--output-pdf", required=True, type=Path)
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
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--max-dimension-px", type=int, default=6000)
    parser.add_argument("--worst-count", type=int, default=48)
    parser.add_argument(
        "--source-pages",
        help="Comma-separated source page numbers matching output PDF order",
    )
    parser.add_argument(
        "--metadata-pages",
        help="Comma-separated metadata page numbers matching output PDF order",
    )
    return parser.parse_args()


def run(command: list[str]) -> str:
    result = subprocess.run(
        command,
        check=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout


def page_count(pdf_path: Path) -> int:
    for line in run(["pdfinfo", str(pdf_path)]).splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip())
    raise RuntimeError(f"pdfinfo did not report a page count for {pdf_path}")


def percentile(histogram: list[int], fraction: float) -> int:
    count = sum(histogram)
    rank = round(max(0, count - 1) * fraction)
    cumulative = 0
    for value, frequency in enumerate(histogram):
        cumulative += frequency
        if cumulative > rank:
            return value
    return 255


def metrics(image: Image.Image) -> ImageMetrics:
    rgb = image.convert("RGB")
    if np is not None:
        rgb_array = np.asarray(rgb, dtype=np.uint8)
        whole_gray_array = np.asarray(ImageOps.grayscale(rgb), dtype=np.uint8)
        whole_gray_histogram = np.bincount(
            whole_gray_array.reshape(-1),
            minlength=256,
        ).tolist()
        whole_total = max(1, int(whole_gray_array.size))
        whole_p50 = percentile(whole_gray_histogram, 0.50)
        whole_ink_cutoff = max(0, whole_p50 - 24)
        whole_chroma = rgb_array.max(axis=2) - rgb_array.min(axis=2)
        width, height = rgb.size
        inset_x = max(1, round(width * 0.08))
        inset_y = max(1, round(height * 0.08))
        central_rgb = rgb_array[
            inset_y:height - inset_y,
            inset_x:width - inset_x,
        ]
        central_gray = np.asarray(
            ImageOps.grayscale(
                rgb.crop(
                    (
                        inset_x,
                        inset_y,
                        width - inset_x,
                        height - inset_y,
                    )
                )
            ),
            dtype=np.uint8,
        )
        histogram = np.bincount(
            central_gray.reshape(-1),
            minlength=256,
        ).tolist()
        total = max(1, int(central_gray.size))
        central_chroma = central_rgb.max(axis=2) - central_rgb.min(axis=2)
        chroma_histogram = np.bincount(
            central_chroma.reshape(-1),
            minlength=256,
        ).tolist()
        p50 = percentile(histogram, 0.50)
        relative_ink_cutoff = max(0, p50 - 24)
        return ImageMetrics(
            p01=percentile(histogram, 0.01),
            p10=percentile(histogram, 0.10),
            p50=p50,
            p75=percentile(histogram, 0.75),
            p90=percentile(histogram, 0.90),
            p99=percentile(histogram, 0.99),
            white_fraction=sum(histogram[250:]) / total,
            residual_gray_fraction=sum(histogram[140:250]) / total,
            dark_fraction=sum(histogram[:140]) / total,
            relative_ink_fraction=(
                sum(histogram[:relative_ink_cutoff + 1]) / total
            ),
            chromatic_fraction=float(np.count_nonzero(central_chroma >= 18))
            / total,
            residual_chroma_p99=percentile(chroma_histogram, 0.99),
            distinct_gray_levels=sum(frequency > 0 for frequency in histogram),
            whole_dark_fraction=sum(whole_gray_histogram[:140]) / whole_total,
            whole_relative_ink_fraction=(
                sum(whole_gray_histogram[:whole_ink_cutoff + 1]) / whole_total
            ),
            whole_chromatic_fraction=float(
                np.count_nonzero(whole_chroma >= 18)
            )
            / whole_total,
        )
    whole_gray_histogram = ImageOps.grayscale(rgb).histogram()
    whole_total = max(1, sum(whole_gray_histogram))
    whole_p50 = percentile(whole_gray_histogram, 0.50)
    whole_ink_cutoff = max(0, whole_p50 - 24)
    whole_rgb_bytes = rgb.tobytes()
    whole_chromatic = sum(
        max(red, green, blue) - min(red, green, blue) >= 18
        for red, green, blue in zip(
            whole_rgb_bytes[0::3],
            whole_rgb_bytes[1::3],
            whole_rgb_bytes[2::3],
            strict=True,
        )
    )
    width, height = rgb.size
    # Ignore the outer page margin. It is frequently synthetic white canvas and
    # can conceal a gray scanned rectangle in whole-page percentiles.
    inset_x = max(1, round(width * 0.08))
    inset_y = max(1, round(height * 0.08))
    central = rgb.crop((inset_x, inset_y, width - inset_x, height - inset_y))
    gray = ImageOps.grayscale(central)
    histogram = gray.histogram()
    total = max(1, sum(histogram))
    rgb_bytes = central.tobytes()
    chroma_histogram = [0] * 256
    chromatic = 0
    for red, green, blue in zip(
        rgb_bytes[0::3],
        rgb_bytes[1::3],
        rgb_bytes[2::3],
        strict=True,
    ):
        chroma = max(red, green, blue) - min(red, green, blue)
        chroma_histogram[chroma] += 1
        chromatic += int(chroma >= 18)
    p50 = percentile(histogram, 0.50)
    relative_ink_cutoff = max(0, p50 - 24)
    return ImageMetrics(
        p01=percentile(histogram, 0.01),
        p10=percentile(histogram, 0.10),
        p50=p50,
        p75=percentile(histogram, 0.75),
        p90=percentile(histogram, 0.90),
        p99=percentile(histogram, 0.99),
        white_fraction=sum(histogram[250:]) / total,
        # This is deliberately broad. The auditor ranks candidates for review;
        # it does not assume every midtone is unwanted paper.
        residual_gray_fraction=sum(histogram[140:250]) / total,
        dark_fraction=sum(histogram[:140]) / total,
        relative_ink_fraction=sum(histogram[:relative_ink_cutoff + 1]) / total,
        chromatic_fraction=chromatic / total,
        residual_chroma_p99=percentile(chroma_histogram, 0.99),
        distinct_gray_levels=sum(frequency > 0 for frequency in histogram),
        whole_dark_fraction=sum(whole_gray_histogram[:140]) / whole_total,
        whole_relative_ink_fraction=(
            sum(whole_gray_histogram[:whole_ink_cutoff + 1]) / whole_total
        ),
        whole_chromatic_fraction=whole_chromatic / whole_total,
    )


def load_metadata(
    metadata_dir: Path,
    metadata_page: int,
    output_index: int,
    analysis_metadata_dir: Path | None = None,
    analysis_page: int | None = None,
) -> tuple[str, str, CropMetrics | None, dict[str, Any], dict[str, Any]]:
    analysis_metadata_dir = analysis_metadata_dir or metadata_dir
    analysis_page = analysis_page or metadata_page
    metadata_path = analysis_metadata_dir / f"analysis-{analysis_page}.json"
    if not metadata_path.exists():
        raise RuntimeError(
            f"Missing analysis metadata for source page {analysis_page}"
        )
    value: dict[str, Any] = json.loads(metadata_path.read_text(encoding="utf-8"))
    diagnostics = value.get("outputModeDiagnostics") or {}
    output_metadata_path = (
        metadata_dir / f"clean-{metadata_page}-{output_index}.json"
    )
    crop = None
    if not output_metadata_path.exists():
        raise RuntimeError(
            "Missing final output metadata for "
            f"metadata page {metadata_page}, output index {output_index}"
        )
    output: dict[str, Any] = json.loads(
        output_metadata_path.read_text(encoding="utf-8")
    )
    source_region = output.get("sourceRegion")
    content_box = output.get("contentBox")
    content_diagnostics = output.get("contentDiagnostics") or {}
    if isinstance(source_region, dict) and isinstance(content_box, dict):
        region_width = max(1.0, float(source_region["widthPx"]))
        region_height = max(1.0, float(source_region["heightPx"]))
        left = max(
            0.0,
            float(content_box["xPx"]),
        )
        top = max(
            0.0,
            float(content_box["yPx"]),
        )
        right = max(
            0.0,
            region_width - float(content_box["xPx"]) - float(content_box["widthPx"]),
        )
        bottom = max(
            0.0,
            region_height - float(content_box["yPx"]) - float(content_box["heightPx"]),
        )
        accepted_trims = content_diagnostics.get("acceptedTrims") or []
        removed_text_evidence_count = sum(
            1
            for trim in accepted_trims
            for block in trim.get("removedBlocks", [])
            if block.get("textEvidence") is True
        )
        crop = CropMetrics(
            left_fraction=left / region_width,
            top_fraction=top / region_height,
            right_fraction=right / region_width,
            bottom_fraction=bottom / region_height,
            retained_area_fraction=(
                float(content_box["widthPx"]) * float(content_box["heightPx"])
                / (region_width * region_height)
            ),
            accepted_trim_count=len(accepted_trims),
            removed_text_evidence_count=removed_text_evidence_count,
        )
    return (
        str(value.get("recommendedOutputMode", "unknown")),
        str(diagnostics.get("rule", value.get("recommendedOutputModeReason", "unknown"))),
        crop,
        diagnostics,
        output,
    )


def page_acceptance_failures(
    mode: str,
    rule: str,
    source: ImageMetrics,
    output: ImageMetrics,
    crop: CropMetrics | None,
    diagnostics: dict[str, Any],
    tone: ToneMetrics | None = None,
    seams: SeamMetrics | None = None,
    edge_artifacts: EdgeArtifactMetrics | None = None,
    source_fidelity: SourceFidelityMetrics | None = None,
    source_identity_expected: bool = False,
    trusted_mrc_page: bool = False,
    ownership: OwnershipMetrics | None = None,
) -> tuple[bool, list[str]]:
    text_cleanup_candidate = (
        mode in {"bw", "grayscale", "mixed"}
        and rule not in {
            "continuous-tone",
            "picture",
        }
        and diagnostics.get("significantPicture") is not True
        and diagnostics.get("significantColor") is not True
        and diagnostics.get("coherentOutsideTonalRegion") is not True
        and diagnostics.get("destructiveModeTonalVeto") is not True
    )
    failures: list[str] = []
    paper_p75 = (
        ownership.paper_p75
        if ownership is not None and ownership.paper_pixel_count > 0
        else output.p75
    )
    if text_cleanup_candidate and paper_p75 < 248:
        failures.append(f"paper-p75={paper_p75}<248")
    if (
        text_cleanup_candidate
        and ownership is not None
        and ownership.paper_residual_gray_fraction > 0.01
    ):
        failures.append(
            "paper-residual-gray="
            f"{ownership.paper_residual_gray_fraction:.4f}>0.0100"
        )
    # A protected illustration can legitimately occupy well over the lower
    # three quarters of a Mixed page together with its dark text. The upper
    # decile still samples the surrounding paper after the outer synthetic
    # canvas has been removed. This distinguished every genuinely gray Rome
    # Mixed output (p90 <= 201) from photo-heavy, white-paper output while the
    # old unconditional p75 gate falsely rejected the latter.
    if (
        mode == "mixed"
        and ownership is None
        and output.p90 < 248
        and not source_identity_expected
    ):
        failures.append(f"mixed-paper-p90={output.p90}<248")
    if text_cleanup_candidate and output.residual_chroma_p99 > 4:
        failures.append(
            f"residual-chroma-p99={output.residual_chroma_p99}>4"
        )
    relative_ink_ratio = (
        output.whole_relative_ink_fraction / source.whole_relative_ink_fraction
        if source.whole_relative_ink_fraction > 0.0001
        else 1.0
    )
    if (
        text_cleanup_candidate
        # Below two percent, the relative-to-paper measurement is dominated by
        # isolated scanner dust and edge scratches on otherwise blank leaves.
        # Faint synthetic text fixtures exercise preservation directly; this
        # artifact-level ratio is reserved for pages with enough distributed
        # evidence to represent actual ink.
        and source.whole_relative_ink_fraction >= 0.02
        # A source MRC selection mask is authored ownership evidence and is
        # checked below at component level. The whole-page percentile ratio is
        # unreliable on light paper because whitening moves its relative
        # cutoff while the selected text itself remains unchanged.
        and not (
            ownership is not None
            and ownership.source_ink_pixels >= 16
        )
        and relative_ink_ratio < 0.60
    ):
        failures.append(f"relative-ink-retention={relative_ink_ratio:.3f}<0.60")
    colored_fraction = diagnostics.get("coloredFraction")
    if (
        diagnostics.get("significantColor") is True
        and isinstance(colored_fraction, (int, float))
        and math.isfinite(colored_fraction)
        and colored_fraction >= 0.002
        and output.chromatic_fraction < colored_fraction * 0.50
    ):
        # Global source chroma is not independent-color evidence on uniformly
        # tinted paper: whitening that field is the requested cleanup. Compare
        # the assembled artifact to the classifier's localized independent
        # color ownership instead. `chromatic_fraction` already requires at
        # least 18 levels of channel separation, so this covers both retained
        # area and material chroma without mistaking blue/cream paper for art.
        failures.append(
            "independent-color-coverage="
            f"{output.chromatic_fraction:.3f}<"
            f"{colored_fraction * 0.50:.3f}"
        )
    elif (
        diagnostics.get("significantColor") is True
        and not isinstance(colored_fraction, (int, float))
        and source.residual_chroma_p99 >= 18
        and output.residual_chroma_p99 < source.residual_chroma_p99 * 0.50
    ):
        failures.append(
            "independent-color-chroma-p99="
            f"{output.residual_chroma_p99}<"
            f"{source.residual_chroma_p99 * 0.50:.1f}"
        )
    if (
        mode == "color"
        and source.p50 < 128
        and output.p50 > source.p50 + 48
    ):
        failures.append(
            f"full-bleed-color-p50={output.p50}>{source.p50 + 48}"
        )
    protected_tone = (
        diagnostics.get("significantPicture") is True
        or diagnostics.get("coherentOutsideTonalRegion") is True
    )
    # 0.006 not 0.003: zone interiors are shoulder-normalized, and steepening
    # near-paper tones legitimately adds edge pixels versus the raw source
    # (rome-20 page 16: 0.0020 raw-copy era, 0.0033 normalized, visually an
    # intended contrast gain). The gate still catches gross banding.
    if (
        trusted_mrc_page
        and mode == "mixed"
        and source_fidelity is not None
        and source_fidelity.new_edge_fraction > 0.006
    ):
        failures.append(
            "introduced-tone-boundaries="
            f"{source_fidelity.new_edge_fraction:.4f}>0.0060,"
            f"count={source_fidelity.new_edge_count}"
        )
    if ownership is not None:
        if (
            mode in {"grayscale", "mixed"}
            and ownership.tone_coverage_fraction >= 0.02
        ):
            # Trusted-page zone interiors are shoulder-normalized (paper maps
            # to 255 by design), so the source-comparative lift/range checks
            # there measure only the metadata-convention alignment, whose
            # residual scale drift produces phantom shifts on high-contrast
            # photo interiors (page 16 of the Rome smoke: audit -12 while
            # direct alignment-free medians show only brightening).
            if not trusted_mrc_page and abs(ownership.tone_p50_lift) > 8:
                failures.append(
                    "tone-owned-p50-lift="
                    f"{ownership.tone_p50_lift:+d}>8"
                )
            if not trusted_mrc_page and not 0.90 <= ownership.tone_range_ratio <= 1.10:
                failures.append(
                    "tone-owned-range-ratio="
                    f"{ownership.tone_range_ratio:.3f} outside [0.900,1.100]"
                )
            # On trusted pages a bbox picture zone legitimately contains
            # paper, which the shoulder curve maps to 255, so only crushed
            # blacks indicate clipping there. Elsewhere both endpoints do.
            if trusted_mrc_page:
                if ownership.tone_output_black_fraction > 0.02:
                    failures.append(
                        "tone-owned-black-crush="
                        f"{ownership.tone_output_black_fraction:.3f}>0.020"
                    )
            elif ownership.tone_output_endpoint_fraction > 0.02:
                failures.append(
                    "tone-owned-endpoints="
                    f"{ownership.tone_output_endpoint_fraction:.3f}>0.020"
                )
            # A picture zone whose interior is mostly near-white paper is not
            # a picture: it is a mis-detected zone preserving raw gray paper
            # (observed as large gray rectangles beside illustrations).
            if ownership.zone_bright_fraction > 0.50:
                failures.append(
                    "picture-zone-mostly-paper="
                    f"{ownership.zone_bright_fraction:.3f}>0.500"
                )
        # Outside picture zones a cleaned mixed page must have white paper; a
        # smooth gray wash slipped past thumbnail-scale review once and must
        # never pass unmeasured again.
        if (
            mode == "mixed"
            and rule != "blank"
            and ownership.paper_pixel_count > 0
            and ownership.paper_p90 < 245
        ):
            failures.append(
                f"mixed-paper-p90={ownership.paper_p90}<245"
            )
        if (
            mode in {"bw", "grayscale", "mixed"}
            and rule != "blank"
            and ownership.source_ink_pixels >= 16
            and not 0.85 <= ownership.output_ink_ratio <= 1.15
        ):
            failures.append(
                "mask-selected-ink-ratio="
                f"{ownership.output_ink_ratio:.3f} outside [0.850,1.150]"
            )
        # Retention is a statistical verdict; a page whose authored selection
        # is essentially empty (observed: 6 stray pixels on a page whose text
        # the producer left in the background layer) offers no meaningful
        # sample and must not fail on noise specks.
        if (
            mode in {"bw", "grayscale", "mixed"}
            and rule != "blank"
            and ownership.source_ink_pixels >= 500
            and ownership.small_component_count > 0
            and ownership.small_component_retention < 0.90
        ):
            failures.append(
                "small-component-retention="
                f"{ownership.small_component_retention:.3f}<0.900"
            )
        if (
            mode in {"bw", "grayscale", "mixed"}
            and rule != "blank"
            and ownership.source_ink_pixels >= 500
            and ownership.margin_small_component_count > 0
            and ownership.margin_small_component_retention < 0.90
        ):
            failures.append(
                "margin-small-component-retention="
                f"{ownership.margin_small_component_retention:.3f}<0.900"
            )
        if (
            rule == "blank"
            and ownership.blank_largest_nonwhite_component_mm2 > 0.30
        ):
            failures.append(
                "blank-nonwhite-component="
                f"{ownership.blank_largest_nonwhite_component_mm2:.3f}mm2>0.300mm2"
            )
    if (
        source_identity_expected
        and source_fidelity is not None
        and (
            source_fidelity.mean_absolute_error > 3.0
            # Independent PDF rasterizations differ around a narrow band of
            # original high-contrast edges even when the source page object is
            # reused exactly. Requiring p99 <= 12 rejected that ordinary
            # antialiasing while the page-wide MAE stayed below 2.4 and the
            # cleanup-only edge gate stayed below 0.11%. A 64-level p99 still
            # rejects material localized tone replacement; the mean and
            # source-neighborhood edge gates cover broad and boundary-shaped
            # corruption independently.
            or source_fidelity.p99_absolute_error > 64
        )
    ):
        failures.append(
            "trusted-mrc-source-fidelity="
            f"mae={source_fidelity.mean_absolute_error:.2f}>3.00,"
            f"p99={source_fidelity.p99_absolute_error}>64"
        )
    # A single long residual boundary is decisive inside a photograph, where
    # no layer boundary should divide a coherent continuous-tone field. Maps
    # and dense line art legitimately contain long high-contrast borders, so
    # mirror the renderer's line-art refinement gate instead of treating every
    # protected tonal page as a photograph.
    picture_fraction = diagnostics.get("pictureFraction")
    midtone_fraction = diagnostics.get("midtoneFraction")
    bimodality = diagnostics.get("bimodality")
    line_art_picture = (
        isinstance(picture_fraction, (int, float))
        and isinstance(midtone_fraction, (int, float))
        and isinstance(bimodality, (int, float))
        and picture_fraction >= 0.60
        and midtone_fraction <= 0.16
        and bimodality >= 0.65
    )
    photo_like_picture = (
        diagnostics.get("significantPicture") is True
        and not line_art_picture
    )
    if protected_tone and output.distinct_gray_levels < 4:
        failures.append(
            f"protected-tone-levels={output.distinct_gray_levels}<4"
        )
    tone_damaged = False
    if tone is not None:
        tone_failures: list[str] = []
        # Paper/highlight pixels are interleaved with real tone in a coarse,
        # source-derived component. Whitening those pixels can lift the median
        # dramatically while expanding (not destroying) the retained tonal
        # range. Treat lift as destructive only when both the dark and middle
        # anchors move materially; either one alone is commonly paper cleanup.
        destructive_lift = tone.p10_lift > 24 and tone.p50_lift > 32
        contracted_range = tone.range_ratio < 0.75
        clipped_endpoints = tone.output_endpoint_fraction > 0.02
        # A multiplicative paper normalization can lift both anchors while
        # retaining or expanding the source range. That is expected for line
        # art printed on gray stock (Rome p308) and is not tone destruction.
        # Require clipping or contraction before treating an anchor lift as
        # destructive. True flattened photographs still trip both the lift and
        # endpoint checks.
        if destructive_lift and (contracted_range or clipped_endpoints):
            tone_failures.append(f"p10+{tone.p10_lift}>24")
            tone_failures.append(f"p50+{tone.p50_lift}>32")
        # Contrast expansion is not tone loss by itself: paper/highlight
        # cleanup can legitimately raise p90 while p10, p50 and endpoints stay
        # intact. Contraction, however, directly means tonal separation was
        # flattened. Highlight destruction is covered independently by median
        # lift and endpoint clipping.
        if contracted_range:
            tone_failures.append(
                f"range-ratio={tone.range_ratio:.3f}<0.75"
            )
        # White paper/highlights can enter a source-derived tone component
        # after cleanup even when all lower and middle tones remain exact.
        # Endpoint mass is destructive only when accompanied by tonal lift or
        # contraction; page 12's sculpture, for example, retains p10/p50
        # within one level while its surrounding paper legitimately becomes
        # white.
        if (
            clipped_endpoints
            and (
                destructive_lift
                or contracted_range
            )
        ):
            tone_failures.append(
                "endpoint-fraction="
                f"{tone.output_endpoint_fraction:.3f}>0.020"
            )
        # The bilevel fidelity veto is intentionally conservative and also
        # fires on dense soft-edged text. It is not independent evidence that
        # a page owns a real tonal region. Significant picture or coherent
        # outside-tone evidence establishes that ownership; the source-derived
        # metrics above then independently decide whether it was damaged.
        if tone_failures and protected_tone:
            tone_damaged = True
            failures.append("continuous-tone-damage:" + ",".join(tone_failures))
    # A few long residual contours are expected when a preserved map/photo is
    # multiplicatively white-balanced: legitimate smooth source shading then
    # differs from the cleaned endpoint along semantic boundaries. Treat seams
    # as an artifact gate when the page is paper/text cleanup, when independent
    # tone metrics also report damage, and only after more than isolated
    # alignment noise. This still rejects generated block fields on gray text
    # pages without calling map borders or a single resampling edge a failure.
    if (
        seams is not None
        and (
            (
                seams.count >= 3
                and (text_cleanup_candidate or tone_damaged)
            )
            or (
                seams.dominant_single
                and photo_like_picture
                # A semantic boundary between newly white paper and a
                # preserved photograph can create one long residual contour
                # even though the source edge and every interior tone remain
                # intact. A destructive block inside the photograph also
                # damages its source-relative anchors/range, so require that
                # independent evidence before rejecting a lone contour.
                and tone_damaged
            )
        )
    ):
        failures.append(
            "block-seams="
            f"{seams.count},longest={seams.longest_run_px}px,"
            f"jump={seams.maximum_jump}"
        )
    # Scanner shadows can threshold into a solid crescent or rail near one
    # physical page boundary. Global histograms missed the original Rome map
    # regression because the protected map legitimately dominated the page.
    # Compare the assembled artifact to the geometrically aligned source and
    # reject only a large, nearly page-spanning field of newly black pixels.
    # Thin printed frames and ordinary edge text do not occupy enough of the
    # 32 mm boundary field to satisfy both conditions.
    if (
        edge_artifacts is not None
        and edge_artifacts.introduced_black_fraction > 0.15
        and max(
            edge_artifacts.longest_column_fraction,
            edge_artifacts.longest_row_fraction,
        ) > 0.70
    ):
        failures.append(
            "introduced-boundary-ink="
            f"{edge_artifacts.introduced_black_fraction:.3f}>0.150,"
            "span="
            f"{max(edge_artifacts.longest_column_fraction, edge_artifacts.longest_row_fraction):.3f}>0.700"
        )
    if crop is not None and crop.removed_text_evidence_count > 0:
        failures.append("content-crop-removed-text-evidence")
    return text_cleanup_candidate, failures


def neighbor_audits(audits: list[PageAudit]) -> list[NeighborAudit]:
    """Compare adjacent, source-similar text pages without assuming a fixed shade."""
    results: list[NeighborAudit] = []
    for left, right in zip(audits, audits[1:], strict=False):
        if right.page != left.page + 1:
            continue
        left_source_ink = left.source.whole_relative_ink_fraction
        right_source_ink = right.source.whole_relative_ink_fraction
        source_ink_ratio = (
            max(left_source_ink, right_source_ink)
            / max(0.0001, min(left_source_ink, right_source_ink))
        )
        comparable = (
            left.text_cleanup_candidate
            and right.text_cleanup_candidate
            and abs(left.source.p75 - right.source.p75) <= 24
            and min(left_source_ink, right_source_ink) >= 0.01
            and source_ink_ratio <= 2.5
        )
        left_paper = left.output.p90 if left.mode == "mixed" else left.output.p75
        right_paper = right.output.p90 if right.mode == "mixed" else right.output.p75
        output_paper_delta = abs(left_paper - right_paper)
        residual_gray_delta = abs(
            left.output.residual_gray_fraction
            - right.output.residual_gray_fraction
        )
        retention_delta = abs(
            left.relative_ink_fraction_ratio
            - right.relative_ink_fraction_ratio
        )
        failures: list[str] = []
        # The absolute page gates remain authoritative. Neighbor evidence makes
        # alternating cleanup failures explicit when two adjacent source pages
        # have comparable paper and ink, while avoiding assumptions about the
        # book's exact paper shade or text density.
        if (
            comparable
            and output_paper_delta > 12
            and min(left_paper, right_paper) < 248
        ):
            failures.append(
                "adjacent-paper-discontinuity="
                f"{output_paper_delta}>12,min={min(left_paper, right_paper)}"
            )
        if (
            comparable
            and residual_gray_delta > 0.12
            and max(
                left.output.residual_gray_fraction,
                right.output.residual_gray_fraction,
            ) > 0.20
            and output_paper_delta > 6
        ):
            failures.append(
                "adjacent-gray-field-discontinuity="
                f"{residual_gray_delta:.3f}>0.120"
            )
        if (
            comparable
            and retention_delta > 0.50
            and min(
                left.relative_ink_fraction_ratio,
                right.relative_ink_fraction_ratio,
            ) < 0.60
        ):
            failures.append(
                "adjacent-ink-retention-discontinuity="
                f"{retention_delta:.3f}>0.500"
            )
        results.append(
            NeighborAudit(
                left_page=left.page,
                right_page=right.page,
                comparable=comparable,
                source_p75_delta=abs(left.source.p75 - right.source.p75),
                source_ink_ratio=source_ink_ratio,
                output_paper_delta=output_paper_delta,
                output_residual_gray_delta=residual_gray_delta,
                relative_ink_retention_delta=retention_delta,
                acceptance_failures=tuple(failures),
            )
        )
    return results


def source_region_image(
    image: Image.Image,
    output_metadata: dict[str, Any],
) -> Image.Image:
    region = output_metadata.get("sourceRegion")
    input_width = output_metadata.get("inputWidthPx")
    input_height = output_metadata.get("inputHeightPx")
    if (
        not isinstance(region, dict)
        or not isinstance(input_width, (int, float))
        or not isinstance(input_height, (int, float))
        or input_width <= 0
        or input_height <= 0
    ):
        return image.copy()
    scale_x = image.width / float(input_width)
    scale_y = image.height / float(input_height)
    left = max(0, min(image.width - 1, round(float(region["xPx"]) * scale_x)))
    top = max(0, min(image.height - 1, round(float(region["yPx"]) * scale_y)))
    right = max(
        left + 1,
        min(
            image.width,
            round((float(region["xPx"]) + float(region["widthPx"])) * scale_x),
        ),
    )
    bottom = max(
        top + 1,
        min(
            image.height,
            round((float(region["yPx"]) + float(region["heightPx"])) * scale_y),
        ),
    )
    return image.crop((left, top, right, bottom))


def affine_output_to_source_coefficients(
    source_size: tuple[int, int],
    output_metadata: dict[str, Any],
    output_size: tuple[int, int],
) -> tuple[float, float, float, float, float, float] | None:
    """Map audit-output pixels through the canonical final affine to source."""

    transform = output_metadata.get("forwardTransform")
    matrix = transform.get("matrix") if isinstance(transform, dict) else None
    if (
        not isinstance(matrix, list)
        or len(matrix) < 2
        or not all(isinstance(row, list) and len(row) >= 3 for row in matrix[:2])
        or output_metadata.get("dewarpMapping") is not None
    ):
        return None
    a, b, c = (float(value) for value in matrix[0][:3])
    d, e, f = (float(value) for value in matrix[1][:3])
    determinant = a * e - b * d
    if not math.isfinite(determinant) or abs(determinant) < 1e-12:
        return None
    canvas_width = max(1.0, float(output_metadata["canvasWidthPx"]))
    canvas_height = max(1.0, float(output_metadata["canvasHeightPx"]))
    output_width = max(1.0, float(output_metadata["outputWidthPx"]))
    output_height = max(1.0, float(output_metadata["outputHeightPx"]))
    match_scale_x = (
        float(output_metadata["matchedCanvasContentWidthPx"]) / output_width
    )
    match_scale_y = (
        float(output_metadata["matchedCanvasContentHeightPx"]) / output_height
    )
    audit_to_canvas_x = canvas_width / max(1, output_size[0])
    audit_to_canvas_y = canvas_height / max(1, output_size[1])
    placement_x = float(output_metadata["placementOffsetXPx"])
    placement_y = float(output_metadata["placementOffsetYPx"])
    input_width = max(1.0, float(output_metadata["inputWidthPx"]))
    input_height = max(1.0, float(output_metadata["inputHeightPx"]))
    source_scale_x = source_size[0] / input_width
    source_scale_y = source_size[1] / input_height

    # final = placement + match_scale * (forward * input)
    # Pillow asks for the inverse map from destination to source.
    local_x_scale = audit_to_canvas_x / match_scale_x
    local_y_scale = audit_to_canvas_y / match_scale_y
    local_x_offset = -placement_x / match_scale_x
    local_y_offset = -placement_y / match_scale_y
    inverse_a = e / determinant
    inverse_b = -b / determinant
    inverse_d = -d / determinant
    inverse_e = a / determinant
    return (
        source_scale_x * inverse_a * local_x_scale,
        source_scale_x * inverse_b * local_y_scale,
        source_scale_x
        * (
            inverse_a * (local_x_offset - c)
            + inverse_b * (local_y_offset - f)
        ),
        source_scale_y * inverse_d * local_x_scale,
        source_scale_y * inverse_e * local_y_scale,
        source_scale_y
        * (
            inverse_d * (local_x_offset - c)
            + inverse_e * (local_y_offset - f)
        ),
    )


def align_source_to_output(
    source: Image.Image,
    output_metadata: dict[str, Any],
    output_size: tuple[int, int],
) -> Image.Image:
    required = (
        "inputWidthPx",
        "inputHeightPx",
        "cropRect",
        "canvasWidthPx",
        "canvasHeightPx",
        "matchedCanvasContentWidthPx",
        "matchedCanvasContentHeightPx",
        "placementOffsetXPx",
        "placementOffsetYPx",
    )
    missing = [key for key in required if key not in output_metadata]
    if missing:
        raise RuntimeError(
            "Cannot align source to output without canonical render metadata: "
            + ", ".join(missing)
        )
    affine = affine_output_to_source_coefficients(
        source.size,
        output_metadata,
        output_size,
    )
    if affine is not None:
        return source.convert("RGB").transform(
            output_size,
            Image.Transform.AFFINE,
            affine,
            resample=Image.Resampling.BICUBIC,
            fillcolor="white",
        )
    input_width = max(1.0, float(output_metadata["inputWidthPx"]))
    input_height = max(1.0, float(output_metadata["inputHeightPx"]))
    source_scale_x = source.width / input_width
    source_scale_y = source.height / input_height
    region = output_metadata.get("sourceRegion")
    if isinstance(region, dict):
        region_left = float(region["xPx"])
        region_top = float(region["yPx"])
        region_right = region_left + float(region["widthPx"])
        region_bottom = region_top + float(region["heightPx"])
    else:
        region_left = 0.0
        region_top = 0.0
        region_right = input_width
        region_bottom = input_height
    crop = output_metadata["cropRect"]
    crop_box = (
        round((region_left + float(crop["xPx"])) * source_scale_x),
        round((region_top + float(crop["yPx"])) * source_scale_y),
        round(
            (region_left + float(crop["xPx"]) + float(crop["widthPx"]))
            * source_scale_x
        ),
        round(
            (region_top + float(crop["yPx"]) + float(crop["heightPx"]))
            * source_scale_y
        ),
    )
    # Pillow fills an out-of-bounds crop with black. Scan cleanup deliberately
    # uses white for the synthetic margin introduced by a negative cropRect,
    # so accepting Pillow's default here creates dark "source tone" that never
    # existed and makes a preserved full-bleed cover look destroyed.
    content = Image.new(
        "RGB",
        (
            max(1, crop_box[2] - crop_box[0]),
            max(1, crop_box[3] - crop_box[1]),
        ),
        "white",
    )
    source_rgb = source.convert("RGB")
    region_box = (
        round(region_left * source_scale_x),
        round(region_top * source_scale_y),
        round(region_right * source_scale_x),
        round(region_bottom * source_scale_y),
    )
    source_intersection = (
        max(0, region_box[0], crop_box[0]),
        max(0, region_box[1], crop_box[1]),
        min(source_rgb.width, region_box[2], crop_box[2]),
        min(source_rgb.height, region_box[3], crop_box[3]),
    )
    if (
        source_intersection[2] > source_intersection[0]
        and source_intersection[3] > source_intersection[1]
    ):
        content.paste(
            source_rgb.crop(source_intersection),
            (
                source_intersection[0] - crop_box[0],
                source_intersection[1] - crop_box[1],
            ),
        )
    canvas_width = max(1.0, float(output_metadata["canvasWidthPx"]))
    canvas_height = max(1.0, float(output_metadata["canvasHeightPx"]))
    output_scale_x = output_size[0] / canvas_width
    output_scale_y = output_size[1] / canvas_height
    target_width = max(
        1,
        round(
            float(output_metadata["matchedCanvasContentWidthPx"])
            * output_scale_x
        ),
    )
    target_height = max(
        1,
        round(
            float(output_metadata["matchedCanvasContentHeightPx"])
            * output_scale_y
        ),
    )
    content = content.resize(
        (target_width, target_height),
        Image.Resampling.LANCZOS,
    )
    aligned = Image.new("RGB", output_size, "white")
    aligned.paste(
        content,
        (
            round(
                float(output_metadata["placementOffsetXPx"])
                * output_scale_x
            ),
            round(
                float(output_metadata["placementOffsetYPx"])
                * output_scale_y
            ),
        ),
    )
    return aligned


def confirmed_block_seam_metrics(
    seam_runs: list[tuple[str, int, int, int, int]],
    dpi: int,
    width: int,
    height: int,
) -> SeamMetrics:
    # Arbitrary long residual lines are common around typography and original
    # page rules. Cleanup block artifacts instead form orthogonal boundaries
    # that meet near run endpoints. Retain only connected structures with at
    # least three sides, which also covers a rectangle clipped by the page.
    endpoint_tolerance = max(3, round(dpi * 0.03))
    adjacency: list[set[int]] = [set() for _ in seam_runs]
    for first_index, first in enumerate(seam_runs):
        for second_index in range(first_index + 1, len(seam_runs)):
            second = seam_runs[second_index]
            if first[0] == second[0]:
                continue
            vertical = first if first[0] == "vertical" else second
            horizontal = second if first[0] == "vertical" else first
            intersection_x = vertical[1]
            intersection_y = horizontal[1]
            if not (
                horizontal[2] - endpoint_tolerance
                <= intersection_x
                <= horizontal[3] + endpoint_tolerance
                and vertical[2] - endpoint_tolerance
                <= intersection_y
                <= vertical[3] + endpoint_tolerance
            ):
                continue
            vertical_endpoint = min(
                abs(intersection_y - vertical[2]),
                abs(intersection_y - vertical[3]),
            )
            horizontal_endpoint = min(
                abs(intersection_x - horizontal[2]),
                abs(intersection_x - horizontal[3]),
            )
            if (
                vertical_endpoint <= endpoint_tolerance
                and horizontal_endpoint <= endpoint_tolerance
            ):
                adjacency[first_index].add(second_index)
                adjacency[second_index].add(first_index)

    confirmed: set[int] = set()
    unseen = set(range(len(seam_runs)))
    while unseen:
        root = unseen.pop()
        component = {root}
        stack = [root]
        while stack:
            current = stack.pop()
            for neighbor in adjacency[current]:
                if neighbor in unseen:
                    unseen.remove(neighbor)
                    component.add(neighbor)
                    stack.append(neighbor)
        directions = {seam_runs[index][0] for index in component}
        if len(component) >= 3 and len(directions) == 2:
            confirmed.update(component)

    confirmed_runs = [seam_runs[index] for index in sorted(confirmed)]
    dominant_single_runs = [
        run
        for index, run in enumerate(seam_runs)
        if (
            index not in confirmed
            and run[4] >= 24
            and run[3] - run[2] + 1
            >= (
                height * 0.15
                if run[0] == "vertical"
                else width * 0.15
            )
        )
    ]
    dominant_single = len(dominant_single_runs) > 0
    reported_runs = [
        *confirmed_runs,
        *(
            [max(dominant_single_runs, key=lambda run: run[3] - run[2] + 1)]
            if dominant_single
            else []
        ),
    ]

    return SeamMetrics(
        len(reported_runs),
        sum(run[3] - run[2] + 1 for run in reported_runs),
        max((run[3] - run[2] + 1 for run in reported_runs), default=0),
        max((run[4] for run in reported_runs), default=0),
        dominant_single,
    )


def introduced_edge_artifact_metrics(
    aligned_source: Image.Image,
    output: Image.Image,
    dpi: int,
) -> EdgeArtifactMetrics:
    source_gray = ImageOps.grayscale(aligned_source)
    output_gray = ImageOps.grayscale(output)
    if source_gray.size != output_gray.size:
        raise RuntimeError("Edge-artifact audit requires aligned source/output dimensions")
    width, height = output_gray.size
    maximum_depth = max(1, (min(width, height) - 1) // 2)
    boundary_depth = min(maximum_depth, max(1, round(dpi * 32.0 / 25.4)))
    source_pixels = source_gray.load()
    output_pixels = output_gray.load()
    column_counts = [0] * width
    row_counts = [0] * height
    introduced_black = 0
    boundary_pixels = 0

    for y in range(height):
        boundary_row = y < boundary_depth or y >= height - boundary_depth
        for x in range(width):
            if (
                not boundary_row
                and x >= boundary_depth
                and x < width - boundary_depth
            ):
                continue
            boundary_pixels += 1
            source_value = int(source_pixels[x, y])
            output_value = int(output_pixels[x, y])
            if output_value <= 32 and source_value - output_value >= 80:
                introduced_black += 1
                column_counts[x] += 1
                row_counts[y] += 1

    return EdgeArtifactMetrics(
        boundary_depth_px=boundary_depth,
        introduced_black_fraction=introduced_black / max(1, boundary_pixels),
        longest_column_fraction=max(column_counts, default=0) / max(1, height),
        longest_row_fraction=max(row_counts, default=0) / max(1, width),
    )


def _binary_mask(mask: Image.Image) -> Image.Image:
    return mask.convert("L").point(lambda value: 255 if value > 0 else 0)


def _masked_values(image: Image.Image, mask: Image.Image) -> list[int]:
    return [
        value
        for value, selected in zip(
            ImageOps.grayscale(image).tobytes(),
            _binary_mask(mask).tobytes(),
            strict=True,
        )
        if selected
    ]


def _masked_percentile(values: Iterable[int], fraction: float) -> int:
    histogram = [0] * 256
    count = 0
    for value in values:
        histogram[int(value)] += 1
        count += 1
    return percentile(histogram, fraction) if count else 255


def _binary_dilation(mask: Image.Image, radius: int) -> Image.Image:
    binary = _binary_mask(mask)
    return (
        binary
        if radius <= 0
        else binary.filter(ImageFilter.MaxFilter(radius * 2 + 1))
    )


def _binary_erosion(mask: Image.Image, radius: int) -> Image.Image:
    binary = _binary_mask(mask)
    return (
        binary
        if radius <= 0
        else binary.filter(ImageFilter.MinFilter(radius * 2 + 1))
    )


def _component_records(
    mask: Image.Image,
    retained_mask: Image.Image | None = None,
) -> list[dict[str, Any]]:
    """Return 8-connected component records using row runs, without OpenCV."""

    binary = memoryview(_binary_mask(mask).tobytes())
    retained = (
        memoryview(_binary_mask(retained_mask).tobytes())
        if retained_mask is not None
        else None
    )
    width, height = mask.size
    parent: list[int] = []
    runs: list[tuple[int, int, int, int]] = []
    previous: list[tuple[int, int, int]] = []

    def make_label() -> int:
        label = len(parent)
        parent.append(label)
        return label

    def find(label: int) -> int:
        while parent[label] != label:
            parent[label] = parent[parent[label]]
            label = parent[label]
        return label

    def union(first: int, second: int) -> None:
        first_root = find(first)
        second_root = find(second)
        if first_root != second_root:
            parent[second_root] = first_root

    for y in range(height):
        current: list[tuple[int, int, int]] = []
        row_offset = y * width
        x = 0
        while x < width:
            while x < width and not binary[row_offset + x]:
                x += 1
            if x >= width:
                break
            start = x
            while x + 1 < width and binary[row_offset + x + 1]:
                x += 1
            end = x
            overlaps = [
                label
                for previous_start, previous_end, label in previous
                if previous_end >= start - 1 and previous_start <= end + 1
            ]
            label = make_label() if not overlaps else overlaps[0]
            for overlap in overlaps[1:]:
                union(label, overlap)
            current.append((start, end, label))
            runs.append((y, start, end, label))
            x += 1
        previous = current

    components: dict[int, dict[str, Any]] = {}
    for y, start, end, label in runs:
        root = find(label)
        record = components.setdefault(root, {
            "area": 0,
            "left": start,
            "top": y,
            "right": end,
            "bottom": y,
            "retained": 0,
            "runs": [],
        })
        record["area"] += end - start + 1
        record["left"] = min(record["left"], start)
        record["top"] = min(record["top"], y)
        record["right"] = max(record["right"], end)
        record["bottom"] = max(record["bottom"], y)
        record["runs"].append((y, start, end))
        if retained is not None:
            record["retained"] += sum(
                bool(retained[y * width + x])
                for x in range(start, end + 1)
            )
    return list(components.values())


def align_binary_mask_to_output(
    source: Image.Image,
    output_metadata: dict[str, Any],
    output_size: tuple[int, int],
) -> Image.Image:
    """Apply the canonical page crop/placement to a selected-white mask."""

    source_mask = _binary_mask(source)
    affine = affine_output_to_source_coefficients(
        source_mask.size,
        output_metadata,
        output_size,
    )
    if affine is not None:
        return source_mask.transform(
            output_size,
            Image.Transform.AFFINE,
            affine,
            resample=Image.Resampling.NEAREST,
            fillcolor=0,
        )
    input_width = max(1.0, float(output_metadata["inputWidthPx"]))
    input_height = max(1.0, float(output_metadata["inputHeightPx"]))
    source_scale_x = source.width / input_width
    source_scale_y = source.height / input_height
    region = output_metadata.get("sourceRegion")
    if isinstance(region, dict):
        region_left = float(region["xPx"])
        region_top = float(region["yPx"])
        region_right = region_left + float(region["widthPx"])
        region_bottom = region_top + float(region["heightPx"])
    else:
        region_left = 0.0
        region_top = 0.0
        region_right = input_width
        region_bottom = input_height
    crop = output_metadata["cropRect"]
    crop_box = (
        round((region_left + float(crop["xPx"])) * source_scale_x),
        round((region_top + float(crop["yPx"])) * source_scale_y),
        round(
            (region_left + float(crop["xPx"]) + float(crop["widthPx"]))
            * source_scale_x
        ),
        round(
            (region_top + float(crop["yPx"]) + float(crop["heightPx"]))
            * source_scale_y
        ),
    )
    content = Image.new(
        "L",
        (
            max(1, crop_box[2] - crop_box[0]),
            max(1, crop_box[3] - crop_box[1]),
        ),
        0,
    )
    region_box = (
        round(region_left * source_scale_x),
        round(region_top * source_scale_y),
        round(region_right * source_scale_x),
        round(region_bottom * source_scale_y),
    )
    intersection = (
        max(0, region_box[0], crop_box[0]),
        max(0, region_box[1], crop_box[1]),
        min(source_mask.width, region_box[2], crop_box[2]),
        min(source_mask.height, region_box[3], crop_box[3]),
    )
    if intersection[2] > intersection[0] and intersection[3] > intersection[1]:
        content.paste(
            source_mask.crop(intersection),
            (
                intersection[0] - crop_box[0],
                intersection[1] - crop_box[1],
            ),
        )
    output_scale_x = (
        output_size[0] / max(1.0, float(output_metadata["canvasWidthPx"]))
    )
    output_scale_y = (
        output_size[1] / max(1.0, float(output_metadata["canvasHeightPx"]))
    )
    content = content.resize(
        (
            max(
                1,
                round(
                    float(output_metadata["matchedCanvasContentWidthPx"])
                    * output_scale_x
                ),
            ),
            max(
                1,
                round(
                    float(output_metadata["matchedCanvasContentHeightPx"])
                    * output_scale_y
                ),
            ),
        ),
        Image.Resampling.NEAREST,
    )
    aligned = Image.new("L", output_size, 0)
    aligned.paste(
        content,
        (
            round(float(output_metadata["placementOffsetXPx"]) * output_scale_x),
            round(float(output_metadata["placementOffsetYPx"]) * output_scale_y),
        ),
    )
    return aligned


def decode_embedded_jbig2_mask(path: Path) -> Image.Image:
    decoder = shutil.which("jbig2dec")
    if decoder is None:
        raise RuntimeError(
            "jbig2dec is required to audit source-MRC foreground ownership"
        )
    with tempfile.TemporaryDirectory(prefix="evb-jbig2-mask-") as temporary:
        output_path = Path(temporary) / "selection.pbm"
        subprocess.run(
            [
                decoder,
                "-q",
                "-e",
                "-o",
                str(output_path),
                str(path),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        with Image.open(output_path) as image:
            decoded = _binary_mask(image)
            decode_path = path.with_name(f"{path.name}.decode")
            source_decode = (
                decode_path.read_text(encoding="utf-8").strip()
                if decode_path.is_file()
                else "default"
            )
            if source_decode == "inverted":
                decoded = ImageOps.invert(decoded)
            elif source_decode != "default":
                raise RuntimeError(
                    f"Unsupported source MRC mask decode sidecar: {source_decode}"
                )
            return decoded.copy()


def ownership_artifact_masks(
    metadata_dir: Path,
    metadata_page: int,
    output_index: int,
    output_size: tuple[int, int],
    dpi: int,
    output_metadata: dict[str, Any],
    *,
    trusted_mrc_page: bool,
    debug_prefix: Path | None = None,
) -> tuple[Image.Image, Image.Image, Image.Image]:
    stem = metadata_dir / f"clean-{metadata_page}-{output_index}"
    tone_path = stem.with_name(
        f"{stem.name}-tone-preservation-alpha.png"
    )
    ink_path = stem.with_name(f"{stem.name}-mask.pbm")
    bilevel_path = stem.with_suffix(".pbm")
    picture_path = stem.with_name(f"{stem.name}-picture-mask.pbm")
    background_paths = [
        stem.with_name(f"{stem.name}-background.png"),
        stem.with_name(f"{stem.name}-background.ppm"),
    ]

    if tone_path.is_file():
        with Image.open(tone_path) as image:
            tone_owned = image.convert("L").resize(
                output_size,
                Image.Resampling.LANCZOS,
            ).point(lambda value: 255 if value >= 16 else 0)
    else:
        tone_owned = Image.new("L", output_size, 0)

    source_mrc_mask_path = (
        metadata_dir / f"source-{metadata_page}-mrc-selection.jb2e"
    )
    # An extracted selection is the page's ink reference only when the render
    # actually consumed it; on full-resolution-background pages the producer's
    # selection is not a complete ink carrier and the page binarizes the
    # composite instead.
    selection_consumed = (
        trusted_mrc_page
        or output_metadata.get("trustedSelectionApplied") is True
    )
    if source_mrc_mask_path.is_file() and selection_consumed:
        authored_ink = align_binary_mask_to_output(
            decode_embedded_jbig2_mask(source_mrc_mask_path),
            output_metadata,
            output_size,
        )
    elif ink_path.is_file() or bilevel_path.is_file():
        with Image.open(ink_path if ink_path.is_file() else bilevel_path) as image:
            # Native PBM uses black samples for selected foreground ink.
            authored_ink = image.convert("L").resize(
                output_size,
                Image.Resampling.NEAREST,
            ).point(lambda value: 255 if value < 128 else 0)
    else:
        authored_ink = Image.new("L", output_size, 0)

    representation_foreground = authored_ink
    feather_radius = max(1, round(dpi * 2.0 / 25.4))
    if picture_path.is_file():
        with Image.open(picture_path) as image:
            # Native picture masks use black samples for protected tone.
            picture_owned = image.convert("L").resize(
                output_size,
                Image.Resampling.NEAREST,
            ).point(lambda value: 255 if value < 128 else 0)
        if trusted_mrc_page:
            # For trusted pages the compositor publishes its picture zones as
            # the picture-mask artifact: raw continuous tone inside zones,
            # smooth paper normalization outside. The zones are therefore the
            # exact tone-ownership record; heuristics over the rendered
            # background (any sub-white pixel) sweep in feather bands and
            # normalized remnants and misreport tone lifts.
            tone_owned = picture_owned
        else:
            tone_owned = ImageChops.lighter(tone_owned, picture_owned)
        # Selection fragments immediately beside a protected plate are
        # segmentation fringe, not independently owned text. Exclude the same
        # semantic 2 mm boundary used for the plate itself. This preserves
        # independent body/margin text while preventing picture texture from
        # becoming a false small-component retention sample.
        authored_ink = ImageChops.multiply(
            authored_ink,
            ImageOps.invert(_binary_dilation(picture_owned, feather_radius)),
        )

    # Tone ownership is meaningful only outside the explicit foreground
    # selection. The alpha intentionally feathers around glyphs and map lines;
    # counting those selected samples as a continuous-tone plate would turn
    # ordinary B&W foreground into false clipping/range failures.
    tone_owned = ImageChops.multiply(
        tone_owned,
        ImageOps.invert(_binary_dilation(authored_ink, 1)),
    )
    tone_boundary = ImageChops.difference(
        _binary_dilation(tone_owned, feather_radius),
        _binary_erosion(tone_owned, feather_radius),
    ).point(lambda value: 255 if value > 0 else 0)
    # The black foreground is another authored representation boundary. A
    # cleanup is expected to replace gray-paper samples beside that mask with
    # white, so those pre-existing glyph/line boundaries are not "new tone
    # edges". Keep this exclusion tight; unlike tone plates it has no 2 mm
    # feather and cannot hide a cut-out inside a protected picture.
    ink_boundary = _binary_dilation(
        representation_foreground,
        max(1, round(dpi * 2.00 / 25.4)),
    )
    ownership_boundary = ImageChops.lighter(tone_boundary, ink_boundary)
    if debug_prefix is not None:
        tone_owned.save(debug_prefix.with_name(f"{debug_prefix.name}-tone.png"))
        authored_ink.save(debug_prefix.with_name(f"{debug_prefix.name}-ink.png"))
        ownership_boundary.save(
            debug_prefix.with_name(f"{debug_prefix.name}-boundary.png")
        )
    return tone_owned, authored_ink, ownership_boundary


def ownership_metrics(
    aligned_source: Image.Image,
    output: Image.Image,
    tone_owned: Image.Image,
    authored_ink: Image.Image,
    ownership_boundary: Image.Image,
    dpi: int,
    *,
    blank_page: bool,
) -> OwnershipMetrics:
    source_gray = ImageOps.grayscale(aligned_source)
    output_gray = ImageOps.grayscale(output)
    if source_gray.size != output_gray.size:
        raise RuntimeError("Ownership audit requires aligned source/output dimensions")
    width, height = source_gray.size
    page_pixels = max(1, width * height)
    tone = _binary_mask(tone_owned)
    tone_bytes = memoryview(tone.tobytes())
    output_bytes = memoryview(output_gray.tobytes())

    # The retained plate is intentionally feathered into white paper. Its
    # transition band is a representation boundary, not authored tone: using
    # it for range fidelity compares source paper against the output blend and
    # reports contrast inflation even when the plate interior is unchanged.
    # Measure the authored core and keep the full mask for paper exclusion.
    tone_measurement = _binary_erosion(
        tone,
        max(1, round(dpi * 2.00 / 25.4)),
    )
    if tone_measurement.getbbox() is None:
        tone_measurement = tone
    # The metadata-convention alignment drifts sub-pixel on cleaned pages;
    # inside a high-contrast tone zone that bias skews the sampled median.
    # Register the source to the output with a small integer offset chosen to
    # minimize disagreement over the measured zone before sampling.
    def _shifted(image: Image.Image, dx: int, dy: int) -> Image.Image:
        if dx == 0 and dy == 0:
            return image
        shifted = Image.new("L", image.size, 255)
        shifted.paste(image, (dx, dy))
        return shifted

    best_shift = (0, 0)
    if tone_measurement.getbbox() is not None:
        best_error = None
        masked_output = ImageChops.multiply(output_gray, tone_measurement)
        for dy in (-3, -2, -1, 0, 1, 2, 3):
            for dx in (-3, -2, -1, 0, 1, 2, 3):
                masked_source = ImageChops.multiply(
                    _shifted(source_gray, dx, dy),
                    tone_measurement,
                )
                histogram = ImageChops.difference(
                    masked_source,
                    masked_output,
                ).histogram()
                error = sum(index * count for index, count in enumerate(histogram))
                if best_error is None or error < best_error:
                    best_error = error
                    best_shift = (dx, dy)
    tone_values_source = _masked_values(
        _shifted(source_gray, best_shift[0], best_shift[1]),
        tone_measurement,
    )
    tone_values_output = _masked_values(output_gray, tone_measurement)
    if tone_values_source:
        tone_source_p10 = _masked_percentile(tone_values_source, 0.10)
        tone_source_p50 = _masked_percentile(tone_values_source, 0.50)
        tone_source_p90 = _masked_percentile(tone_values_source, 0.90)
        tone_output_p10 = _masked_percentile(tone_values_output, 0.10)
        tone_output_p50 = _masked_percentile(tone_values_output, 0.50)
        tone_output_p90 = _masked_percentile(tone_values_output, 0.90)
        tone_range_ratio = (
            (tone_output_p90 - tone_output_p10)
            / max(1, tone_source_p90 - tone_source_p10)
        )
        tone_endpoint_fraction = sum(
            value in {0, 255}
            for value in tone_values_output
        ) / max(1, len(tone_values_output))
        tone_black_fraction = sum(
            value == 0
            for value in tone_values_output
        ) / max(1, len(tone_values_output))
    else:
        tone_source_p50 = 255
        tone_output_p50 = 255
        tone_range_ratio = 1.0
        tone_endpoint_fraction = 0.0
        tone_black_fraction = 0.0

    source_ink = _binary_mask(authored_ink)
    # Global bbox registration proved hazardous (a mis-registration moved a
    # sparse page's mask completely off) and redundant: the per-component
    # 3mm local search below absorbs the placement-convention drift directly.
    source_components = [
        component
        for component in _component_records(source_ink)
        if component["area"] >= 2
    ]
    filtered_bytes = bytearray(page_pixels)
    for component in source_components:
        for y, start, end in component["runs"]:
            filtered_bytes[y * width + start:y * width + end + 1] = (
                b"\xff" * (end - start + 1)
            )
    source_ink_filtered = Image.frombytes(
        "L",
        (width, height),
        bytes(filtered_bytes),
    )
    output_ink = Image.frombytes(
        "L",
        (width, height),
        bytes(
            255 if value < 250 else 0
            for value in output_bytes
        ),
    )
    output_ink_nearby = _binary_dilation(
        output_ink,
        max(1, round(dpi * 1.00 / 25.4)),
    )
    ink_components = _component_records(
        source_ink_filtered,
        output_ink_nearby,
    )
    source_ink_pixels = sum(bool(value) for value in filtered_bytes)
    # 3mm at step 1: thin (1-2px) glyph strokes need single-pixel search
    # resolution, and the observed placement-convention drift reaches ~2.4mm
    # on content-normalized sparse pages.
    search = max(4, round(dpi * 3.0 / 25.4))
    matched_ink = 0
    for component in ink_components:
        best_retained = component["retained"]
        if (
            component["area"] <= 50_000
            and best_retained / max(1, component["area"]) < 0.50
        ):
            left = component["left"]
            top = component["top"]
            right = component["right"]
            bottom = component["bottom"]
            component_width = right - left + 1
            component_height = bottom - top + 1
            component_bytes = bytearray(component_width * component_height)
            for y, start, end in component["runs"]:
                row = (y - top) * component_width
                component_bytes[
                    row + start - left:row + end - left + 1
                ] = b"\xff" * (end - start + 1)
            component_image = Image.frombytes(
                "L",
                (component_width, component_height),
                bytes(component_bytes),
            )
            window = output_ink_nearby.crop(
                (
                    max(0, left - search),
                    max(0, top - search),
                    min(width, right + search + 1),
                    min(height, bottom + search + 1),
                )
            )
            for dy in range(-search, search + 1):
                for dx in range(-search, search + 1):
                    overlap = ImageChops.multiply(
                        component_image,
                        window.crop(
                            (
                                search + dx,
                                search + dy,
                                search + dx + component_width,
                                search + dy + component_height,
                            )
                        ),
                    ).histogram()[255]
                    best_retained = max(best_retained, overlap)
        component["retained"] = best_retained
        matched_ink += best_retained
    output_ink_ratio = matched_ink / max(1, source_ink_pixels)
    maximum_small_dimension = max(1, round(dpi * 2.0 / 25.4))
    small_components = [
        component
        for component in ink_components
        if max(
            component["right"] - component["left"] + 1,
            component["bottom"] - component["top"] + 1,
        ) <= maximum_small_dimension
    ]
    retained_small = [
        component
        for component in small_components
        if component["retained"] / max(1, component["area"]) >= 0.50
    ]
    margin_x = round(width * 0.15)
    margin_y = round(height * 0.15)
    margin_small = [
        component
        for component in small_components
        if (
            component["left"] < margin_x
            or component["right"] >= width - margin_x
            or component["top"] < margin_y
            or component["bottom"] >= height - margin_y
        )
    ]
    retained_margin_small = [
        component
        for component in margin_small
        if component["retained"] / max(1, component["area"]) >= 0.50
    ]

    # Paper residual measures isolated gray dirt. Antialiased fringes of
    # rendered output ink are not paper.
    output_true_ink = Image.frombytes(
        "L",
        (width, height),
        bytes(255 if value < 128 else 0 for value in output_bytes),
    )
    output_ink_adjacent = _binary_dilation(
        output_true_ink,
        max(1, round(dpi * 0.35 / 25.4)),
    )
    paper = ImageChops.multiply(
        ImageOps.invert(tone),
        ImageOps.invert(
            _binary_dilation(
                source_ink_filtered,
                max(1, round(dpi * 1.00 / 25.4)),
            )
        ),
    )
    paper = ImageChops.multiply(paper, ImageOps.invert(output_ink_adjacent))
    paper_values = _masked_values(output_gray, paper)
    paper_p75 = _masked_percentile(paper_values, 0.75)
    paper_p90 = _masked_percentile(paper_values, 0.90)
    zone_bright_fraction = (
        sum(value >= 240 for value in tone_values_output)
        / max(1, len(tone_values_output))
        if tone_values_source
        else 0.0
    )
    paper_residual_gray = sum(
        140 <= value < 250
        for value in paper_values
    ) / max(1, len(paper_values))
    largest_blank_component_mm2 = 0.0
    if blank_page:
        paper_bytes = memoryview(_binary_mask(paper).tobytes())
        nonwhite = Image.frombytes(
            "L",
            (width, height),
            bytes(
                255 if value < 250 and selected else 0
                for value, selected in zip(
                    output_bytes,
                    paper_bytes,
                    strict=True,
                )
            ),
        )
        largest_area = max(
            (
                component["area"]
                for component in _component_records(nonwhite)
            ),
            default=0,
        )
        largest_blank_component_mm2 = (
            largest_area / max(1.0, (dpi / 25.4) ** 2)
        )

    return OwnershipMetrics(
        tone_coverage_fraction=sum(bool(value) for value in tone_bytes)
        / page_pixels,
        tone_source_p50=tone_source_p50,
        tone_output_p50=tone_output_p50,
        tone_p50_lift=tone_output_p50 - tone_source_p50,
        tone_range_ratio=tone_range_ratio,
        tone_output_endpoint_fraction=tone_endpoint_fraction,
        tone_output_black_fraction=tone_black_fraction,
        source_ink_pixels=source_ink_pixels,
        output_ink_ratio=output_ink_ratio,
        small_component_count=len(small_components),
        small_component_retention=(
            len(retained_small) / max(1, len(small_components))
        ),
        margin_small_component_count=len(margin_small),
        margin_small_component_retention=(
            len(retained_margin_small) / max(1, len(margin_small))
        ),
        paper_pixel_count=len(paper_values),
        paper_p75=paper_p75,
        paper_p90=paper_p90,
        zone_bright_fraction=zone_bright_fraction,
        paper_residual_gray_fraction=paper_residual_gray,
        blank_largest_nonwhite_component_mm2=largest_blank_component_mm2,
        ownership_boundary_fraction=sum(
            bool(value)
            for value in _binary_mask(ownership_boundary).tobytes()
        ) / page_pixels,
    )


def source_fidelity_metrics(
    aligned_source: Image.Image,
    output: Image.Image,
    edge_exclusion_mask: Image.Image | None = None,
    edge_debug_path: Path | None = None,
) -> SourceFidelityMetrics:
    """Measure source-relative tone damage and cleanup-only boundaries.

    Pixel residuals remain page-wide. New-edge accounting excludes only
    authored representation boundaries: the physical tone-plate feather and a
    tight band around the explicit foreground selection. Intentional
    paper-to-plate and paper-to-ink transitions belong there, while cut-outs
    and washout edges inside either region remain observable. Downsampling
    bounds runtime.
    """

    source_gray = ImageOps.grayscale(aligned_source)
    output_gray = ImageOps.grayscale(output)
    if source_gray.size != output_gray.size:
        raise RuntimeError("Source-fidelity audit requires aligned dimensions")
    maximum_dimension = max(source_gray.size)
    if maximum_dimension > 1000:
        scale = 1000.0 / maximum_dimension
        resized = (
            max(1, round(source_gray.width * scale)),
            max(1, round(source_gray.height * scale)),
        )
        source_gray = source_gray.resize(resized, Image.Resampling.LANCZOS)
        output_gray = output_gray.resize(resized, Image.Resampling.LANCZOS)
        if edge_exclusion_mask is not None:
            edge_exclusion_mask = edge_exclusion_mask.resize(
                resized,
                Image.Resampling.NEAREST,
            )
    width, height = source_gray.size
    source_pixels = memoryview(source_gray.tobytes())
    output_pixels = memoryview(output_gray.tobytes())
    excluded = (
        memoryview(edge_exclusion_mask.convert("L").tobytes())
        if edge_exclusion_mask is not None
        else None
    )
    # The source PDF and the assembled PDF are rasterized independently.
    # Directly comparing the same pixel makes a subpixel placement difference
    # around every original glyph/image edge look like cleanup damage. Use a
    # source envelope instead: an unchanged, resampled source pixel is accepted
    # when its value exists within nearby source pixels, while a white cut-out
    # inside a smooth gray field remains a large residual.
    source_minimum = memoryview(
        source_gray.filter(ImageFilter.MinFilter(5)).tobytes()
    )
    source_maximum = memoryview(
        source_gray.filter(ImageFilter.MaxFilter(5)).tobytes()
    )
    residual = []
    for index, sample in enumerate(output_pixels):
        value = int(sample)
        lower = int(source_minimum[index])
        upper = int(source_maximum[index])
        if value < lower:
            residual.append(value - lower)
        elif value > upper:
            residual.append(value - upper)
        else:
            residual.append(0)
    absolute_histogram = [0] * 256
    absolute_sum = 0
    for value in residual:
        absolute = abs(value)
        absolute_histogram[absolute] += 1
        absolute_sum += absolute

    source_horizontal_edges = bytearray(width * height)
    source_vertical_edges = bytearray(width * height)
    for y in range(height):
        row = y * width
        for x in range(width - 1):
            index = row + x
            source_horizontal_edges[index] = abs(
                int(source_pixels[index + 1]) - int(source_pixels[index])
            )
    for y in range(height - 1):
        row = y * width
        next_row = row + width
        for x in range(width):
            index = row + x
            below = next_row + x
            source_vertical_edges[index] = abs(
                int(source_pixels[below]) - int(source_pixels[index])
            )
    # At the bounded 1000 px audit resolution this is approximately a 1 mm
    # source-edge neighbourhood. It absorbs independent rasterizer/JPEG
    # placement without hiding a genuinely introduced boundary in a smooth
    # tone-owned region.
    nearby_horizontal_edges = memoryview(
        Image.frombytes("L", (width, height), bytes(source_horizontal_edges))
        .filter(ImageFilter.MaxFilter(9))
        .tobytes()
    )
    nearby_vertical_edges = memoryview(
        Image.frombytes("L", (width, height), bytes(source_vertical_edges))
        .filter(ImageFilter.MaxFilter(9))
        .tobytes()
    )

    new_edges = 0
    possible_edges = 0
    new_edge_pixels = (
        bytearray(width * height)
        if edge_debug_path is not None
        else None
    )
    for y in range(height):
        row = y * width
        for x in range(width - 1):
            index = row + x
            if (
                excluded is not None
                and (excluded[index] > 0 or excluded[index + 1] > 0)
            ):
                continue
            possible_edges += 1
            if (
                abs(
                    int(output_pixels[index + 1])
                    - int(output_pixels[index])
                ) >= 18
                and int(nearby_horizontal_edges[index]) <= 8
            ):
                new_edges += 1
                if new_edge_pixels is not None:
                    new_edge_pixels[index] = 255
                    new_edge_pixels[index + 1] = 255
    for y in range(height - 1):
        row = y * width
        next_row = row + width
        for x in range(width):
            index = row + x
            below = next_row + x
            if (
                excluded is not None
                and (excluded[index] > 0 or excluded[below] > 0)
            ):
                continue
            possible_edges += 1
            if (
                abs(int(output_pixels[below]) - int(output_pixels[index])) >= 18
                and int(nearby_vertical_edges[index]) <= 8
            ):
                new_edges += 1
                if new_edge_pixels is not None:
                    new_edge_pixels[index] = 255
                    new_edge_pixels[below] = 255

    if edge_debug_path is not None and new_edge_pixels is not None:
        Image.frombytes(
            "L",
            (width, height),
            bytes(new_edge_pixels),
        ).save(edge_debug_path)

    return SourceFidelityMetrics(
        mean_absolute_error=absolute_sum / max(1, len(residual)),
        p99_absolute_error=percentile(absolute_histogram, 0.99),
        new_edge_fraction=new_edges / max(1, possible_edges),
        new_edge_count=new_edges,
    )


def numpy_block_seam_runs(
    source_gray: Image.Image,
    output_gray: Image.Image,
    dpi: int,
) -> list[tuple[str, int, int, int, int]]:
    if np is None:
        raise RuntimeError("NumPy seam path called without NumPy")
    source = np.asarray(source_gray, dtype=np.int16)
    cleaned = np.asarray(output_gray, dtype=np.int16)
    residual = cleaned - source
    minimum_run = max(12, round(dpi * 0.30))
    radius = max(2, round(dpi * 0.015))
    border = radius + 1
    height, width = source.shape
    runs: list[tuple[str, int, int, int, int]] = []

    def record_mask_runs(
        direction: str,
        fixed: int,
        values: Any,
        jumps: Any,
    ) -> None:
        transitions = np.diff(
            np.pad(values.astype(np.int8, copy=False), (1, 1))
        )
        starts = np.flatnonzero(transitions == 1)
        ends = np.flatnonzero(transitions == -1) - 1
        for start, end in zip(starts, ends, strict=True):
            if end - start + 1 < minimum_run:
                continue
            runs.append(
                (
                    direction,
                    fixed,
                    int(start),
                    int(end),
                    int(jumps[start:end + 1].max(initial=0)),
                )
            )

    vertical_jump = np.abs(np.diff(residual, axis=1))
    source_vertical_jump = np.abs(np.diff(source, axis=1))
    source_vertical_smooth = (
        np.lib.stride_tricks.sliding_window_view(
            source_vertical_jump,
            2 * radius + 1,
            axis=1,
        ).max(axis=-1)
        <= 8
    )
    vertical_candidates = np.zeros_like(vertical_jump, dtype=np.bool_)
    vertical_candidates[:, radius:width - 1 - radius] = (
        (vertical_jump[:, radius:width - 1 - radius] >= 18)
        & source_vertical_smooth
    )
    vertical_candidates[:border, :] = False
    vertical_candidates[height - border:, :] = False
    vertical_candidates[:, :border] = False
    vertical_candidates[:, width - border - 1:] = False
    for x in np.flatnonzero(vertical_candidates.any(axis=0)):
        record_mask_runs(
            "vertical",
            int(x),
            vertical_candidates[:, x],
            vertical_jump[:, x],
        )
    del (
        source_vertical_jump,
        source_vertical_smooth,
        vertical_candidates,
        vertical_jump,
    )

    horizontal_jump = np.abs(np.diff(residual, axis=0))
    source_horizontal_jump = np.abs(np.diff(source, axis=0))
    source_horizontal_smooth = (
        np.lib.stride_tricks.sliding_window_view(
            source_horizontal_jump,
            2 * radius + 1,
            axis=0,
        ).max(axis=-1)
        <= 8
    )
    horizontal_candidates = np.zeros_like(horizontal_jump, dtype=np.bool_)
    horizontal_candidates[radius:height - 1 - radius, :] = (
        (horizontal_jump[radius:height - 1 - radius, :] >= 18)
        & source_horizontal_smooth
    )
    horizontal_candidates[:border, :] = False
    horizontal_candidates[height - border - 1:, :] = False
    horizontal_candidates[:, :border] = False
    horizontal_candidates[:, width - border:] = False
    for y in np.flatnonzero(horizontal_candidates.any(axis=1)):
        record_mask_runs(
            "horizontal",
            int(y),
            horizontal_candidates[y, :],
            horizontal_jump[y, :],
        )
    return runs


def block_seam_metrics(
    aligned_source: Image.Image,
    output: Image.Image,
    dpi: int,
) -> SeamMetrics:
    """Find connected cleanup-only paper block boundaries."""
    source_gray = aligned_source.convert("L")
    output_gray = output.convert("L")
    if source_gray.size != output_gray.size:
        raise RuntimeError("Block-seam audit requires aligned source/output dimensions")
    width, height = source_gray.size
    if width < 8 or height < 8:
        return SeamMetrics(0, 0, 0, 0)
    if np is not None:
        return confirmed_block_seam_metrics(
            numpy_block_seam_runs(source_gray, output_gray, dpi),
            dpi,
            width,
            height,
        )

    source_pixels = memoryview(source_gray.tobytes())
    output_pixels = memoryview(output_gray.tobytes())
    minimum_run = max(12, round(dpi * 0.30))
    edge_exclusion_radius = max(2, round(dpi * 0.015))
    border = edge_exclusion_radius + 1
    seam_runs: list[tuple[str, int, int, int, int]] = []

    def record_run(
        direction: str,
        fixed: int,
        start: int,
        length: int,
        jump: int,
    ) -> None:
        if length >= minimum_run:
            seam_runs.append((direction, fixed, start, start + length - 1, jump))

    for x in range(border, width - border - 1):
        run_length = 0
        run_jump = 0
        run_start = border
        for y in range(border, height - border):
            index = y * width + x
            residual_left = output_pixels[index] - source_pixels[index]
            residual_right = output_pixels[index + 1] - source_pixels[index + 1]
            residual_jump = abs(residual_right - residual_left)
            candidate = (
                residual_jump >= 18
                and all(
                    abs(
                        source_pixels[index + offset + 1]
                        - source_pixels[index + offset]
                    ) <= 8
                    for offset in range(
                        -edge_exclusion_radius,
                        edge_exclusion_radius + 1,
                    )
                )
            )
            if candidate:
                if run_length == 0:
                    run_start = y
                run_length += 1
                run_jump = max(run_jump, residual_jump)
            else:
                record_run("vertical", x, run_start, run_length, run_jump)
                run_length = 0
                run_jump = 0
        record_run("vertical", x, run_start, run_length, run_jump)

    for y in range(border, height - border - 1):
        run_length = 0
        run_jump = 0
        run_start = border
        row = y * width
        next_row = row + width
        for x in range(border, width - border):
            index = row + x
            below = next_row + x
            residual_top = output_pixels[index] - source_pixels[index]
            residual_bottom = output_pixels[below] - source_pixels[below]
            residual_jump = abs(residual_bottom - residual_top)
            candidate = (
                residual_jump >= 18
                and all(
                    abs(
                        source_pixels[index + offset * width + width]
                        - source_pixels[index + offset * width]
                    ) <= 8
                    for offset in range(
                        -edge_exclusion_radius,
                        edge_exclusion_radius + 1,
                    )
                )
            )
            if candidate:
                if run_length == 0:
                    run_start = x
                run_length += 1
                run_jump = max(run_jump, residual_jump)
            else:
                record_run("horizontal", y, run_start, run_length, run_jump)
                run_length = 0
                run_jump = 0
        record_run("horizontal", y, run_start, run_length, run_jump)
    return confirmed_block_seam_metrics(seam_runs, dpi, width, height)


def continuous_tone_metrics(
    aligned_source: Image.Image,
    output: Image.Image,
    dpi: int,
) -> ToneMetrics | None:
    """Compare source-derived continuous-tone regions, independent of engine masks."""

    source_gray = ImageOps.grayscale(aligned_source)
    output_gray = ImageOps.grayscale(output)
    if output_gray.size != source_gray.size:
        output_gray = output_gray.resize(
            source_gray.size,
            Image.Resampling.LANCZOS,
        )
    tile_size = max(12, round(dpi * 0.20))
    columns = math.ceil(source_gray.width / tile_size)
    rows = math.ceil(source_gray.height / tile_size)
    tile_histograms: dict[tuple[int, int], tuple[list[int], int]] = {}
    noise_estimates: list[float] = []
    for tile_y in range(rows):
        for tile_x in range(columns):
            box = (
                tile_x * tile_size,
                tile_y * tile_size,
                min(source_gray.width, (tile_x + 1) * tile_size),
                min(source_gray.height, (tile_y + 1) * tile_size),
            )
            histogram = source_gray.crop(box).histogram()
            pixel_count = max(1, sum(histogram))
            tile_histograms[(tile_x, tile_y)] = (histogram, pixel_count)
            noise_estimates.append(
                (percentile(histogram, 0.75) - percentile(histogram, 0.25))
                / 1.349
            )
    noise_estimates.sort()
    noise_sigma = (
        noise_estimates[len(noise_estimates) // 5]
        if noise_estimates
        else 1.0
    )
    noise_sigma = max(1.0, min(12.0, noise_sigma))
    minimum_robust_range = max(24, math.ceil(noise_sigma * 6.0))
    mode_radius = max(2, min(30, math.ceil(noise_sigma * 2.5)))

    def otsu_explained_variance(histogram: list[int], pixel_count: int) -> float:
        if pixel_count <= 1:
            return 0.0
        total = float(pixel_count)
        mean = sum(level * count for level, count in enumerate(histogram)) / total
        total_variance = sum(
            (level - mean) ** 2 * count
            for level, count in enumerate(histogram)
        )
        if total_variance <= 1e-9:
            return 0.0
        total_sum = mean * total
        lower_weight = 0.0
        lower_sum = 0.0
        maximum_between = 0.0
        for level, count in enumerate(histogram):
            lower_weight += count
            lower_sum += level * count
            upper_weight = total - lower_weight
            if lower_weight <= 0 or upper_weight <= 0:
                continue
            lower_mean = lower_sum / lower_weight
            upper_mean = (total_sum - lower_sum) / upper_weight
            maximum_between = max(
                maximum_between,
                lower_weight * upper_weight * (lower_mean - upper_mean) ** 2
                / total,
            )
        return maximum_between / total_variance

    candidates: set[tuple[int, int]] = set()
    for tile_y in range(rows):
        for tile_x in range(columns):
            histogram, pixel_count = tile_histograms[(tile_x, tile_y)]
            p10 = percentile(histogram, 0.10)
            p90 = percentile(histogram, 0.90)
            robust_range = p90 - p10
            if robust_range < minimum_robust_range:
                continue
            middle_start = p10 + robust_range // 3
            middle_end = p90 - robust_range // 3
            middle_fraction = (
                sum(histogram[middle_start:middle_end + 1]) / pixel_count
            )
            mode = max(range(256), key=histogram.__getitem__)
            mode_fraction = (
                sum(
                    histogram[
                        max(0, mode - mode_radius):
                        min(256, mode + mode_radius + 1)
                    ]
                )
                / pixel_count
            )
            # Continuous tone has a distributed local histogram. Uniform paper
            # with scanner noise still has one broad paper mode; text has a
            # near-binary Otsu split. Both are rejected independently of the
            # paper's absolute shade and the exact number of populated bins.
            if (
                middle_fraction >= 0.12
                and mode_fraction < 0.55
                and otsu_explained_variance(histogram, pixel_count) < 0.90
                and p10 < 245
            ):
                candidates.add((tile_x, tile_y))

    components: list[list[tuple[int, int]]] = []
    while candidates:
        stack = [candidates.pop()]
        component: list[tuple[int, int]] = []
        while stack:
            tile_x, tile_y = stack.pop()
            component.append((tile_x, tile_y))
            for neighbor in (
                (tile_x - 1, tile_y),
                (tile_x + 1, tile_y),
                (tile_x, tile_y - 1),
                (tile_x, tile_y + 1),
            ):
                if neighbor in candidates:
                    candidates.remove(neighbor)
                    stack.append(neighbor)
        components.append(component)

    page_area = max(1, source_gray.width * source_gray.height)
    retained = [
        component
        for component in components
        if len(component) * tile_size * tile_size >= page_area * 0.005
    ]
    mask = Image.new("L", source_gray.size, 0)
    draw = ImageDraw.Draw(mask)
    for component in retained:
        for tile_x, tile_y in component:
            draw.rectangle(
                (
                    tile_x * tile_size,
                    tile_y * tile_size,
                    min(
                        source_gray.width - 1,
                        (tile_x + 1) * tile_size - 1,
                    ),
                    min(
                        source_gray.height - 1,
                        (tile_y + 1) * tile_size - 1,
                    ),
                ),
                fill=255,
            )
    source_histogram = source_gray.histogram(mask=mask)
    tonal_pixels = sum(source_histogram)
    coverage_fraction = tonal_pixels / page_area
    if coverage_fraction < 0.02:
        return None
    output_histogram = output_gray.histogram(mask=mask)
    source_p10 = percentile(source_histogram, 0.10)
    source_p50 = percentile(source_histogram, 0.50)
    source_p90 = percentile(source_histogram, 0.90)
    output_p10 = percentile(output_histogram, 0.10)
    output_p50 = percentile(output_histogram, 0.50)
    output_p90 = percentile(output_histogram, 0.90)
    output_pixels = max(1, sum(output_histogram))
    return ToneMetrics(
        coverage_fraction=coverage_fraction,
        component_count=len(retained),
        source_p10=source_p10,
        source_p50=source_p50,
        source_p90=source_p90,
        output_p10=output_p10,
        output_p50=output_p50,
        output_p90=output_p90,
        p10_lift=output_p10 - source_p10,
        p50_lift=output_p50 - source_p50,
        range_ratio=(
            (output_p90 - output_p10)
            / max(1, source_p90 - source_p10)
        ),
        output_endpoint_fraction=(
            output_histogram[0] + output_histogram[255]
        ) / output_pixels,
    )


def page_size_points(pdf_path: Path, page: int) -> tuple[float, float]:
    output = run([
        "pdfinfo",
        "-f",
        str(page),
        "-l",
        str(page),
        str(pdf_path),
    ])
    match = re.search(
        r"Page(?:\s+\d+)?\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts",
        output,
    )
    if match is None:
        raise RuntimeError(f"pdfinfo did not report page {page} dimensions")
    return float(match.group(1)), float(match.group(2))


def rasterize_range(
    pdf_path: Path,
    first_page: int,
    last_page: int,
    dpi: int,
    prefix: Path,
    max_dimension_px: int,
) -> tuple[list[Path], dict[str, Any] | None]:
    width_points, height_points = page_size_points(pdf_path, first_page)
    projected_max = max(width_points, height_points) / 72 * dpi
    cap = None
    scale_arguments = [
        "-r",
        str(dpi),
    ]
    if projected_max > max_dimension_px:
        effective_dpi = max_dimension_px / max(width_points, height_points) * 72
        cap = {
            "pdf": str(pdf_path.resolve()),
            "firstPage": first_page,
            "lastPage": last_page,
            "requestedDpi": dpi,
            "effectiveDpi": effective_dpi,
            "maxDimensionPx": max_dimension_px,
            "pageSizePoints": [width_points, height_points],
        }
        scale_arguments = [
            "-scale-to",
            str(max_dimension_px),
        ]
    run([
        "pdftoppm",
        "-f",
        str(first_page),
        "-l",
        str(last_page),
        *scale_arguments,
        "-png",
        str(pdf_path),
        str(prefix),
    ])
    paths = sorted(
        prefix.parent.glob(f"{prefix.name}-*.png"),
        key=lambda path: int(path.stem.rsplit("-", 1)[1]),
    )
    expected = last_page - first_page + 1
    if len(paths) != expected:
        raise RuntimeError(
            f"pdftoppm produced {len(paths)} pages for {first_page}-{last_page}; "
            f"expected {expected}"
        )
    return paths, cap


def thumbnail(image: Image.Image, label: str) -> Image.Image:
    tile_width = 174
    tile_height = 242
    label_height = 26
    canvas = Image.new("RGB", (tile_width, tile_height + label_height), "white")
    copy = image.convert("RGB")
    copy.thumbnail((tile_width - 8, tile_height - 8), Image.Resampling.LANCZOS)
    x = (tile_width - copy.width) // 2
    y = (tile_height - copy.height) // 2
    canvas.paste(copy, (x, y))
    ImageDraw.Draw(canvas).text(
        (4, tile_height + 5),
        label,
        fill="black",
        font=ImageFont.load_default(),
    )
    return canvas


def save_sheets(tiles: list[Image.Image], output_prefix: Path, columns: int = 6) -> None:
    if not tiles:
        return
    per_sheet = 60
    for sheet_index, offset in enumerate(range(0, len(tiles), per_sheet), start=1):
        sheet_tiles = tiles[offset:offset + per_sheet]
        rows = math.ceil(len(sheet_tiles) / columns)
        width = columns * sheet_tiles[0].width
        height = rows * sheet_tiles[0].height
        sheet = Image.new("RGB", (width, height), "#d0d0d0")
        for index, tile in enumerate(sheet_tiles):
            sheet.paste(
                tile,
                ((index % columns) * tile.width, (index // columns) * tile.height),
            )
        sheet.save(output_prefix.with_name(f"{output_prefix.name}-{sheet_index:02d}.jpg"), quality=90)


def paired_tile(source_tile: Image.Image, output_tile: Image.Image) -> Image.Image:
    pair = Image.new(
        "RGB",
        (source_tile.width + output_tile.width, source_tile.height),
        "#b0b0b0",
    )
    pair.paste(source_tile, (0, 0))
    pair.paste(output_tile, (source_tile.width, 0))
    return pair


def write_csv(path: Path, audits: Iterable[PageAudit]) -> None:
    rows = []
    for audit in audits:
        row: dict[str, Any] = {
            "page": audit.page,
            "output_page": audit.output_page,
            "output_index": audit.output_index,
            "mode": audit.mode,
            "rule": audit.rule,
            "gray_severity": audit.gray_severity,
            "tone_damage_score": audit.tone_damage_score,
            "white_fraction_gain": audit.white_fraction_gain,
            "dark_fraction_ratio": audit.dark_fraction_ratio,
        }
        row.update({
            f"edge_{key}": value
            for key, value in asdict(audit.edge_artifacts).items()
        })
        if audit.source_fidelity is not None:
            row.update({
                f"fidelity_{key}": value
                for key, value in asdict(audit.source_fidelity).items()
            })
        if audit.ownership is not None:
            row.update({
                f"ownership_{key}": value
                for key, value in asdict(audit.ownership).items()
            })
        if audit.crop is not None:
            row.update({f"crop_{key}": value for key, value in asdict(audit.crop).items()})
        if audit.tone is not None:
            row.update({f"tone_{key}": value for key, value in asdict(audit.tone).items()})
        row.update({f"source_{key}": value for key, value in asdict(audit.source).items()})
        row.update({f"output_{key}": value for key, value in asdict(audit.output).items()})
        rows.append(row)
    with path.open("w", newline="", encoding="utf-8") as handle:
        fieldnames = list(dict.fromkeys(
            key
            for row in rows
            for key in row
        ))
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    args = parse_args()
    analysis_metadata_dir = args.analysis_metadata_dir or args.metadata_dir
    if args.dpi < 150:
        raise RuntimeError("--dpi must be at least 150 for artifact acceptance")
    if args.max_dimension_px < 1000:
        raise RuntimeError("--max-dimension-px must be at least 1000")
    for command in ("pdfinfo", "pdftoppm"):
        if shutil.which(command) is None:
            raise RuntimeError(f"Required command is unavailable: {command}")
    source_pdf_pages = page_count(args.source_pdf)
    output_pages = page_count(args.output_pdf)
    if args.source_pages:
        source_page_numbers = [
            int(value.strip())
            for value in args.source_pages.split(",")
            if value.strip()
        ]
        if (
            len(source_page_numbers) != output_pages
            or any(page < 1 or page > source_pdf_pages for page in source_page_numbers)
        ):
            raise RuntimeError(
                "--source-pages must contain one valid source page per output page"
            )
    else:
        source_page_numbers = list(range(1, source_pdf_pages + 1))
    if len(source_page_numbers) != output_pages:
        raise RuntimeError(
            f"Page-count mismatch: source={len(source_page_numbers)}, output={output_pages}"
        )
    if args.metadata_pages:
        metadata_page_numbers = [
            int(value.strip())
            for value in args.metadata_pages.split(",")
            if value.strip()
        ]
        if (
            len(metadata_page_numbers) != output_pages
            or any(page < 1 for page in metadata_page_numbers)
        ):
            raise RuntimeError(
                "--metadata-pages must contain one positive metadata page per output page"
            )
    else:
        metadata_page_numbers = source_page_numbers
    next_output_index_by_source_page: dict[int, int] = {}
    source_output_refs: list[tuple[int, int]] = []
    for source_page in source_page_numbers:
        output_index = next_output_index_by_source_page.get(source_page, 0)
        source_output_refs.append((source_page, output_index))
        next_output_index_by_source_page[source_page] = output_index + 1
    next_output_index_by_metadata_page: dict[int, int] = {}
    metadata_output_refs: list[tuple[int, int]] = []
    for metadata_page in metadata_page_numbers:
        output_index = next_output_index_by_metadata_page.get(metadata_page, 0)
        metadata_output_refs.append((metadata_page, output_index))
        next_output_index_by_metadata_page[metadata_page] = output_index + 1
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    audits: list[PageAudit] = []
    source_thumbnails: dict[int, Image.Image] = {}
    output_thumbnails: dict[int, Image.Image] = {}
    raster_cap_events: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix="evb-scan-audit-") as temporary:
        temporary_path = Path(temporary)
        preserved_page_ordinals: dict[int, int] | None = None
        rasterized_preserved_pages: dict[int, Image.Image] = {}
        preserved_pages_available: bool | None = None

        def rasterized_preserved_page_for(
            source_page_index: int,
        ) -> Image.Image | None:
            nonlocal preserved_page_ordinals, preserved_pages_available
            preserved_metadata_path = (
                args.metadata_dir / "preserved-source-pages.json"
            )
            preserved_pdf_path = (
                args.metadata_dir / "preserved-source-pages.pdf"
            )
            if preserved_pages_available is None:
                preserved_pages_available = (
                    preserved_metadata_path.exists()
                    and preserved_pdf_path.exists()
                )
                if preserved_pages_available:
                    preserved_metadata = json.loads(
                        preserved_metadata_path.read_text(encoding="utf-8")
                    )
                    preserved_page_ordinals = {
                        int(page["sourcePageIndex"]): ordinal
                        for ordinal, page
                        in enumerate(preserved_metadata["pages"])
                    }
            if (
                not preserved_pages_available
                or preserved_page_ordinals is None
            ):
                return None
            preserved_page_index = preserved_page_ordinals.get(
                source_page_index
            )
            if preserved_page_index is None:
                return None
            cached = rasterized_preserved_pages.get(preserved_page_index)
            if cached is not None:
                return cached
            paths, preserved_cap = rasterize_range(
                preserved_pdf_path,
                preserved_page_index + 1,
                preserved_page_index + 1,
                args.dpi,
                temporary_path / f"preserved-{preserved_page_index}",
                args.max_dimension_px,
            )
            if preserved_cap is not None:
                raster_cap_events.append(preserved_cap)
            with Image.open(paths[0]) as preserved_image:
                rasterized = preserved_image.copy()
            rasterized_preserved_pages[preserved_page_index] = rasterized
            return rasterized

        for first_page in range(1, output_pages + 1, args.batch_size):
            last_page = min(output_pages, first_page + args.batch_size - 1)
            source_batch = [
                source_page
                for source_page, _output_index
                in source_output_refs[first_page - 1:last_page]
            ]
            if source_batch == list(range(source_batch[0], source_batch[-1] + 1)):
                source_paths, source_cap = rasterize_range(
                    args.source_pdf,
                    source_batch[0],
                    source_batch[-1],
                    args.dpi,
                    temporary_path / "source",
                    args.max_dimension_px,
                )
                if source_cap is not None:
                    raster_cap_events.append(source_cap)
            else:
                source_paths = []
                for index, source_page in enumerate(source_batch):
                    paths, source_cap = rasterize_range(
                        args.source_pdf,
                        source_page,
                        source_page,
                        args.dpi,
                        temporary_path / (
                            f"source-{source_page}-output-{first_page + index}"
                        ),
                        args.max_dimension_px,
                    )
                    source_paths.append(paths[0])
                    if source_cap is not None:
                        raster_cap_events.append(source_cap)
            output_paths, output_cap = rasterize_range(
                args.output_pdf,
                first_page,
                last_page,
                args.dpi,
                temporary_path / "output",
                args.max_dimension_px,
            )
            if output_cap is not None:
                raster_cap_events.append(output_cap)
            for offset, (source_path, output_path) in enumerate(
                zip(source_paths, output_paths, strict=True)
            ):
                output_page = first_page + offset
                page, output_index = source_output_refs[output_page - 1]
                metadata_page, metadata_output_index = metadata_output_refs[
                    output_page - 1
                ]
                with Image.open(source_path) as source_image, Image.open(output_path) as output_image:
                    mode, rule, crop, diagnostics, output_metadata = load_metadata(
                        args.metadata_dir,
                        metadata_page,
                        metadata_output_index,
                        analysis_metadata_dir=analysis_metadata_dir,
                        analysis_page=page,
                    )
                    source_region = source_region_image(source_image, output_metadata)
                    source_metrics = metrics(source_region)
                    output_metrics = metrics(output_image)
                    source_identity_expected = (
                        output_metadata.get("trustedMrcBackgroundPreserved")
                        is True
                    )
                    if (
                        source_identity_expected
                        and metadata_output_index == 0
                    ):
                        source_page_index = int(
                            output_metadata["sourcePageIndex"]
                        )
                        preserved = rasterized_preserved_page_for(
                            source_page_index
                        )
                        if preserved is not None:
                            aligned_source = preserved.convert("RGB").resize(
                                output_image.size,
                                Image.Resampling.BICUBIC,
                            )
                        else:
                            aligned_source = align_source_to_output(
                                source_image,
                                output_metadata,
                                output_image.size,
                            )
                    else:
                        aligned_source = align_source_to_output(
                            source_image,
                            output_metadata,
                            output_image.size,
                        )
                    tone = continuous_tone_metrics(
                        aligned_source,
                        output_image,
                        args.dpi,
                    )
                    seams = block_seam_metrics(
                        aligned_source,
                        output_image,
                        args.dpi,
                    )
                    edge_artifacts = introduced_edge_artifact_metrics(
                        aligned_source,
                        output_image,
                        args.dpi,
                    )
                    trusted_mrc_page = (
                        output_metadata.get("layeredForegroundKind")
                        == "source-mrc"
                    )
                    tone_owned, authored_ink, ownership_boundary = (
                        ownership_artifact_masks(
                            args.metadata_dir,
                            metadata_page,
                            metadata_output_index,
                            output_image.size,
                            args.dpi,
                            output_metadata,
                            trusted_mrc_page=trusted_mrc_page,
                            debug_prefix=(
                                args.artifact_dir
                                / f"ownership-page-{output_page}"
                                if trusted_mrc_page
                                else None
                            ),
                        )
                    )
                    ownership = ownership_metrics(
                        aligned_source,
                        output_image,
                        tone_owned,
                        authored_ink,
                        ownership_boundary,
                        args.dpi,
                        blank_page=rule == "blank",
                    )
                    fidelity = source_fidelity_metrics(
                        aligned_source,
                        output_image,
                        ownership_boundary,
                        args.artifact_dir
                        / f"new-edge-mask-page-{output_page}.png"
                        if trusted_mrc_page
                        else None,
                    )
                    tone_damage_score = (
                        (
                            max(0, tone.p10_lift - 24)
                            + max(0, tone.p50_lift - 32)
                        )
                        if (
                            tone is not None
                            and tone.p10_lift > 24
                            and tone.p50_lift > 32
                        )
                        else (
                            max(0.0, 0.75 - tone.range_ratio) * 100
                            if tone is not None
                            else 0.0
                        )
                    )
                    paper_percentile = (
                        output_metrics.p90
                        if mode == "mixed"
                        else output_metrics.p75
                    )
                    gray_severity = (
                        output_metrics.residual_gray_fraction
                        * max(0, 255 - paper_percentile)
                    )
                    dark_fraction_ratio = (
                        output_metrics.whole_dark_fraction
                        / source_metrics.whole_dark_fraction
                        if source_metrics.whole_dark_fraction > 0.0001
                        else 1.0
                    )
                    relative_ink_fraction_ratio = (
                        output_metrics.whole_relative_ink_fraction
                        / source_metrics.whole_relative_ink_fraction
                        if source_metrics.whole_relative_ink_fraction > 0.0001
                        else 1.0
                    )
                    text_cleanup_candidate, acceptance_failures = (
                        page_acceptance_failures(
                            mode,
                            rule,
                            source_metrics,
                            output_metrics,
                            crop,
                            diagnostics,
                            tone,
                            seams,
                            edge_artifacts,
                            fidelity,
                            source_identity_expected,
                            trusted_mrc_page,
                            ownership,
                        )
                    )
                    audit = PageAudit(
                        page=page,
                        output_page=output_page,
                        output_index=output_index,
                        mode=mode,
                        rule=rule,
                        source=source_metrics,
                        output=output_metrics,
                        crop=crop,
                        tone=tone,
                        seams=seams,
                        edge_artifacts=edge_artifacts,
                        tone_damage_score=tone_damage_score,
                        gray_severity=gray_severity,
                        white_fraction_gain=(
                            output_metrics.white_fraction - source_metrics.white_fraction
                        ),
                        dark_fraction_ratio=dark_fraction_ratio,
                        relative_ink_fraction_ratio=relative_ink_fraction_ratio,
                        text_cleanup_candidate=text_cleanup_candidate,
                        acceptance_failures=tuple(acceptance_failures),
                        source_fidelity=fidelity,
                        ownership=ownership,
                    )
                    audits.append(audit)
                    source_thumbnails[output_page] = thumbnail(
                        source_region,
                        (
                            f"source p{page}:{output_index} "
                            f"p50={source_metrics.p50}"
                        ),
                    )
                    output_thumbnails[output_page] = thumbnail(
                        output_image,
                        (
                            f"output p{output_page} {mode} "
                            f"p50={output_metrics.p50}"
                        ),
                    )
            for path in [*source_paths, *output_paths]:
                path.unlink()
            print(f"Audited output pages {first_page}-{last_page}/{output_pages}", flush=True)

    ranked = sorted(audits, key=lambda audit: audit.gray_severity, reverse=True)
    tone_ranked = sorted(
        audits,
        key=lambda audit: audit.tone_damage_score,
        reverse=True,
    )
    crop_ranked = sorted(
        (audit for audit in audits if audit.crop is not None),
        key=lambda audit: max(
            audit.crop.left_fraction,
            audit.crop.top_fraction,
            audit.crop.right_fraction,
            audit.crop.bottom_fraction,
        ),
        reverse=True,
    )
    write_csv(args.artifact_dir / "page-metrics.csv", audits)
    (args.artifact_dir / "page-metrics.json").write_text(
        json.dumps([asdict(audit) for audit in audits], indent=2) + "\n",
        encoding="utf-8",
    )
    save_sheets(
        [output_thumbnails[audit.output_page] for audit in audits],
        args.artifact_dir / "output-pages",
    )
    save_sheets(
        [output_thumbnails[audit.output_page] for audit in ranked],
        args.artifact_dir / "grayness-ordered-output-pages",
    )
    worst = ranked[:min(args.worst_count, len(ranked))]
    save_sheets(
        [
            paired_tile(
                source_thumbnails[audit.output_page],
                output_thumbnails[audit.output_page],
            )
            for audit in worst
        ],
        args.artifact_dir / "worst-gray-source-output",
        columns=3,
    )
    tone_worst = tone_ranked[:min(args.worst_count, len(tone_ranked))]
    save_sheets(
        [
            paired_tile(
                source_thumbnails[audit.output_page],
                output_thumbnails[audit.output_page],
            )
            for audit in tone_worst
        ],
        args.artifact_dir / "worst-tone-source-output",
        columns=3,
    )
    crop_worst = crop_ranked[:min(args.worst_count, len(crop_ranked))]
    save_sheets(
        [
            paired_tile(
                source_thumbnails[audit.output_page],
                output_thumbnails[audit.output_page],
            )
            for audit in crop_worst
        ],
        args.artifact_dir / "worst-crop-source-output",
        columns=3,
    )
    removed_text_pages = [
        {
            "page": audit.page,
            "outputPage": audit.output_page,
            "outputIndex": audit.output_index,
        }
        for audit in audits
        if audit.crop is not None and audit.crop.removed_text_evidence_count > 0
    ]
    adjacent = neighbor_audits(audits)
    neighbor_failures = [
        asdict(audit)
        for audit in adjacent
        if audit.acceptance_failures
    ]
    summary = {
        "sourcePdf": str(args.source_pdf.resolve()),
        "outputPdf": str(args.output_pdf.resolve()),
        "auditDpi": args.dpi,
        "rasterization": {
            "requestedDpi": args.dpi,
            "maxDimensionPx": args.max_dimension_px,
            "capEvents": raster_cap_events,
        },
        "pageCount": output_pages,
        "evaluatedPages": len(audits),
        "metadataPages": len(audits),
        "modeDistribution": {
            mode: sum(1 for audit in audits if audit.mode == mode)
            for mode in sorted({audit.mode for audit in audits})
        },
        "worstGrayPages": [
            {
                "page": audit.page,
                "outputPage": audit.output_page,
                "outputIndex": audit.output_index,
                "mode": audit.mode,
                "rule": audit.rule,
                "graySeverity": audit.gray_severity,
                "outputP50": audit.output.p50,
                "outputP75": audit.output.p75,
                "outputResidualGrayFraction": audit.output.residual_gray_fraction,
                "darkFractionRatio": audit.dark_fraction_ratio,
            }
            for audit in worst
        ],
        "worstTonePages": [
            {
                "page": audit.page,
                "outputPage": audit.output_page,
                "outputIndex": audit.output_index,
                "mode": audit.mode,
                "rule": audit.rule,
                "toneDamageScore": audit.tone_damage_score,
                "tone": (
                    asdict(audit.tone)
                    if audit.tone is not None
                    else None
                ),
            }
            for audit in tone_worst
        ],
        "worstCropPages": [
            {
                "page": audit.page,
                "outputPage": audit.output_page,
                "outputIndex": audit.output_index,
                "mode": audit.mode,
                "leftFraction": audit.crop.left_fraction,
                "topFraction": audit.crop.top_fraction,
                "rightFraction": audit.crop.right_fraction,
                "bottomFraction": audit.crop.bottom_fraction,
                "retainedAreaFraction": audit.crop.retained_area_fraction,
                "acceptedTrimCount": audit.crop.accepted_trim_count,
            }
            for audit in crop_worst
        ],
        "edgeArtifactPages": [
            {
                "page": audit.page,
                "outputPage": audit.output_page,
                "outputIndex": audit.output_index,
                **asdict(audit.edge_artifacts),
            }
            for audit in sorted(
                audits,
                key=lambda audit: audit.edge_artifacts.introduced_black_fraction,
                reverse=True,
            )
        ],
        "sourceFidelityPages": [
            {
                "page": audit.page,
                "outputPage": audit.output_page,
                "outputIndex": audit.output_index,
                **asdict(audit.source_fidelity),
            }
            for audit in sorted(
                (
                    audit
                    for audit in audits
                    if audit.source_fidelity is not None
                ),
                key=lambda audit: audit.source_fidelity.new_edge_fraction,
                reverse=True,
            )
        ],
        "removedTextEvidencePages": removed_text_pages,
        "neighborComparisons": {
            "adjacentPairs": len(adjacent),
            "comparablePairs": sum(audit.comparable for audit in adjacent),
            "failures": neighbor_failures,
        },
        "acceptanceFailures": [
            {
                "page": audit.page,
                "outputPage": audit.output_page,
                "outputIndex": audit.output_index,
                "mode": audit.mode,
                "rule": audit.rule,
                "failures": list(audit.acceptance_failures),
            }
            for audit in audits
            if audit.acceptance_failures
        ],
    }
    (args.artifact_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))
    if summary["acceptanceFailures"] or neighbor_failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
