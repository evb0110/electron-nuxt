#!/usr/bin/env python3
"""Connected-component stroke-weight audit for the Luther representative fixture."""

from __future__ import annotations

import csv
import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image


# Artifact root holding the rendered variant directories; the study kept them beside the
# script, so the default stays the current directory now that the script lives in the repo.
ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
VARIANTS = ("current", "rescue-off", "wolf", "smoothing-off")


def percentile(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    index = (len(ordered) - 1) * q
    low = math.floor(index)
    high = math.ceil(index)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - index) + ordered[high] * (index - low)


def otsu_threshold(data: bytes) -> int:
    histogram = [0] * 256
    for value in data:
        histogram[value] += 1
    total = len(data)
    weighted_total = sum(index * count for index, count in enumerate(histogram))
    background_count = 0
    background_sum = 0
    best_score = -1.0
    best = 128
    for threshold, count in enumerate(histogram):
        background_count += count
        background_sum += threshold * count
        foreground_count = total - background_count
        if background_count == 0 or foreground_count == 0:
            continue
        background_mean = background_sum / background_count
        foreground_mean = (weighted_total - background_sum) / foreground_count
        score = background_count * foreground_count * (background_mean - foreground_mean) ** 2
        if score > best_score:
            best_score = score
            best = threshold
    return best


class UnionFind:
    def __init__(self) -> None:
        self.parent: list[int] = []

    def add(self) -> int:
        label = len(self.parent)
        self.parent.append(label)
        return label

    def find(self, item: int) -> int:
        parent = self.parent[item]
        while parent != self.parent[parent]:
            parent = self.parent[parent]
        while item != parent:
            following = self.parent[item]
            self.parent[item] = parent
            item = following
        return parent

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def components_from_mask(mask: bytes, width: int, height: int) -> list[dict]:
    """Return 8-connected ink components from a 0/1 row-major mask using RLE union-find."""
    union = UnionFind()
    runs: list[tuple[int, int, int, int]] = []
    previous: list[tuple[int, int, int]] = []
    for y in range(height):
        current: list[tuple[int, int, int]] = []
        row = y * width
        x = 0
        while x < width:
            while x < width and not mask[row + x]:
                x += 1
            if x == width:
                break
            start = x
            while x + 1 < width and mask[row + x + 1]:
                x += 1
            end = x
            label = union.add()
            current.append((start, end, label))
            runs.append((y, start, end, label))
            x += 1
        previous_index = 0
        for start, end, label in current:
            while previous_index < len(previous) and previous[previous_index][1] < start - 1:
                previous_index += 1
            probe = previous_index
            while probe < len(previous) and previous[probe][0] <= end + 1:
                union.union(label, previous[probe][2])
                probe += 1
        previous = current

    grouped: dict[int, list[tuple[int, int, int]]] = defaultdict(list)
    for y, start, end, label in runs:
        grouped[union.find(label)].append((y, start, end))
    output = []
    for component_runs in grouped.values():
        left = min(run[1] for run in component_runs)
        right = max(run[2] for run in component_runs)
        top = component_runs[0][0]
        bottom = component_runs[-1][0]
        area = sum(end - start + 1 for _, start, end in component_runs)
        output.append({
            "runs": component_runs,
            "left": left,
            "right": right,
            "top": top,
            "bottom": bottom,
            "width": right - left + 1,
            "height": bottom - top + 1,
            "area": area,
        })
    return output


def component_stroke_width(component: dict) -> float:
    """Estimate stroke width as median chamfer-DT ridge diameter (2r-1)."""
    width = component["width"] + 2
    height = component["height"] + 2
    inf = 30_000
    distance = [0] * (width * height)
    ink = bytearray(width * height)
    left = component["left"]
    top = component["top"]
    for y, start, end in component["runs"]:
        local_y = y - top + 1
        offset = local_y * width
        for x in range(start - left + 1, end - left + 2):
            ink[offset + x] = 1
            distance[offset + x] = inf
    for y in range(1, height - 1):
        offset = y * width
        for x in range(1, width - 1):
            index = offset + x
            if not ink[index]:
                continue
            distance[index] = min(
                distance[index],
                distance[index - 1] + 3,
                distance[index - width] + 3,
                distance[index - width - 1] + 4,
                distance[index - width + 1] + 4,
            )
    for y in range(height - 2, 0, -1):
        offset = y * width
        for x in range(width - 2, 0, -1):
            index = offset + x
            if not ink[index]:
                continue
            distance[index] = min(
                distance[index],
                distance[index + 1] + 3,
                distance[index + width] + 3,
                distance[index + width + 1] + 4,
                distance[index + width - 1] + 4,
            )
    ridge = []
    neighbors = (-1, 1, -width, width, -width - 1, -width + 1, width - 1, width + 1)
    for index, value in enumerate(distance):
        if ink[index] and all(not ink[index + delta] or value >= distance[index + delta] for delta in neighbors):
            ridge.append(max(1.0, 2.0 * value / 3.0 - 1.0))
    return statistics.median(ridge or [1.0])


def mask_for_box(image: Image.Image, box: tuple[int, int, int, int], source_gray: bool = False) -> tuple[bytes, int, int, int | None]:
    crop = image.crop(box).convert("L")
    raw = crop.tobytes()
    threshold = otsu_threshold(raw) if source_gray else 127
    mask = bytes(value < threshold for value in raw)
    return mask, crop.width, crop.height, threshold if source_gray else None


def measure_box(image: Image.Image, box: tuple[int, int, int, int], source_gray: bool = False, keep_components: bool = False) -> dict:
    mask, width, height, threshold = mask_for_box(image, box, source_gray)
    components = components_from_mask(mask, width, height)
    plausible = [component for component in components if (
        component["area"] >= 7
        and component["height"] >= 4
        and component["height"] <= 90
        and component["width"] <= 120
        and component["width"] / max(1, component["height"]) <= 3.5
    )]
    widths = [component_stroke_width(component) for component in plausible]
    p10 = percentile(widths, 0.10)
    p90 = percentile(widths, 0.90)
    result = {
        "component_count": len(widths),
        "mean": statistics.fmean(widths) if widths else float("nan"),
        "median": statistics.median(widths) if widths else float("nan"),
        "p10": p10,
        "p90": p90,
        "ratio": p90 / p10 if widths and p10 > 0 else float("nan"),
        "variance": statistics.pvariance(widths) if len(widths) > 1 else 0.0,
        "threshold": threshold,
    }
    if keep_components:
        result["components"] = plausible
        result["mask"] = mask
        result["mask_width"] = width
        result["mask_height"] = height
    return result


def parse_ocr_lines(path: Path, image_width: int, image_height: int) -> list[dict]:
    grouped: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
            if row["level"] != "5" or not row["text"].strip():
                continue
            grouped[(row["block_num"], row["par_num"], row["line_num"])].append(row)
    lines = []
    for words in grouped.values():
        left = min(int(word["left"]) for word in words)
        top = min(int(word["top"]) for word in words)
        right = max(int(word["left"]) + int(word["width"]) for word in words)
        bottom = max(int(word["top"]) + int(word["height"]) for word in words)
        box = (max(0, left - 4), max(0, top - 4), min(image_width, right + 4), min(image_height, bottom + 4))
        lines.append({"box": box, "text": " ".join(word["text"] for word in words)})
    return sorted(lines, key=lambda line: (line["box"][1], line["box"][0]))


def mapped_source(source: Image.Image, geometry: dict, output_size: tuple[int, int]) -> Image.Image:
    a, b, c, d, e, f = final_forward(geometry)
    determinant = a * e - b * d
    inverse = (
        e / determinant,
        -b / determinant,
        (b * f - e * c) / determinant,
        -d / determinant,
        a / determinant,
        (d * c - a * f) / determinant,
    )
    return source.transform(output_size, Image.Transform.AFFINE, inverse, resample=Image.Resampling.BILINEAR, fillcolor=255)


def final_forward(geometry: dict) -> tuple[float, float, float, float, float, float]:
    forward = geometry["forwardTransform"]["matrix"]
    a, b, c = forward[0]
    d, e, f = forward[1]
    return (
        a,
        b,
        c + geometry["placementOffsetXPx"],
        d,
        e,
        f + geometry["placementOffsetYPx"],
    )


def inverse_affine(matrix: tuple[float, float, float, float, float, float]) -> tuple[float, float, float, float, float, float]:
    a, b, c, d, e, f = matrix
    determinant = a * e - b * d
    return (
        e / determinant,
        -b / determinant,
        (b * f - e * c) / determinant,
        -d / determinant,
        a / determinant,
        (d * c - a * f) / determinant,
    )


def compose_affine(left: tuple[float, float, float, float, float, float], right: tuple[float, float, float, float, float, float]) -> tuple[float, float, float, float, float, float]:
    """Compose 2D affine transforms as left(right(point))."""
    la, lb, lc, ld, le, lf = left
    ra, rb, rc, rd, re, rf = right
    return (
        la * ra + lb * rd,
        la * rb + lb * re,
        la * rc + lb * rf + lc,
        ld * ra + le * rd,
        ld * rb + le * re,
        ld * rc + le * rf + lf,
    )


def align_variant(image: Image.Image, variant_geometry: dict, current_geometry: dict, output_size: tuple[int, int]) -> Image.Image:
    # PIL wants output(current)-to-input(variant). Both render geometries are
    # related through the same raw source plane.
    current_to_source = inverse_affine(final_forward(current_geometry))
    current_to_variant = compose_affine(final_forward(variant_geometry), current_to_source)
    return image.transform(
        output_size,
        Image.Transform.AFFINE,
        current_to_variant,
        resample=Image.Resampling.NEAREST,
        fillcolor=255,
    )


def finite(value: float) -> bool:
    return not math.isnan(value) and not math.isinf(value)


def clean_metric(metric: dict) -> dict:
    return {key: (round(value, 4) if isinstance(value, float) and finite(value) else value) for key, value in metric.items() if key not in {"components", "mask"}}


def component_rescue_differential(current: dict, baseline: dict) -> list[dict]:
    current_mask = current["mask"]
    baseline_mask = baseline["mask"]
    width = current["mask_width"]
    rows = []
    for component in current["components"]:
        pixels = []
        added = 0
        retained = 0
        for y, start, end in component["runs"]:
            offset = y * width
            for x in range(start, end + 1):
                index = offset + x
                if baseline_mask[index]:
                    retained += 1
                    pixels.append((x, y))
                else:
                    added += 1
        if added == 0 or retained < 7:
            continue
        by_row: dict[int, list[int]] = defaultdict(list)
        for x, y in pixels:
            by_row[y].append(x)
        runs = []
        for y, xs in by_row.items():
            xs.sort()
            start = previous = xs[0]
            for x in xs[1:]:
                if x != previous + 1:
                    runs.append((y, start, previous))
                    start = x
                previous = x
            runs.append((y, start, previous))
        pre = {
            "runs": sorted(runs),
            "left": min(x for x, _ in pixels),
            "right": max(x for x, _ in pixels),
            "top": min(y for _, y in pixels),
            "bottom": max(y for _, y in pixels),
            "area": retained,
        }
        pre["width"] = pre["right"] - pre["left"] + 1
        pre["height"] = pre["bottom"] - pre["top"] + 1
        pre_width = component_stroke_width(pre)
        current_width = component_stroke_width(component)
        rows.append({
            "added_pixels": added,
            "pre_pixels": retained,
            "area_gain_pct": added / retained * 100,
            "pre_stroke_width": pre_width,
            "current_stroke_width": current_width,
            "stroke_gain_px": current_width - pre_width,
            "stroke_gain_pct": (current_width / pre_width - 1.0) * 100 if pre_width else float("nan"),
        })
    return rows


def main() -> None:
    summaries = {
        variant: json.loads((ROOT / variant / f"{variant}.pdf.summary.json").read_text())
        for variant in VARIANTS
    }
    geometries = {
        variant: [item["renderGeometry"] for item in summaries[variant]["perPageStreamSizes"]]
        for variant in VARIANTS
    }
    raw_variant_images = {
        variant: [Image.open(ROOT / variant / f"leaf-{index:02d}.png").convert("L") for index in range(1, 21)]
        for variant in VARIANTS
    }
    variant_images = {variant: [] for variant in VARIANTS}
    for leaf_index in range(20):
        current_image = raw_variant_images["current"][leaf_index]
        for variant in VARIANTS:
            variant_images[variant].append(
                current_image
                if variant == "current"
                else align_variant(
                    raw_variant_images[variant][leaf_index],
                    geometries[variant][leaf_index],
                    geometries["current"][leaf_index],
                    current_image.size,
                )
            )
    sources = [Image.open(ROOT / "source" / f"source299-{index:02d}.png").convert("L") for index in range(1, 11)]
    mapped_sources = [
        mapped_source(sources[index // 2], geometries["current"][index], variant_images["current"][index].size)
        for index in range(20)
    ]

    records = []
    rescue_components = []
    for leaf_index in range(20):
        current_image = variant_images["current"][leaf_index]
        lines = parse_ocr_lines(ROOT / "ocr" / f"current-leaf-{leaf_index + 1:02d}.tsv", *current_image.size)
        for line_index, line in enumerate(lines, 1):
            box = line["box"]
            metrics = {"source": measure_box(mapped_sources[leaf_index], box, source_gray=True)}
            for variant in VARIANTS:
                metrics[variant] = measure_box(variant_images[variant][leaf_index], box)
            source_ratio = metrics["source"]["ratio"]
            current_ratio = metrics["current"]["ratio"]
            enough = min(metrics["source"]["component_count"], metrics["current"]["component_count"]) >= 8
            added_unevenness = enough and finite(source_ratio) and finite(current_ratio) and current_ratio >= 1.25 and current_ratio >= source_ratio * 1.15 and current_ratio - source_ratio >= 0.20
            rescue_ratio = metrics["rescue-off"]["ratio"]
            rescue_tracks = added_unevenness and finite(rescue_ratio) and rescue_ratio <= current_ratio - 0.12 and abs(rescue_ratio - source_ratio) < abs(current_ratio - source_ratio) * 0.70
            record = {
                "source_page": leaf_index // 2 + 1,
                "leaf": "left" if leaf_index % 2 == 0 else "right",
                "output_page": leaf_index + 1,
                "line": line_index,
                "bbox": ",".join(map(str, box)),
                "text": line["text"],
                "conversion_added_unevenness": added_unevenness,
                "tracks_rescue": rescue_tracks,
                "metrics": {key: clean_metric(value) for key, value in metrics.items()},
            }
            records.append(record)
            if added_unevenness:
                current_detail = measure_box(current_image, box, keep_components=True)
                rescue_detail = measure_box(variant_images["rescue-off"][leaf_index], box, keep_components=True)
                for differential in component_rescue_differential(current_detail, rescue_detail):
                    differential.update({
                        "source_page": leaf_index // 2 + 1,
                        "leaf": record["leaf"],
                        "output_page": leaf_index + 1,
                        "line": line_index,
                        "text": line["text"],
                    })
                    rescue_components.append(differential)

    (ROOT / "metrics").mkdir(parents=True, exist_ok=True)
    (ROOT / "metrics/line-metrics.json").write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n")
    flat_fields = ["source_page", "leaf", "output_page", "line", "bbox", "text", "conversion_added_unevenness", "tracks_rescue"]
    metric_fields = ["component_count", "mean", "median", "p10", "p90", "ratio", "variance", "threshold"]
    with (ROOT / "metrics/line-metrics.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=flat_fields + [f"{variant}_{field}" for variant in ("source",) + VARIANTS for field in metric_fields])
        writer.writeheader()
        for record in records:
            row = {field: record[field] for field in flat_fields}
            for variant in ("source",) + VARIANTS:
                for field in metric_fields:
                    row[f"{variant}_{field}"] = record["metrics"][variant].get(field)
            writer.writerow(row)

    with (ROOT / "metrics/rescued-components.csv").open("w", newline="", encoding="utf-8") as handle:
        fields = ["source_page", "leaf", "output_page", "line", "text", "added_pixels", "pre_pixels", "area_gain_pct", "pre_stroke_width", "current_stroke_width", "stroke_gain_px", "stroke_gain_pct"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rescue_components:
            writer.writerow({key: round(value, 4) if isinstance(value, float) else value for key, value in row.items()})

    leaf_rows = []
    for output_page in range(1, 21):
        lines = [record for record in records if record["output_page"] == output_page]
        row = {
            "source_page": (output_page - 1) // 2 + 1,
            "leaf": "left" if output_page % 2 else "right",
            "output_page": output_page,
            "line_count": len(lines),
            "flagged_lines": sum(record["conversion_added_unevenness"] for record in lines),
            "rescue_tracking_lines": sum(record["tracks_rescue"] for record in lines),
        }
        for variant in ("source",) + VARIANTS:
            ratios = [record["metrics"][variant]["ratio"] for record in lines if finite(record["metrics"][variant]["ratio"])]
            variances = [record["metrics"][variant]["variance"] for record in lines if finite(record["metrics"][variant]["variance"])]
            row[f"{variant}_ratio_median"] = statistics.median(ratios) if ratios else float("nan")
            row[f"{variant}_ratio_p90"] = percentile(ratios, 0.90)
            row[f"{variant}_variance_median"] = statistics.median(variances) if variances else float("nan")
        leaf_rows.append(row)
    with (ROOT / "metrics/page-leaf-summary.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(leaf_rows[0]))
        writer.writeheader()
        for row in leaf_rows:
            writer.writerow({key: round(value, 4) if isinstance(value, float) else value for key, value in row.items()})
    (ROOT / "metrics/page-leaf-summary.json").write_text(json.dumps(leaf_rows, indent=2) + "\n")

    print(json.dumps({
        "lines": len(records),
        "flagged": sum(record["conversion_added_unevenness"] for record in records),
        "tracks_rescue": sum(record["tracks_rescue"] for record in records),
        "rescued_components_on_flagged_lines": len(rescue_components),
    }))


if __name__ == "__main__":
    main()
