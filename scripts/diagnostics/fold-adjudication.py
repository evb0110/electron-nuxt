#!/usr/bin/env python3
"""Measure the pinned S4(d) fold surfaces from two rendered manifest trees."""

import argparse
import csv
import hashlib
import io
import json
import struct
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RECIPE = Path(__file__).with_name("fold-adjudication-recipe.json")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--main-fold-manifest", required=True, type=Path)
    parser.add_argument("--branch-fold-manifest", required=True, type=Path)
    parser.add_argument("--main-exemplar-manifest", required=True, type=Path)
    parser.add_argument("--branch-exemplar-manifest", required=True, type=Path)
    parser.add_argument("--recipe", default=DEFAULT_RECIPE, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--tesseract", default="tesseract")
    return parser.parse_args()


def load_json(path):
    return json.loads(path.read_text())


def resolve_manifest_path(manifest_path, value):
    path = Path(value)
    if path.is_absolute():
        return path
    repository_path = ROOT / path
    if repository_path.exists():
        return repository_path
    return manifest_path.parent / path


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_dimensions(path):
    with path.open("rb") as source:
        header = source.read(24)
    if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Not a PNG: {path}")
    return struct.unpack(">II", header[16:24])


def indexed_pages(manifest_path):
    manifest = load_json(manifest_path)
    if manifest.get("version") != 3:
        raise ValueError(f"Expected protocol-v3 manifest: {manifest_path}")
    return {page["sourcePageIndex"]: page for page in manifest["pages"]}


def assert_surface(page, surface, expected_sha, manifest_path):
    options = page["options"]
    expected = {
        "dpi": surface["dpi"],
        "sourceDpi": surface["dpi"],
        "requestedRenderDpi": surface["dpi"],
        "layout": surface["layout"],
        "cropContent": surface["cropContent"],
        "matchPageSize": surface["matchPageSize"],
    }
    for key, value in expected.items():
        if options.get(key) != value:
            raise ValueError(
                f"{manifest_path}: expected {key}={value!r}, got {options.get(key)!r}"
            )
    margins = options.get("margins", {})
    if any(margins.get(key) != surface["marginsMm"] for key in (
        "leftMm", "topMm", "rightMm", "bottomMm"
    )):
        raise ValueError(f"{manifest_path}: expected zero-mm margins")
    input_path = resolve_manifest_path(manifest_path, page["inputPath"])
    actual_sha = sha256(input_path)
    if actual_sha != expected_sha:
        raise ValueError(
            f"{input_path}: expected SHA-256 {expected_sha}, got {actual_sha}"
        )


def right_output(page):
    if len(page["outputs"]) != 2:
        raise ValueError(f"Expected two leaf outputs for source page {page['sourcePageIndex']}")
    return page["outputs"][1]


def accepted_words(image_path, metadata, recipe, tesseract):
    command = [
        tesseract,
        str(image_path),
        "stdout",
        "--psm",
        str(recipe["tesseractPageSegmentationMode"]),
        "tsv",
    ]
    result = subprocess.run(
        command,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    words = []
    for word in csv.DictReader(io.StringIO(result.stdout), delimiter="\t"):
        try:
            valid = (
                word["level"] == "5"
                and float(word["conf"]) >= recipe["minimumWordConfidence"]
                and any(character.isalnum() for character in word["text"])
                and int(word["height"])
                <= metadata["outputHeightPx"] * recipe["maximumWordHeightFraction"]
                and int(word["width"])
                <= metadata["outputWidthPx"] * recipe["maximumWordWidthFraction"]
            )
        except (KeyError, TypeError, ValueError):
            valid = False
        if valid:
            words.append({
                "left": int(word["left"]),
                "text": word["text"],
                "width": int(word["width"]),
            })
    return words


def residue_rows(manifest_path, surface, tesseract):
    pages = indexed_pages(manifest_path)
    rows = []
    for specimen in surface["pages"]:
        page = pages[specimen["sourcePage"]]
        assert_surface(page, surface, specimen["sha256"], manifest_path)
        output = right_output(page)
        image_path = resolve_manifest_path(manifest_path, output["outputPath"])
        metadata_path = resolve_manifest_path(manifest_path, output["metadataPath"])
        metadata = load_json(metadata_path)
        dimensions = png_dimensions(image_path)
        if dimensions != (metadata["outputWidthPx"], metadata["outputHeightPx"]):
            raise ValueError(f"PNG/metadata dimensions disagree: {image_path}")
        words = accepted_words(image_path, metadata, surface, tesseract)
        content = metadata.get("contentBox")
        if content is None:
            gap = None
            verdict = "no-content-box"
        elif not words:
            gap = None
            verdict = "no-ocr-text"
        else:
            content_edge = content["xPx"] - metadata["cropRect"]["xPx"]
            text_edge = min(word["left"] for word in words)
            gap = round(text_edge - content_edge)
            if gap < 0:
                verdict = "over-crop"
            elif gap <= surface["maximumCleanFoldGapPx"]:
                verdict = "clean"
            else:
                verdict = "residue-review"
        rows.append({
            "id": specimen["id"],
            "sourcePage": specimen["sourcePage"],
            "rightWidthPx": dimensions[0],
            "rightHeightPx": dimensions[1],
            "signedFoldGapPx": gap,
            "verdict": verdict,
        })
    return rows


def exemplar_rows(main_manifest_path, branch_manifest_path, surface):
    main_pages = indexed_pages(main_manifest_path)
    branch_pages = indexed_pages(branch_manifest_path)
    rows = []
    for specimen in surface["pages"]:
        main_page = main_pages[specimen["sourcePage"]]
        branch_page = branch_pages[specimen["sourcePage"]]
        assert_surface(main_page, surface, specimen["sha256"], main_manifest_path)
        assert_surface(branch_page, surface, specimen["sha256"], branch_manifest_path)
        dimensions = []
        for manifest_path, page in (
            (main_manifest_path, main_page),
            (branch_manifest_path, branch_page),
        ):
            output = right_output(page)
            image_path = resolve_manifest_path(manifest_path, output["outputPath"])
            metadata_path = resolve_manifest_path(manifest_path, output["metadataPath"])
            metadata = load_json(metadata_path)
            size = png_dimensions(image_path)
            if size != (metadata["outputWidthPx"], metadata["outputHeightPx"]):
                raise ValueError(f"PNG/metadata dimensions disagree: {image_path}")
            dimensions.append(size)
        removed_px = dimensions[0][0] - dimensions[1][0]
        rows.append({
            "id": specimen["id"],
            "sourcePage": specimen["sourcePage"],
            "mainRightWidthPx": dimensions[0][0],
            "branchRightWidthPx": dimensions[1][0],
            "branchMinusMainPx": -removed_px,
            "branchMinusMainMm": round(-removed_px * 25.4 / surface["dpi"], 2),
        })
    return rows


def command_version(command):
    result = subprocess.run(
        [command, "--version"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return result.stdout.splitlines()[0]


def main():
    args = parse_args()
    recipe = load_json(args.recipe)
    if recipe.get("schemaVersion") != 1:
        raise ValueError("Unsupported fold adjudication recipe")
    main_residue = residue_rows(
        args.main_fold_manifest,
        recipe["residueSurface"],
        args.tesseract,
    )
    branch_residue = residue_rows(
        args.branch_fold_manifest,
        recipe["residueSurface"],
        args.tesseract,
    )
    report = {
        "schemaVersion": 1,
        "recipe": str(args.recipe),
        "tesseract": command_version(args.tesseract),
        "residueSurface": {
            "mainCount": sum(row["verdict"] == "residue-review" for row in main_residue),
            "branchCount": sum(row["verdict"] == "residue-review" for row in branch_residue),
            "mainOverCropCount": sum(row["verdict"] == "over-crop" for row in main_residue),
            "branchOverCropCount": sum(row["verdict"] == "over-crop" for row in branch_residue),
            "main": main_residue,
            "branch": branch_residue,
        },
        "exemplarSurface": exemplar_rows(
            args.main_exemplar_manifest,
            args.branch_exemplar_manifest,
            recipe["exemplarSurface"],
        ),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
