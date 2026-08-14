#!/usr/bin/env python3
"""Component ridge-width measurement for stroke-weight-oracle.mjs.

The CLI entry point owns the calibrated constants, the report schema, and the
exit status. This module owns pixel work only: it decodes a foreground mask,
finds 8-connected components, measures each component's ridge width from an L2
distance transform, groups components into text lines, and compares every
component with the median ridge width of its local neighbours on the same line.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

MASK_THRESHOLD = 128
CALIBRATION_DPI = 300.0
COMPONENT_AREA_MIN_PX = 8
COMPONENT_HEIGHT_MIN_PX = 12
COMPONENT_HEIGHT_MAX_PX = 70
COMPONENT_WIDTH_MIN_PX = 2
COMPONENT_WIDTH_MAX_PX = 200
LINE_CLUSTER_GAP_HEIGHT_FRACTION = 0.72
MINIMUM_LINE_COMPONENTS = 8
MILLIMETRES_PER_INCH = 25.4


def parse_pages(value: str | None, page_count: int) -> list[int]:
    if value is None:
        return list(range(1, page_count + 1))
    pages: set[int] = set()
    for raw_token in value.split(','):
        token = raw_token.strip()
        if not token:
            continue
        if '-' in token:
            first_text, last_text = token.split('-', 1)
            first, last = int(first_text), int(last_text)
        else:
            first = last = int(token)
        if first < 1 or last < first or last > page_count:
            raise ValueError(f'invalid page range {token!r} for {page_count} pages')
        pages.update(range(first, last + 1))
    if not pages:
        raise ValueError('page selector is empty')
    return sorted(pages)


def pdf_page_count(pdf: Path) -> int:
    output = subprocess.run(
        ['pdfinfo', str(pdf)], check=True, capture_output=True, text=True
    ).stdout
    for line in output.splitlines():
        if line.startswith('Pages:'):
            return int(line.split(':', 1)[1].strip())
    raise RuntimeError(f'pdfinfo did not report a page count for {pdf}')


def load_rendered_metrics(path: Path):
    spec = importlib.util.spec_from_file_location('evb_rendered_metrics', path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'cannot load rendered metrics module from {path}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    return float(np.percentile(np.asarray(values, dtype=np.float64), quantile))


def rounded(value: float | None, digits: int = 6) -> float | None:
    return None if value is None else round(float(value), digits)


def component_ridge_width(component: np.ndarray) -> float:
    # Every component crop is foreground-tight. A white guard is required or an
    # all-foreground crop makes OpenCV report its effectively-infinite sentinel
    # distance rather than the distance to the component boundary.
    guarded = np.pad(component, 1, mode='constant', constant_values=False)
    distance = cv2.distanceTransform(guarded.astype(np.uint8), cv2.DIST_L2, 5)
    ridge = (distance > 0) & (
        distance >= cv2.dilate(distance, np.ones((3, 3), np.float32)) - 1e-5
    )
    return float(2.0 * np.median(distance[ridge])) if ridge.any() else 0.0


def find_components(mask: np.ndarray, x_dpi: float, y_dpi: float) -> list[dict[str, Any]]:
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8), 8
    )
    x_scale = x_dpi / CALIBRATION_DPI
    y_scale = y_dpi / CALIBRATION_DPI
    area_scale = max(0.25, x_scale * y_scale)
    minimum_area = max(2, round(COMPONENT_AREA_MIN_PX * area_scale))
    minimum_height = max(1, round(COMPONENT_HEIGHT_MIN_PX * y_scale))
    maximum_height = round(COMPONENT_HEIGHT_MAX_PX * y_scale)
    minimum_width = max(1, round(COMPONENT_WIDTH_MIN_PX * x_scale))
    maximum_width = round(COMPONENT_WIDTH_MAX_PX * x_scale)
    result: list[dict[str, Any]] = []
    for label in range(1, count):
        x, y, width, height, area = map(int, stats[label])
        if area < minimum_area:
            continue
        if not minimum_height <= height <= maximum_height:
            continue
        if not minimum_width <= width <= maximum_width:
            continue
        component = labels[y:y + height, x:x + width] == label
        stroke_width_px = component_ridge_width(component)
        result.append({
            'label': label,
            'x': x,
            'y': y,
            'width': width,
            'height': height,
            'area': area,
            'centerX': float(centroids[label][0]),
            'centerY': float(centroids[label][1]),
            'strokeWidthPx': stroke_width_px,
            'strokeWidthMm': stroke_width_px * MILLIMETRES_PER_INCH / y_dpi,
        })
    return result


def group_lines(components: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    if not components:
        return []
    median_height = statistics.median(item['height'] for item in components)
    max_center_gap = max(2.0, LINE_CLUSTER_GAP_HEIGHT_FRACTION * median_height)
    groups: list[list[dict[str, Any]]] = []
    for component in sorted(components, key=lambda item: (item['centerY'], item['centerX'])):
        best_index = None
        best_distance = math.inf
        for index, group in enumerate(groups):
            center = statistics.median(item['centerY'] for item in group)
            distance = abs(component['centerY'] - center)
            if distance <= max_center_gap and distance < best_distance:
                best_index = index
                best_distance = distance
        if best_index is None:
            groups.append([component])
        else:
            groups[best_index].append(component)
    return [sorted(group, key=lambda item: item['centerX']) for group in groups]


def output_mapping(summary_path: Path | None) -> dict[int, dict[str, Any]]:
    if summary_path is None:
        return {}
    summary = json.loads(summary_path.read_text(encoding='utf-8'))
    output_page_by_ordinal: dict[int, int] = {}
    representation = summary.get('representation', {})
    for page in representation.get('pages', []):
        if 'outputOrdinal' in page and 'outputPageNumber' in page:
            output_page_by_ordinal[int(page['outputOrdinal'])] = int(page['outputPageNumber'])
    if not output_page_by_ordinal:
        output_page_by_ordinal = {
            index: index for index in range(1, int(summary.get('outputPages', 0)) + 1)
        }
    mapping: dict[int, dict[str, Any]] = {}
    for item in representation.get('outputMappings', []):
        ordinal = item.get('outputOrdinal')
        if ordinal is None:
            continue
        page = output_page_by_ordinal.get(int(ordinal), int(ordinal))
        mapping[page] = {
            'sourcePage': item.get('sourcePage'),
            'half': item.get('half'),
            'outputOrdinal': int(ordinal),
        }
    return mapping


def foreground_mask(image: Image.Image) -> np.ndarray:
    gray = np.asarray(image.convert('L'))
    mask = gray < MASK_THRESHOLD
    # A mostly-dark raster is an inverted rendition of the same page; the
    # oracle measures ink, whichever polarity carries it.
    return ~mask if float(mask.mean()) > 0.5 else mask


def measure_mask(
    identity: dict[str, Any],
    mask: np.ndarray,
    x_dpi: float,
    y_dpi: float,
    window_mm: float,
    ratio_limit: float,
    min_local: int,
) -> dict[str, Any]:
    components = find_components(mask, x_dpi, y_dpi)
    lines = group_lines(components)
    window_px = window_mm * x_dpi / MILLIMETRES_PER_INCH
    line_reports: list[dict[str, Any]] = []
    page_offenders: list[dict[str, Any]] = []
    for line_index, line in enumerate(lines, start=1):
        if len(line) < MINIMUM_LINE_COMPONENTS:
            continue
        widths = [item['strokeWidthMm'] for item in line]
        p50 = percentile(widths, 50)
        p95 = percentile(widths, 95)
        offenders: list[dict[str, Any]] = []
        for item in line:
            local = [
                neighbor['strokeWidthMm']
                for neighbor in line
                if abs(neighbor['centerX'] - item['centerX']) <= window_px
            ]
            if len(local) < min_local:
                continue
            local_median = percentile(local, 50)
            assert local_median is not None
            component_ratio = item['strokeWidthMm'] / max(local_median, 1e-9)
            if component_ratio > ratio_limit:
                offender = {
                    'line': line_index,
                    'bbox': [item['x'], item['y'], item['width'], item['height']],
                    'centerX': rounded(item['centerX']),
                    'centerY': rounded(item['centerY']),
                    'strokeWidthPx': rounded(item['strokeWidthPx']),
                    'strokeWidthMm': rounded(item['strokeWidthMm']),
                    'localMedianWidthMm': rounded(local_median),
                    'ratio': rounded(component_ratio),
                    'localComponentCount': len(local),
                }
                offenders.append(offender)
                page_offenders.append(offender)
        line_reports.append({
            'line': line_index,
            'centerY': rounded(statistics.median(item['centerY'] for item in line)),
            'componentCount': len(line),
            'p50WidthMm': rounded(p50),
            'p95WidthMm': rounded(p95),
            'p95P50Ratio': rounded((p95 or 0.0) / max(p50 or 0.0, 1e-9)),
            'offenderCount': len(offenders),
            'offenders': offenders,
        })
    return {
        **identity,
        'status': 'measured',
        'raster': {
            'width': int(mask.shape[1]),
            'height': int(mask.shape[0]),
            'xDpi': x_dpi,
            'yDpi': y_dpi,
        },
        'eligibleComponentCount': len(components),
        'measuredLineCount': len(line_reports),
        'offenderCount': len(page_offenders),
        'maxLineP95P50Ratio': rounded(
            max((line['p95P50Ratio'] for line in line_reports), default=0.0)
        ),
        'lines': line_reports,
    }


def measure_pdf_page(
    page: int,
    decoded: tuple[Any, Any] | None,
    mapping: dict[int, dict[str, Any]],
    window_mm: float,
    ratio_limit: float,
    min_local: int,
) -> dict[str, Any]:
    identity = {'source': 'pdf-page', 'outputPage': page, **mapping.get(page, {})}
    if decoded is None:
        return {
            **identity,
            'status': 'no-full-resolution-jbig2-mask',
            'offenderCount': 0,
            'lines': [],
        }
    image_row, image = decoded
    measurement = measure_mask(
        identity,
        foreground_mask(image),
        float(image_row.x_dpi),
        float(image_row.y_dpi),
        window_mm,
        ratio_limit,
        min_local,
    )
    measurement['raster']['objectId'] = image_row.object_id
    return measurement


def measure_image(
    path: Path,
    dpi: float,
    window_mm: float,
    ratio_limit: float,
    min_local: int,
) -> dict[str, Any]:
    identity = {'source': 'image', 'imagePath': str(path), 'imageName': path.name}
    with Image.open(path) as image:
        mask = foreground_mask(image)
    return measure_mask(identity, mask, dpi, dpi, window_mm, ratio_limit, min_local)


def measure_pdf(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.rendered_metrics is None:
        raise ValueError('--rendered-metrics is required for --pdf input')
    pages = parse_pages(args.pages, pdf_page_count(args.pdf))
    mapping = output_mapping(args.summary)
    rendered_metrics = load_rendered_metrics(args.rendered_metrics)
    results = []
    with tempfile.TemporaryDirectory(prefix='evb-weight-oracle-') as directory:
        scratch = Path(directory)
        for page in pages:
            decoded = rendered_metrics.decoded_page_mask(args.pdf, page, scratch)
            results.append(measure_pdf_page(
                page, decoded, mapping, args.window_mm, args.ratio, args.min_local
            ))
    return results


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path)
    parser.add_argument('--image', type=Path, action='append', default=[])
    parser.add_argument('--dpi', type=float, default=CALIBRATION_DPI)
    parser.add_argument('--rendered-metrics', type=Path)
    parser.add_argument('--summary', type=Path)
    parser.add_argument('--pages')
    parser.add_argument('--window-mm', type=float, required=True)
    parser.add_argument('--ratio', type=float, required=True)
    parser.add_argument('--min-local', type=int, required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if bool(args.pdf) == bool(args.image):
        raise ValueError('exactly one of --pdf or --image inputs is required')
    if args.pdf is not None:
        results = measure_pdf(args)
    else:
        results = [
            measure_image(path, args.dpi, args.window_mm, args.ratio, args.min_local)
            for path in args.image
        ]
    measured = [result for result in results if result['status'] == 'measured']
    offenders = sum(result['offenderCount'] for result in measured)
    corpus_max = max((result['maxLineP95P50Ratio'] for result in measured), default=0.0)
    report = {
        'pages': results,
        'summary': {
            'pageCountRequested': len(results),
            'pageCountMeasured': len(measured),
            'pageCountUnmeasured': len(results) - len(measured),
            'offenderCount': offenders,
            'offendingPageCount': sum(result['offenderCount'] > 0 for result in measured),
            'corpusMaxP95P50Ratio': rounded(corpus_max),
            'gatePass': len(measured) == len(results) and offenders == 0,
        },
    }
    print(json.dumps(report, separators=(',', ':')))


if __name__ == '__main__':
    main()
