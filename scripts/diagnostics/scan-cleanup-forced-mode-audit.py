#!/usr/bin/env python3
"""Replay canonical page plans with forced BW and grayscale output modes."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-manifest", required=True, type=Path)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--pages", required=True)
    return parser.parse_args()


def load_artifact_audit() -> Any:
    path = Path(__file__).with_name("scan-cleanup-artifact-audit.py")
    spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load artifact audit helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def output_paths(artifact_dir: Path, page: int, mode: str) -> dict[str, str]:
    prefix = artifact_dir / f"page-{page}-{mode}"
    return {
        "outputPath": str(prefix.with_suffix(".png")),
        "metadataPath": str(prefix.with_suffix(".json")),
        "bilevelOutputPath": str(prefix.with_suffix(".pbm")),
        "backgroundOutputPath": str(prefix.with_name(prefix.name + "-background.png")),
        "foregroundMaskOutputPath": str(prefix.with_name(prefix.name + "-mask.pbm")),
        "foregroundAlphaOutputPath": str(prefix.with_name(prefix.name + "-alpha.pgm")),
        "pictureMaskOutputPath": str(
            prefix.with_name(prefix.name + "-picture-mask.pbm")
        ),
        "tonePreservationAlphaOutputPath": str(
            prefix.with_name(prefix.name + "-tone-preservation-alpha.png")
        ),
    }


def main() -> None:
    args = parse_args()
    pages = [int(value.strip()) for value in args.pages.split(",") if value.strip()]
    if not pages or len(set(pages)) != len(pages):
        raise RuntimeError("--pages must contain unique comma-separated page numbers")
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    reference: dict[str, Any] = json.loads(
        args.reference_manifest.read_text(encoding="utf-8")
    )
    reference_pages = {
        int(page["sourcePageIndex"]) + 1: page
        for page in reference.get("pages", [])
    }
    missing = [page for page in pages if page not in reference_pages]
    if missing:
        raise RuntimeError(f"Reference manifest lacks pages: {missing}")

    render_pages: list[dict[str, Any]] = []
    for page_number in pages:
        for mode in ("bw", "grayscale"):
            page = copy.deepcopy(reference_pages[page_number])
            page["pageMetadataPath"] = str(
                args.artifact_dir / f"page-{page_number}-{mode}-page.json"
            )
            page["options"]["outputMode"] = mode
            page["outputs"] = [output_paths(args.artifact_dir, page_number, mode)]
            render_pages.append(page)
    manifest = {
        key: copy.deepcopy(value)
        for key, value in reference.items()
        if key != "pages"
    }
    manifest["pages"] = render_pages
    manifest_path = args.artifact_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    completed = subprocess.run(
        [str(args.binary), "--manifest", str(manifest_path)],
        check=False,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    (args.artifact_dir / "sidecar-stdout.jsonl").write_text(
        completed.stdout,
        encoding="utf-8",
    )
    (args.artifact_dir / "sidecar-stderr.log").write_text(
        completed.stderr,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"Scan-cleanup sidecar exited with {completed.returncode}: "
            f"{completed.stderr.strip()}"
        )
    terminal = [
        json.loads(line)
        for line in completed.stdout.splitlines()
        if line.strip()
    ]
    if not any(
        envelope.get("type") == "result"
        and envelope.get("result", {}).get("status") == "success"
        for envelope in terminal
    ):
        raise RuntimeError("Scan-cleanup sidecar did not publish a success result")

    audit = load_artifact_audit()
    records: list[dict[str, Any]] = []
    contact_tiles: list[Image.Image] = []
    hashes: dict[str, str] = {
        "binary": sha256(args.binary),
        "referenceManifest": sha256(args.reference_manifest),
    }
    for page_number in pages:
        reference_page = reference_pages[page_number]
        source_path = Path(reference_page["inputPath"])
        hashes[f"sourcePage{page_number}"] = sha256(source_path)
        with Image.open(source_path) as source_image:
            contact_tiles.append(
                audit.thumbnail(source_image, f"source page {page_number}")
            )
            for mode in ("bw", "grayscale"):
                paths = output_paths(args.artifact_dir, page_number, mode)
                metadata_path = Path(paths["metadataPath"])
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                raster_path = (
                    Path(paths["bilevelOutputPath"])
                    if metadata.get("bilevelWritten") is True
                    else Path(paths["outputPath"])
                )
                hashes[f"page{page_number}-{mode}"] = sha256(raster_path)
                with Image.open(raster_path) as output_image:
                    source_region = audit.source_region_image(source_image, metadata)
                    source_metrics = audit.metrics(source_region)
                    output_metrics = audit.metrics(output_image)
                    aligned_source = audit.align_source_to_output(
                        source_image,
                        metadata,
                        output_image.size,
                    )
                    seams = audit.block_seam_metrics(
                        aligned_source,
                        output_image,
                        int(round(float(metadata.get("renderDpi", 200)))),
                    )
                    relative_ink_ratio = (
                        output_metrics.whole_relative_ink_fraction
                        / source_metrics.whole_relative_ink_fraction
                        if source_metrics.whole_relative_ink_fraction > 0.0001
                        else 1.0
                    )
                    failures: list[str] = []
                    if output_metrics.p75 < 248:
                        failures.append(f"paper-p75={output_metrics.p75}<248")
                    if output_metrics.residual_chroma_p99 > 4:
                        failures.append(
                            "residual-chroma-p99="
                            f"{output_metrics.residual_chroma_p99}>4"
                        )
                    if (
                        source_metrics.whole_relative_ink_fraction >= 0.02
                        and relative_ink_ratio < 0.60
                    ):
                        failures.append(
                            f"relative-ink-retention={relative_ink_ratio:.3f}<0.60"
                        )
                    warnings: list[str] = []
                    if seams.count >= 3:
                        # Raw PBM replay has no PDF rasterizer antialiasing, so
                        # binary glyph and rule edges can satisfy the generic
                        # seam heuristic. Preserve the measurement for review;
                        # only the assembled final-PDF audit gates seams.
                        warnings.append(
                            "raw-bilevel-seam-candidates="
                            f"{seams.count},longest={seams.longest_run_px}px,"
                            f"jump={seams.maximum_jump}"
                        )
                    records.append(
                        {
                            "page": page_number,
                            "mode": mode,
                            "source": asdict(source_metrics),
                            "output": asdict(output_metrics),
                            "relativeInkRatio": relative_ink_ratio,
                            "seams": asdict(seams),
                            "metadataPath": str(metadata_path.resolve()),
                            "rasterPath": str(raster_path.resolve()),
                            "warnings": warnings,
                            "failures": failures,
                        }
                    )
                    contact_tiles.append(
                        audit.thumbnail(
                            output_image,
                            (
                                f"page {page_number} {mode} "
                                f"p75={output_metrics.p75} "
                                f"ink={relative_ink_ratio:.2f}"
                            ),
                        )
                    )
    audit.save_sheets(
        contact_tiles,
        args.artifact_dir / "source-bw-grayscale",
        columns=3,
    )
    analysis = {}
    for page_number in pages:
        analysis_path = args.reference_manifest.parent / f"analysis-{page_number}.json"
        if analysis_path.exists():
            value = json.loads(analysis_path.read_text(encoding="utf-8"))
            analysis[str(page_number)] = {
                "mode": value.get("recommendedOutputMode"),
                "reason": value.get("recommendedOutputModeReason"),
                "confidence": value.get("recommendedOutputModeConfidence"),
                "diagnostics": value.get("outputModeDiagnostics"),
            }
            hashes[f"analysisPage{page_number}"] = sha256(analysis_path)
    failures = [
        {
            "page": record["page"],
            "mode": record["mode"],
            "failures": record["failures"],
        }
        for record in records
        if record["failures"]
    ]
    summary = {
        "referenceManifest": str(args.reference_manifest.resolve()),
        "binary": str(args.binary.resolve()),
        "pages": pages,
        "automaticAnalysis": analysis,
        "records": records,
        "failures": failures,
        "sha256": hashes,
    }
    (args.artifact_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
