#!/usr/bin/env python3
"""Fail-closed visual compatibility check for generated PDF artifacts."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "scripts/diagnostics/pdf-preview-compat-harness"
NEGATIVE_CONTROL = (
    ROOT / "tests/fixtures/electron/pdfjs-no-wasm-jpx-control.pdf.b64"
)
DECODER_FAILURE_MARKERS = (
    "Unable to decode image",
    "failed to initialize",
    "Dependent image isn't ready",
    "wasmUrl API parameter",
    "openjpeg_nowasm_fallback",
)


@dataclass(frozen=True)
class ImageMetrics:
    dark_pixel_ratio: float
    ink_pixel_ratio: float
    mean_luminance: float
    width: int
    height: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument(
        "--pages",
        help="Comma-separated one-based pages. Required for PDFs over 20 pages.",
    )
    parser.add_argument("--dpi", default=96, type=int)
    parser.add_argument(
        "--allow-large",
        action="store_true",
        help="Allow more than 20 rendered pages (reserved for resource tests).",
    )
    arguments = sys.argv[1:]
    if arguments[:1] == ["--"]:
        arguments = arguments[1:]
    return parser.parse_args(arguments)


def run(command: list[str], *, cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def require_command(name: str) -> str:
    resolved = shutil.which(name)
    if resolved is None:
        raise RuntimeError(f"Required command is unavailable: {name}")
    return resolved


def pdf_page_count(pdf_path: Path) -> int:
    output = run([require_command("pdfinfo"), str(pdf_path)]).stdout
    for line in output.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip())
    raise RuntimeError(f"pdfinfo did not report a page count for {pdf_path}")


def parse_pages(raw: str | None, page_count: int) -> list[int]:
    if raw is None:
        return list(range(1, page_count + 1))
    pages = sorted({
        int(value.strip())
        for value in raw.split(",")
        if value.strip()
    })
    if not pages or pages[0] < 1 or pages[-1] > page_count:
        raise ValueError(f"--pages must be within 1..{page_count}")
    return pages


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def metrics(path: Path) -> ImageMetrics:
    image = Image.open(path).convert("RGB")
    grayscale = ImageOps.grayscale(image)
    histogram = grayscale.histogram()
    total = max(1, image.width * image.height)
    luminance_total = sum(value * count for value, count in enumerate(histogram))
    return ImageMetrics(
        dark_pixel_ratio=sum(histogram[:128]) / total,
        ink_pixel_ratio=sum(histogram[:245]) / total,
        mean_luminance=luminance_total / total,
        width=image.width,
        height=image.height,
    )


def decode_negative_control(output_path: Path) -> None:
    encoded = "".join(NEGATIVE_CONTROL.read_text(encoding="utf-8").split())
    output_path.write_bytes(base64.b64decode(encoded, validate=True))


def run_exact_renderer(
    pdf_path: Path,
    output_dir: Path,
    pages: list[int],
    dpi: int,
) -> dict[str, Any]:
    electron = require_command(str(ROOT / "node_modules/.bin/electron"))
    completed = run([
        electron,
        str(HARNESS),
        f"--pdf={pdf_path}",
        f"--out={output_dir}",
        f"--pages={','.join(map(str, pages))}",
        f"--scale={dpi / 72}",
    ])
    (output_dir / "process.stdout.log").write_text(
        completed.stdout,
        encoding="utf-8",
    )
    (output_dir / "process.stderr.log").write_text(
        completed.stderr,
        encoding="utf-8",
    )
    return json.loads(
        (output_dir / "render-report.json").read_text(encoding="utf-8")
    )


def run_reference_renderer(
    pdf_path: Path,
    output_dir: Path,
    pages: list[int],
    dpi: int,
) -> dict[int, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    pdftoppm = require_command("pdftoppm")
    rendered: dict[int, Path] = {}
    for page in pages:
        prefix = output_dir / f"page-{page}"
        run([
            pdftoppm,
            "-f",
            str(page),
            "-l",
            str(page),
            "-r",
            str(dpi),
            "-singlefile",
            "-png",
            str(pdf_path),
            str(prefix),
        ])
        path = prefix.with_suffix(".png")
        if not path.is_file():
            raise RuntimeError(f"Reference renderer did not publish page {page}")
        rendered[page] = path
    return rendered


def exact_paths(report: dict[str, Any]) -> dict[int, Path]:
    return {
        int(result["pageNumber"]): Path(result["outputPath"])
        for result in report["results"]
    }


def decoder_failures(report: dict[str, Any]) -> list[str]:
    messages = [
        str(item.get("message", ""))
        for item in report.get("consoleMessages", [])
    ]
    return [
        message
        for message in messages
        if any(marker in message for marker in DECODER_FAILURE_MARKERS)
    ]


def load_font(size: int) -> ImageFont.ImageFont:
    candidates = (
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    )
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def fitted_thumbnail(path: Path, width: int, height: int) -> Image.Image:
    image = Image.open(path).convert("RGB")
    image.thumbnail((width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (width, height), "white")
    canvas.paste(
        image,
        ((width - image.width) // 2, (height - image.height) // 2),
    )
    return canvas


def create_contact_sheet(
    output_path: Path,
    pages: list[int],
    reference: dict[int, Path],
    exact: dict[int, Path],
    failures_by_page: dict[int, list[str]],
) -> None:
    cell_width = 360
    cell_height = 500
    header_height = 52
    row_label_width = 84
    sheet = Image.new(
        "RGB",
        (
            row_label_width + cell_width * 2,
            header_height + cell_height * len(pages),
        ),
        "#e5e7eb",
    )
    draw = ImageDraw.Draw(sheet)
    header_font = load_font(20)
    label_font = load_font(17)
    draw.text(
        (row_label_width + 12, 14),
        "Reference renderer",
        fill="black",
        font=header_font,
    )
    draw.text(
        (row_label_width + cell_width + 12, 14),
        "Exact artifact preview",
        fill="black",
        font=header_font,
    )
    for row, page in enumerate(pages):
        y = header_height + row * cell_height
        failed = bool(failures_by_page.get(page))
        draw.rectangle(
            (0, y, row_label_width, y + cell_height),
            fill="#fee2e2" if failed else "#dcfce7",
        )
        draw.text(
            (12, y + 18),
            f"p. {page}",
            fill="#991b1b" if failed else "#166534",
            font=label_font,
        )
        sheet.paste(
            fitted_thumbnail(reference[page], cell_width, cell_height),
            (row_label_width, y),
        )
        sheet.paste(
            fitted_thumbnail(exact[page], cell_width, cell_height),
            (row_label_width + cell_width, y),
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def verify_negative_control(artifact_dir: Path, dpi: int) -> dict[str, Any]:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    control_pdf = artifact_dir / "negative-control.pdf"
    control_exact = artifact_dir / "negative-control-exact"
    control_reference = artifact_dir / "negative-control-reference"
    decode_negative_control(control_pdf)
    report = run_exact_renderer(control_pdf, control_exact, [1], dpi)
    reference = run_reference_renderer(control_pdf, control_reference, [1], dpi)
    exact = exact_paths(report)
    exact_metrics = metrics(exact[1])
    reference_metrics = metrics(reference[1])
    failures = decoder_failures(report)
    detected = (
        bool(failures)
        and reference_metrics.ink_pixel_ratio > 0.01
        and exact_metrics.ink_pixel_ratio < 0.0001
    )
    if not detected:
        raise RuntimeError(
            "Negative control failed: the verifier did not detect a known "
            "JPX page that disappears without PDF.js WASM"
        )
    return {
        "detected": True,
        "exact": asdict(exact_metrics),
        "reference": asdict(reference_metrics),
        "renderer_failures": failures,
    }


def main() -> int:
    args = parse_args()
    pdf_path = args.pdf.resolve()
    artifact_dir = args.artifact_dir.resolve()
    if not pdf_path.is_file():
        raise FileNotFoundError(pdf_path)
    if args.dpi <= 0:
        raise ValueError("--dpi must be positive")
    page_count = pdf_page_count(pdf_path)
    pages = parse_pages(args.pages, page_count)
    if len(pages) > 20 and not args.allow_large:
        raise ValueError(
            "Refusing to visually audit more than 20 pages. Create a "
            "representative smoke extract or pass --allow-large only for a "
            "specific resource-exhaustion test."
        )
    artifact_dir.mkdir(parents=True, exist_ok=True)
    negative_control = verify_negative_control(
        artifact_dir / "verifier-self-test",
        args.dpi,
    )
    exact_report = run_exact_renderer(
        pdf_path,
        artifact_dir / "exact-preview",
        pages,
        args.dpi,
    )
    reference_paths = run_reference_renderer(
        pdf_path,
        artifact_dir / "reference-render",
        pages,
        args.dpi,
    )
    exact_render_paths = exact_paths(exact_report)
    global_failures = [
        f"Renderer warning: {message}"
        for message in decoder_failures(exact_report)
    ]
    page_results = []
    failures_by_page: dict[int, list[str]] = {}
    for page in pages:
        reference_metrics = metrics(reference_paths[page])
        exact_metrics = metrics(exact_render_paths[page])
        failures: list[str] = []
        if (
            reference_metrics.ink_pixel_ratio > 0.003
            and exact_metrics.ink_pixel_ratio
            < max(0.0001, reference_metrics.ink_pixel_ratio * 0.05)
        ):
            failures.append(
                "Exact preview is blank or nearly blank while the reference "
                "renderer contains visible content"
            )
        if (
            reference_metrics.mean_luminance < 252
            and exact_metrics.mean_luminance > 254.5
        ):
            failures.append(
                "Exact preview is near-white while reference luminance is not"
            )
        if failures:
            failures_by_page[page] = failures
        page_results.append({
            "page": page,
            "failures": failures,
            "exact": {
                **asdict(exact_metrics),
                "path": str(exact_render_paths[page]),
                "sha256": sha256(exact_render_paths[page]),
            },
            "reference": {
                **asdict(reference_metrics),
                "path": str(reference_paths[page]),
                "sha256": sha256(reference_paths[page]),
            },
        })
    contact_sheet = artifact_dir / "contact-sheet.png"
    create_contact_sheet(
        contact_sheet,
        pages,
        reference_paths,
        exact_render_paths,
        failures_by_page,
    )
    failures = global_failures + [
        f"Page {page}: {failure}"
        for page, page_failures in failures_by_page.items()
        for failure in page_failures
    ]
    report = {
        "schemaVersion": 1,
        "status": "failed" if failures else "passed",
        "input": {
            "path": str(pdf_path),
            "sha256": sha256(pdf_path),
            "pageCount": page_count,
            "sizeBytes": pdf_path.stat().st_size,
        },
        "pages": pages,
        "renderer": {
            "exact": exact_report["renderer"],
            "pdfjsVersion": exact_report["pdfjsVersion"],
            "contract": "getDocument({data}) without wasmUrl",
        },
        "negativeControl": negative_control,
        "pageResults": page_results,
        "failures": failures,
        "contactSheet": {
            "path": str(contact_sheet),
            "sha256": sha256(contact_sheet),
        },
    }
    report_name = (
        "verification-failure.json"
        if failures
        else "verification-ledger.json"
    )
    report_path = artifact_dir / report_name
    report_path.write_text(
        json.dumps(report, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "status": report["status"],
        "report": str(report_path),
        "contactSheet": str(contact_sheet),
        "failureCount": len(failures),
    }))
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - diagnostic must preserve context
        print(f"PDF visual verification failed to run: {error}", file=sys.stderr)
        sys.exit(2)
