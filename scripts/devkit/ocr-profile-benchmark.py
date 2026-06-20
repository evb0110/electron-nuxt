#!/usr/bin/env python3
"""
OCR Profile Benchmark (devkit)

Renders PDF pages or accepts existing image files, runs Tesseract with a small
set of OCR profiles, and records runtime, text length, word count, and TSV
confidence metrics. Artifacts are written under .devkit/ by default.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURE = PROJECT_ROOT / "tests/fixtures/electron/test-scanned.pdf"
DEFAULT_PROFILES = ("balanced", "accurate", "poor-scan", "stock")
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
RTL_LANGUAGE_CODES = {"ara", "heb", "syr"}
PAGE_RANGE_RE = re.compile(r"^\s*(\d+)\s*-\s*(\d+)\s*$")
PAGE_INT_RE = re.compile(r"^\s*\d+\s*$")
UNPAPER_PROBE_CACHE: dict[Path, bool] = {}

LATIN_WORD_BOUNDARY_ARGS = (
    "-c",
    "preserve_interword_spaces=1",
    "-c",
    "textord_words_default_minspace=0.3",
    "-c",
    "textord_words_min_minspace=0.2",
    "-c",
    "tosp_fuzzy_space_factor=0.5",
    "-c",
    "tosp_min_sane_kn_sp=1.2",
    "-c",
    "tosp_kern_gap_factor1=1.5",
    "-c",
    "tosp_kern_gap_factor2=1.0",
)

LATIN_DICTIONARY_DISABLED_ARGS = (
    "-c",
    "load_system_dawg=0",
    "-c",
    "load_freq_dawg=0",
)


@dataclass(frozen=True)
class ProfileSpec:
    name: str
    languages: tuple[str, ...]
    args: tuple[str, ...]
    preprocessing: str
    description: str


@dataclass(frozen=True)
class BenchmarkImage:
    source: Path
    image: Path
    label: str
    page: int | None
    dpi: int


def now_tag() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def safe_stem(path: Path) -> str:
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", path.stem).strip("_")
    return stem or "source"


def display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(PROJECT_ROOT))
    except ValueError:
        return str(path)


def resolve_platform_arch_tag() -> str:
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64"

    if sys.platform == "darwin":
        return f"darwin-{arch}"
    if sys.platform.startswith("win"):
        return f"win32-{arch}"
    if sys.platform.startswith("linux"):
        return f"linux-{arch}"
    return f"{sys.platform}-{arch}"


def resolve_tool_path(explicit: str | None, bundled: Path, name: str) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    if bundled.exists():
        return bundled
    found = shutil.which(name)
    if found:
        return Path(found)
    return bundled


def default_tesseract_path() -> Path:
    ext = ".exe" if sys.platform.startswith("win") else ""
    return PROJECT_ROOT / "resources" / "tesseract" / resolve_platform_arch_tag() / "bin" / f"tesseract{ext}"


def default_pdftoppm_path() -> Path:
    ext = ".exe" if sys.platform.startswith("win") else ""
    return PROJECT_ROOT / "resources" / "poppler" / resolve_platform_arch_tag() / "bin" / f"pdftoppm{ext}"


def default_unpaper_path() -> Path:
    ext = ".exe" if sys.platform.startswith("win") else ""
    return PROJECT_ROOT / "resources" / "tesseract" / resolve_platform_arch_tag() / "bin" / f"unpaper{ext}"


def parse_pages(expr: str) -> list[int]:
    pages: set[int] = set()
    for part in (item.strip() for item in expr.split(",") if item.strip()):
        range_match = PAGE_RANGE_RE.match(part)
        if range_match:
            start = int(range_match.group(1))
            end = int(range_match.group(2))
            low, high = (start, end) if start <= end else (end, start)
            pages.update(range(low, high + 1))
            continue
        if PAGE_INT_RE.match(part):
            pages.add(int(part))
            continue
        raise ValueError(f"Invalid page expression part: {part!r}")

    return sorted(page for page in pages if page > 0)


def parse_csv_list(raw: str) -> list[str]:
    return [part.strip() for part in raw.split(",") if part.strip()]


def unique_preserving_order(values: list[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return tuple(result)


def resolve_evb_language_config(
    languages: tuple[str, ...],
    *,
    preserve_dictionaries: bool = False,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    has_rtl = any(language in RTL_LANGUAGE_CODES for language in languages)
    if not has_rtl:
        dictionary_args = () if preserve_dictionaries else LATIN_DICTIONARY_DISABLED_ARGS
        return languages, (*LATIN_WORD_BOUNDARY_ARGS, *dictionary_args)

    rtl = tuple(language for language in languages if language in RTL_LANGUAGE_CODES)
    non_rtl = tuple(language for language in languages if language not in RTL_LANGUAGE_CODES)
    return (*rtl, *non_rtl), ()


def build_profiles(profile_names: list[str], languages: tuple[str, ...]) -> list[ProfileSpec]:
    evb_languages, evb_args = resolve_evb_language_config(languages)
    accurate_languages, accurate_args = resolve_evb_language_config(languages, preserve_dictionaries=True)
    definitions = {
        "balanced": ProfileSpec(
            name="balanced",
            languages=evb_languages,
            args=evb_args,
            preprocessing="off",
            description="Current EVB default profile: language ordering, spacing options, and dictionary-disabled Latin OCR.",
        ),
        "accurate": ProfileSpec(
            name="accurate",
            languages=accurate_languages,
            args=accurate_args,
            preprocessing="off",
            description="EVB language ordering and spacing options while preserving Tesseract dictionaries.",
        ),
        "poor-scan": ProfileSpec(
            name="poor-scan",
            languages=evb_languages,
            args=(*evb_args, "-c", "thresholding_method=2"),
            preprocessing="clean",
            description="EVB defaults plus unpaper cleanup and adaptive thresholding for degraded scans.",
        ),
        "stock": ProfileSpec(
            name="stock",
            languages=languages,
            args=(),
            preprocessing="off",
            description="Tesseract with requested languages and no EVB wrapper options.",
        ),
        "evb-default": ProfileSpec(
            name="evb-default",
            languages=evb_languages,
            args=evb_args,
            preprocessing="off",
            description="Legacy alias for the balanced EVB wrapper defaults.",
        ),
        "psm-6": ProfileSpec(
            name="psm-6",
            languages=evb_languages,
            args=("--psm", "6", *evb_args),
            preprocessing="off",
            description="EVB defaults plus Tesseract page segmentation mode 6.",
        ),
        "psm-11": ProfileSpec(
            name="psm-11",
            languages=evb_languages,
            args=("--psm", "11", *evb_args),
            preprocessing="off",
            description="EVB defaults plus sparse text page segmentation mode 11.",
        ),
    }

    if profile_names == ["all"]:
        profile_names = list(DEFAULT_PROFILES)

    profiles: list[ProfileSpec] = []
    for name in unique_preserving_order(profile_names):
        profile = definitions.get(name)
        if not profile:
            known = ", ".join(definitions)
            raise ValueError(f"Unknown profile {name!r}. Known profiles: {known}")
        profiles.append(profile)
    return profiles


def validate_inputs(
    sources: list[Path],
    tesseract: Path,
    pdftoppm: Path,
    tessdata: Path,
    languages: tuple[str, ...],
) -> None:
    missing_sources = [display_path(source) for source in sources if not source.exists()]
    if missing_sources:
        raise FileNotFoundError(f"Missing source file(s): {', '.join(missing_sources)}")
    if not tesseract.exists():
        raise FileNotFoundError(f"Tesseract not found: {tesseract}")
    if any(source.suffix.lower() == ".pdf" for source in sources) and not pdftoppm.exists():
        raise FileNotFoundError(f"pdftoppm not found for PDF rendering: {pdftoppm}")
    if not tessdata.exists():
        raise FileNotFoundError(f"tessdata directory not found: {tessdata}")

    missing_models = [
        language
        for language in languages
        if not (tessdata / f"{language}.traineddata").exists()
    ]
    if missing_models:
        raise FileNotFoundError(
            f"Missing tessdata model(s) in {display_path(tessdata)}: {', '.join(missing_models)}"
        )

    unsupported = [
        display_path(source)
        for source in sources
        if source.suffix.lower() != ".pdf" and source.suffix.lower() not in IMAGE_SUFFIXES
    ]
    if unsupported:
        raise ValueError(f"Unsupported source type(s): {', '.join(unsupported)}")


def run_command(
    cmd: list[str],
    *,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        check=True,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )


def build_unpaper_clean_args(input_path: Path, output_path: Path) -> list[str]:
    return [
        "--layout",
        "single",
        "--deskew",
        "--cleanup",
        "--no-mask-center",
        "--despeckle",
        str(input_path),
        str(output_path),
    ]


def render_pdf_page(pdftoppm: Path, source: Path, page: int, dpi: int, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = out_dir / f"{safe_stem(source)}-p{page:04d}-r{dpi}"
    output = base.with_suffix(".png")
    run_command([
        str(pdftoppm),
        "-r",
        str(dpi),
        "-f",
        str(page),
        "-l",
        str(page),
        "-singlefile",
        "-png",
        str(source),
        str(base),
    ])
    if not output.exists():
        raise RuntimeError(f"pdftoppm did not create {output}")
    return output


def prepare_images(sources: list[Path], pages: list[int], dpi: int, pdftoppm: Path, out_root: Path) -> list[BenchmarkImage]:
    images: list[BenchmarkImage] = []
    render_root = out_root / "rendered"
    for source in sources:
        suffix = source.suffix.lower()
        if suffix == ".pdf":
            for page in pages:
                image = render_pdf_page(pdftoppm, source, page, dpi, render_root / safe_stem(source))
                images.append(BenchmarkImage(
                    source=source,
                    image=image,
                    label=f"p{page:04d}",
                    page=page,
                    dpi=dpi,
                ))
            continue

        images.append(BenchmarkImage(
            source=source,
            image=source,
            label="image",
            page=None,
            dpi=dpi,
        ))
    return images


def build_tesseract_env(tesseract: Path, tessdata: Path, threads: int | None) -> dict[str, str]:
    env = os.environ.copy()
    env["TESSDATA_PREFIX"] = str(tessdata)
    if threads and threads > 0:
        env["OMP_THREAD_LIMIT"] = str(threads)

    bin_dir = tesseract.parent
    lib_dir = bin_dir.parent / "lib"
    env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    if lib_dir.exists() and sys.platform == "darwin":
        env["DYLD_LIBRARY_PATH"] = f"{lib_dir}{os.pathsep}{env.get('DYLD_LIBRARY_PATH', '')}"
    if lib_dir.exists() and sys.platform.startswith("linux"):
        env["LD_LIBRARY_PATH"] = f"{lib_dir}{os.pathsep}{env.get('LD_LIBRARY_PATH', '')}"
    return env


def is_unpaper_runnable(unpaper: Path, env: dict[str, str], timeout: int) -> bool:
    cached = UNPAPER_PROBE_CACHE.get(unpaper)
    if cached is not None:
        return cached

    try:
        run_command(
            [str(unpaper), "--version"],
            env=env,
            timeout=min(timeout, 3),
        )
    except Exception as error:
        print(f"warning: unpaper is not runnable and will be skipped: {error}")
        UNPAPER_PROBE_CACHE[unpaper] = False
        return False

    UNPAPER_PROBE_CACHE[unpaper] = True
    return True


def prepare_profile_image(
    image: BenchmarkImage,
    profile: ProfileSpec,
    unpaper: Path,
    tesseract: Path,
    tessdata: Path,
    timeout: int,
    out_dir: Path,
) -> tuple[Path, str]:
    if profile.preprocessing != "clean":
        return image.image, "off"
    if not unpaper.exists():
        print(f"warning: unpaper unavailable for {profile.name}; using raw image {display_path(image.image)}")
        return image.image, "clean-unavailable"

    output = out_dir / "preprocessed.png"
    env = build_tesseract_env(tesseract, tessdata, None)
    if not is_unpaper_runnable(unpaper, env, timeout):
        return image.image, "clean-not-runnable"

    try:
        run_command(
            [str(unpaper), *build_unpaper_clean_args(image.image, output)],
            env=env,
            timeout=timeout,
        )
    except Exception as error:
        print(f"warning: unpaper failed for {profile.name} {display_path(image.image)}: {error}; using raw image")
        return image.image, "clean-failed"

    if output.exists() and output.stat().st_size > 0:
        return output, "clean"

    print(f"warning: unpaper produced no usable image for {profile.name} {display_path(image.image)}; using raw image")
    return image.image, "clean-empty"


def parse_tsv(tsv_path: Path) -> dict[str, object]:
    words: list[str] = []
    confidences: list[float] = []

    with tsv_path.open("r", encoding="utf-8", errors="replace") as file:
        lines = file.read().splitlines()

    for line in lines[1:]:
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 12 or parts[0] != "5":
            continue

        word = (parts[11] or "").strip()
        if word:
            words.append(word)

        try:
            confidence = float(parts[10])
        except ValueError:
            continue
        if confidence >= 0:
            confidences.append(confidence)

    text = " ".join(words)
    if confidences:
        mean_confidence = round(sum(confidences) / len(confidences), 2)
        sorted_confidences = sorted(confidences)
        middle = len(sorted_confidences) // 2
        if len(sorted_confidences) % 2:
            median_confidence = round(sorted_confidences[middle], 2)
        else:
            median_confidence = round((sorted_confidences[middle - 1] + sorted_confidences[middle]) / 2, 2)
    else:
        mean_confidence = None
        median_confidence = None

    return {
        "text": text,
        "text_length": len(text),
        "word_count": len(words),
        "confidence_count": len(confidences),
        "mean_confidence": mean_confidence,
        "median_confidence": median_confidence,
    }


def run_profile(
    image: BenchmarkImage,
    profile: ProfileSpec,
    tesseract: Path,
    tessdata: Path,
    unpaper: Path,
    threads: int | None,
    timeout: int,
    out_dir: Path,
) -> dict[str, object]:
    out_dir.mkdir(parents=True, exist_ok=True)
    output_base = out_dir / "ocr"
    started = time.perf_counter()
    ocr_image, preprocessing_result = prepare_profile_image(
        image=image,
        profile=profile,
        unpaper=unpaper,
        tesseract=tesseract,
        tessdata=tessdata,
        timeout=timeout,
        out_dir=out_dir,
    )
    cmd = [
        str(tesseract),
        str(ocr_image),
        str(output_base),
        "-l",
        "+".join(profile.languages),
        "--tessdata-dir",
        str(tessdata),
        "--dpi",
        str(image.dpi),
        *profile.args,
        "-c",
        "tessedit_create_tsv=1",
    ]
    (out_dir / "command.json").write_text(json.dumps(cmd, indent=2) + "\n", encoding="utf-8")

    env = build_tesseract_env(tesseract, tessdata, threads)
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        runtime_ms = round((time.perf_counter() - started) * 1000, 1)
        stdout = error.stdout if isinstance(error.stdout, str) else ""
        stderr = error.stderr if isinstance(error.stderr, str) else ""
        (out_dir / "stdout.log").write_text(stdout, encoding="utf-8")
        (out_dir / "stderr.log").write_text(stderr, encoding="utf-8")
        (out_dir / "parsed-text.txt").write_text("\n", encoding="utf-8")
        return {
            "type": "run",
            "source": display_path(image.source),
            "image": display_path(image.image),
            "ocr_image": display_path(ocr_image),
            "page": image.page,
            "dpi": image.dpi,
            "profile": profile.name,
            "profile_description": profile.description,
            "preprocessing": profile.preprocessing,
            "preprocessing_result": preprocessing_result,
            "languages": list(profile.languages),
            "args": list(profile.args),
            "runtime_ms": runtime_ms,
            "exit_code": "timeout",
            "success": False,
            "text_length": 0,
            "word_count": 0,
            "confidence_count": 0,
            "mean_confidence": None,
            "median_confidence": None,
            "text_preview": "",
            "error": f"Tesseract timed out after {timeout}s",
            "artifact_dir": display_path(out_dir),
        }

    runtime_ms = round((time.perf_counter() - started) * 1000, 1)
    (out_dir / "stdout.log").write_text(proc.stdout, encoding="utf-8")
    (out_dir / "stderr.log").write_text(proc.stderr, encoding="utf-8")

    tsv_path = output_base.with_suffix(".tsv")
    success = proc.returncode == 0 and tsv_path.exists()
    parse_error = ""
    if success:
        try:
            metrics = parse_tsv(tsv_path)
        except Exception as error:
            success = False
            parse_error = str(error)
            metrics = {
                "text": "",
                "text_length": 0,
                "word_count": 0,
                "confidence_count": 0,
                "mean_confidence": None,
                "median_confidence": None,
            }
    else:
        metrics = {
            "text": "",
            "text_length": 0,
            "word_count": 0,
            "confidence_count": 0,
            "mean_confidence": None,
            "median_confidence": None,
        }

    text = str(metrics.pop("text"))
    (out_dir / "parsed-text.txt").write_text(f"{text}\n", encoding="utf-8")
    error = "" if success else (parse_error or proc.stderr.strip() or f"Tesseract exited with code {proc.returncode}")

    return {
        "type": "run",
        "source": display_path(image.source),
        "image": display_path(image.image),
        "ocr_image": display_path(ocr_image),
        "page": image.page,
        "dpi": image.dpi,
        "profile": profile.name,
        "profile_description": profile.description,
        "preprocessing": profile.preprocessing,
        "preprocessing_result": preprocessing_result,
        "languages": list(profile.languages),
        "args": list(profile.args),
        "runtime_ms": runtime_ms,
        "exit_code": proc.returncode,
        "success": success,
        **metrics,
        "text_preview": text[:160],
        "error": error,
        "artifact_dir": display_path(out_dir),
    }


def write_summary_files(out_root: Path, records: list[dict[str, object]]) -> None:
    ndjson_path = out_root / "summary.ndjson"
    with ndjson_path.open("w", encoding="utf-8") as file:
        for record in records:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")

    csv_columns = [
        "source",
        "page",
        "image",
        "ocr_image",
        "dpi",
        "profile",
        "preprocessing",
        "preprocessing_result",
        "success",
        "text_length",
        "word_count",
        "confidence_count",
        "mean_confidence",
        "median_confidence",
        "runtime_ms",
        "error",
        "artifact_dir",
    ]
    csv_path = out_root / "summary.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=csv_columns)
        writer.writeheader()
        for record in records:
            if record.get("type") != "run":
                continue
            writer.writerow({column: record.get(column, "") for column in csv_columns})


def print_plan(sources: list[Path], pages: list[int], profiles: list[ProfileSpec], args: argparse.Namespace) -> None:
    pdf_sources = [source for source in sources if source.suffix.lower() == ".pdf"]
    image_sources = [source for source in sources if source.suffix.lower() in IMAGE_SUFFIXES]
    image_count = len(image_sources) + (len(pdf_sources) * len(pages))
    print("OCR profile benchmark plan")
    print(f"  Sources: {', '.join(display_path(source) for source in sources)}")
    print(f"  PDF pages: {', '.join(str(page) for page in pages)}")
    print(f"  DPI: {args.dpi}")
    print(f"  Profiles: {', '.join(profile.name for profile in profiles)}")
    print(f"  Planned OCR runs: {image_count * len(profiles)}")
    print(f"  Tesseract: {args.tesseract}")
    print(f"  tessdata: {args.tessdata}")
    print(f"  pdftoppm: {args.pdftoppm}")
    print(f"  unpaper: {args.unpaper}")


def build_manifest(args: argparse.Namespace, profiles: list[ProfileSpec], sources: list[Path], pages: list[int]) -> dict[str, object]:
    return {
        "type": "manifest",
        "created_at": now_tag(),
        "sources": [display_path(source) for source in sources],
        "pages": pages,
        "dpi": args.dpi,
        "profiles": [
            {
                "name": profile.name,
                "languages": list(profile.languages),
                "args": list(profile.args),
                "preprocessing": profile.preprocessing,
                "description": profile.description,
            }
            for profile in profiles
        ],
        "tesseract": str(args.tesseract),
        "tessdata": str(args.tessdata),
        "pdftoppm": str(args.pdftoppm),
        "unpaper": str(args.unpaper),
        "threads": args.threads,
        "timeout": args.timeout,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare Tesseract OCR profiles over PDF pages or image fixtures.")
    parser.add_argument(
        "sources",
        nargs="*",
        type=Path,
        help="PDF or image sources. Defaults to tests/fixtures/electron/test-scanned.pdf.",
    )
    parser.add_argument("--pages", default="1", help="PDF pages to render, e.g. '1,3-5'. Default: 1")
    parser.add_argument("--dpi", type=int, default=300, help="Render DPI passed to pdftoppm and Tesseract. Default: 300")
    parser.add_argument("--languages", default="eng", help="Comma-separated Tesseract language codes. Default: eng")
    parser.add_argument(
        "--profiles",
        default=",".join(DEFAULT_PROFILES),
        help=f"Comma-separated profiles or 'all'. Default: {','.join(DEFAULT_PROFILES)}",
    )
    parser.add_argument("--out", type=Path, default=None, help="Output directory. Default: .devkit/tmp/ocr-profile-benchmark/<timestamp>")
    parser.add_argument("--tesseract", default=None, help="Path to Tesseract binary. Defaults to bundled binary, then PATH.")
    parser.add_argument("--tessdata", type=Path, default=PROJECT_ROOT / "resources/tesseract/tessdata", help="Path to tessdata directory.")
    parser.add_argument("--pdftoppm", default=None, help="Path to pdftoppm. Defaults to bundled binary, then PATH.")
    parser.add_argument("--unpaper", default=None, help="Path to unpaper. Defaults to bundled binary, then PATH.")
    parser.add_argument("--threads", type=int, default=None, help="Optional OMP_THREAD_LIMIT for each Tesseract run.")
    parser.add_argument("--timeout", type=int, default=120, help="Per-run Tesseract timeout in seconds. Default: 120")
    parser.add_argument("--dry-run", action="store_true", help="Validate inputs and print the planned run matrix without rendering or OCR.")

    raw_argv = sys.argv[1:]
    if raw_argv[:1] == ["--"]:
        raw_argv = raw_argv[1:]
    args = parser.parse_args(raw_argv)
    sources = [source.expanduser().resolve() for source in (args.sources or [DEFAULT_FIXTURE])]
    pages = parse_pages(args.pages)
    if not pages:
        parser.error("No PDF pages selected")
    languages = unique_preserving_order(parse_csv_list(args.languages))
    if not languages:
        parser.error("No OCR languages selected")
    profiles = build_profiles(parse_csv_list(args.profiles), languages)

    args.tesseract = resolve_tool_path(args.tesseract, default_tesseract_path(), "tesseract")
    args.pdftoppm = resolve_tool_path(args.pdftoppm, default_pdftoppm_path(), "pdftoppm")
    args.unpaper = resolve_tool_path(args.unpaper, default_unpaper_path(), "unpaper")
    args.tessdata = args.tessdata.expanduser().resolve()

    validate_inputs(sources, args.tesseract, args.pdftoppm, args.tessdata, languages)
    print_plan(sources, pages, profiles, args)

    if args.dry_run:
        return 0

    out_root = args.out or PROJECT_ROOT / ".devkit/tmp/ocr-profile-benchmark" / now_tag()
    out_root = out_root.expanduser().resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    manifest = build_manifest(args, profiles, sources, pages)
    (out_root / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    images = prepare_images(sources, pages, args.dpi, args.pdftoppm, out_root)
    records: list[dict[str, object]] = [manifest]
    for image in images:
        for profile in profiles:
            run_dir = out_root / "runs" / safe_stem(image.source) / image.label / profile.name
            record = run_profile(
                image=image,
                profile=profile,
                tesseract=args.tesseract,
                tessdata=args.tessdata,
                unpaper=args.unpaper,
                threads=args.threads,
                timeout=args.timeout,
                out_dir=run_dir,
            )
            records.append(record)
            print(
                f"{profile.name} {display_path(image.source)} {image.label}: "
                f"text_length={record['text_length']} "
                f"mean_confidence={record['mean_confidence']} "
                f"runtime_ms={record['runtime_ms']} "
                f"success={record['success']}"
            )

    write_summary_files(out_root, records)
    print(f"Wrote: {display_path(out_root / 'summary.csv')}")
    print(f"Artifacts: {display_path(out_root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
