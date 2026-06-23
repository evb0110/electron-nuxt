#!/bin/bash
# Optional devkit bundler for the dormant Python page-processor.
# Not part of default release packaging or release verification.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PYTHON_DIR="$PROJECT_ROOT/python/page-processor"
RESOURCES_DIR="$PROJECT_ROOT/resources/page-processing"
DEVKIT_TMP_DIR="$PROJECT_ROOT/.devkit/tmp"

normalize_macos_arch() {
  case "$1" in
    arm64|aarch64)
      echo "arm64"
      ;;
    x86_64|amd64|x64)
      echo "x86_64"
      ;;
    *)
      echo "Error: Unsupported architecture: $1" >&2
      exit 1
      ;;
  esac
}

HOST_MACHO_ARCH="$(normalize_macos_arch "$(uname -m)")"
PYTHON_MACHO_ARCH=""
PLATFORM_ARCH=""
OUTPUT_DIR=""
BUNDLE_ROOT=""
BINARY_PATH=""
INTERNAL_DIR=""
SMOKE_DIR=""
VENV_ACTIVE=0

cleanup_build_artifacts() {
  if [ "$VENV_ACTIVE" -eq 1 ]; then
    deactivate
    VENV_ACTIVE=0
  fi

  rm -rf "$PYTHON_DIR/.venv"
  rm -rf "$PYTHON_DIR/build"
  rm -rf "$PYTHON_DIR/__pycache__"
  rm -f "$PYTHON_DIR"/*.spec
  find "$PYTHON_DIR" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
}

cleanup_on_error() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    set +e
    cleanup_build_artifacts
    if [ -n "$SMOKE_DIR" ] && [ -d "$SMOKE_DIR" ]; then
      echo "Smoke artifacts preserved: $SMOKE_DIR"
    fi
  fi
  exit "$status"
}

trap cleanup_on_error EXIT

verify_macho_arch() {
  local file_path="$1"
  local expected_arch="$2"
  local archs
  archs="$(lipo -archs "$file_path" 2>/dev/null || true)"
  if [ -z "$archs" ]; then
    if file "$file_path" 2>/dev/null | grep -q 'Mach-O'; then
      echo "Error: Unable to determine Mach-O architecture for $file_path"
      exit 1
    fi
    return
  fi

  case " $archs " in
    *" $expected_arch "*)
      ;;
    *)
      echo "Error: $file_path does not contain expected architecture $expected_arch (found: $archs)"
      exit 1
      ;;
  esac
}

verify_bundle_architecture() {
  local expected_arch="$1"
  while IFS= read -r -d '' file_path; do
    if file "$file_path" 2>/dev/null | grep -q 'Mach-O'; then
      verify_macho_arch "$file_path" "$expected_arch"
    fi
  done < <(find "$BUNDLE_ROOT" -type f -print0)
}

# Step 1: Verify prerequisites
echo ""
echo "Checking prerequisites..."

if ! command -v python3 &> /dev/null; then
  echo "Error: python3 is required"
  exit 1
fi
if ! command -v lipo &> /dev/null; then
  echo "Error: lipo is required for macOS architecture verification"
  exit 1
fi
if ! command -v file &> /dev/null; then
  echo "Error: file is required for macOS architecture verification"
  exit 1
fi

PYTHON_MACHO_ARCH="$(normalize_macos_arch "$(python3 -c 'import platform; print(platform.machine())')")"
if [ "$PYTHON_MACHO_ARCH" != "$HOST_MACHO_ARCH" ]; then
  echo "Error: python3 is running as $PYTHON_MACHO_ARCH but the host shell is $HOST_MACHO_ARCH"
  echo "Run the bundler with a native Python interpreter so the PyInstaller output matches the resource tag."
  exit 1
fi

case "$PYTHON_MACHO_ARCH" in
  arm64)  PLATFORM_ARCH="darwin-arm64" ;;
  x86_64) PLATFORM_ARCH="darwin-x64" ;;
esac

OUTPUT_DIR="$RESOURCES_DIR/$PLATFORM_ARCH"
BUNDLE_ROOT="$OUTPUT_DIR/bin/page-processor"
BINARY_PATH="$BUNDLE_ROOT/page-processor"
INTERNAL_DIR="$BUNDLE_ROOT/_internal"

echo "=========================================="
echo "Bundling page-processor for $PLATFORM_ARCH"
echo "=========================================="

if [ ! -d "$PYTHON_DIR" ]; then
  echo "Error: Python source directory not found at $PYTHON_DIR"
  exit 1
fi

if [ ! -f "$PYTHON_DIR/requirements.txt" ]; then
  echo "Error: requirements.txt not found in $PYTHON_DIR"
  exit 1
fi

echo "  Python: $(python3 --version)"
echo "  Python arch: $PYTHON_MACHO_ARCH"
echo "  Source: $PYTHON_DIR"
echo "  Output: $OUTPUT_DIR"

# Step 2: Create output directory
echo ""
echo "Creating output directory..."
mkdir -p "$OUTPUT_DIR"

# Step 3: Create virtual environment
echo ""
echo "=========================================="
echo "Setting up virtual environment..."
echo "=========================================="

cd "$PYTHON_DIR"

# Remove existing venv if present
if [ -d ".venv" ]; then
  echo "Removing existing virtual environment..."
  rm -rf .venv
fi

echo "Creating new virtual environment..."
python3 -m venv .venv

echo "Activating virtual environment..."
source .venv/bin/activate
VENV_ACTIVE=1

# Step 4: Install dependencies
echo ""
echo "=========================================="
echo "Installing dependencies..."
echo "=========================================="

pip install --upgrade pip
pip install -r requirements.txt

echo "  Installed packages:"
pip list | grep -E "(pyinstaller|pdf|ocr|pillow)" | sed 's/^/    /' || true

# Step 5: Build with PyInstaller
echo ""
echo "=========================================="
echo "Building with PyInstaller..."
echo "=========================================="

# Clean previous build artifacts
rm -rf build dist *.spec

rm -rf "$BUNDLE_ROOT"

PYINSTALLER_COLLECT_DATA_PACKAGES=(
  page_dewarp
)
PYINSTALLER_COPY_METADATA_PACKAGES=(
  page-dewarp
)
PYINSTALLER_HIDDEN_IMPORTS=(
  crop
  deskew_wrapper
  detection
  dewarp
  img2pdf
  page_dewarp.image
  page_dewarp.options
  page_dewarp.optimise._scipy
  PIL.Image
  pikepdf
  processor
  scipy.optimize
  split
  stages.dewarp
  stages.deskew
  stages.geometry
  stages.image_utils
  stages.io
  stages.rotation
  stages.split
)
PYINSTALLER_ARGS=()
for package in "${PYINSTALLER_COLLECT_DATA_PACKAGES[@]}"; do
  PYINSTALLER_ARGS+=(--collect-data "$package")
done
for package in "${PYINSTALLER_COPY_METADATA_PACKAGES[@]}"; do
  PYINSTALLER_ARGS+=(--copy-metadata "$package")
done
for import_name in "${PYINSTALLER_HIDDEN_IMPORTS[@]}"; do
  PYINSTALLER_ARGS+=(--hidden-import "$import_name")
done

pyinstaller \
  --onedir \
  --clean \
  --name page-processor \
  --paths "$PYTHON_DIR" \
  --distpath "$OUTPUT_DIR/bin" \
  "${PYINSTALLER_ARGS[@]}" \
  main.py

echo "  Build completed"

# Step 6: Verify output
echo ""
echo "=========================================="
echo "Verifying build..."
echo "=========================================="

if [ ! -f "$BINARY_PATH" ]; then
  echo "Error: Build failed - binary not found at $BINARY_PATH"
  exit 1
fi
if [ ! -d "$INTERNAL_DIR" ]; then
  echo "Error: Build failed - PyInstaller onedir _internal directory not found at $INTERNAL_DIR"
  exit 1
fi
if ! find "$INTERNAL_DIR" -type f -print -quit | grep -q .; then
  echo "Error: Build failed - PyInstaller onedir _internal directory is empty"
  exit 1
fi

echo "  Binary exists: $BINARY_PATH"
echo "  Size: $(du -h "$BINARY_PATH" | awk '{print $1}')"

# Make sure it's executable
chmod +x "$BINARY_PATH"

echo ""
echo "Verifying Mach-O architectures..."
verify_bundle_architecture "$PYTHON_MACHO_ARCH"
echo "  Mach-O files contain $PYTHON_MACHO_ARCH"

echo ""
echo "Testing binary with generated fixtures..."
mkdir -p "$DEVKIT_TMP_DIR"
SMOKE_DIR="$(mktemp -d "$DEVKIT_TMP_DIR/page-processor-bundle-smoke.XXXXXX")"
SMOKE_IMAGE="$SMOKE_DIR/fixture.png"
SMOKE_OUTPUT_DIR="$SMOKE_DIR/out"
SMOKE_PDF="$SMOKE_DIR/fixture.pdf"
python - "$SMOKE_IMAGE" <<'PY'
import sys
from pathlib import Path

import cv2
import numpy as np

out_path = Path(sys.argv[1])
image = np.full((220, 160, 3), 255, dtype=np.uint8)
cv2.rectangle(image, (42, 48), (122, 172), (0, 0, 0), 2)
cv2.line(image, (54, 76), (110, 76), (0, 0, 0), 2)
cv2.line(image, (54, 100), (112, 100), (0, 0, 0), 2)
cv2.line(image, (54, 124), (104, 124), (0, 0, 0), 2)
if not cv2.imwrite(str(out_path), image, [cv2.IMWRITE_PNG_COMPRESSION, 0]):
    raise SystemExit(f"failed to write fixture: {out_path}")
PY

if [ "$("$BINARY_PATH" --version)" != "page-processor 2.0.0" ]; then
  echo "Error: Binary returned unexpected version output"
  exit 1
fi

"$BINARY_PATH" list-stages > "$SMOKE_DIR/list-stages.stdout.log" 2> "$SMOKE_DIR/list-stages.stderr.log"
PAGE_PROCESSOR_PNG_COMPRESSION=0 "$BINARY_PATH" \
  process \
  "$SMOKE_IMAGE" \
  "$SMOKE_OUTPUT_DIR" \
  --operations crop deskew \
  --no-auto-detect \
  --min-skew-angle 90 \
  --crop-padding 6 \
  > "$SMOKE_DIR/process.stdout.log" \
  2> "$SMOKE_DIR/process.stderr.log"
python - "$SMOKE_DIR/process.stdout.log" <<'PY'
import json
import sys

payloads = []
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if line:
            payloads.append(json.loads(line))

results = [payload for payload in payloads if payload.get("type") == "result"]
if len(results) != 1 or not results[0].get("success"):
    raise SystemExit(f"unexpected process result payloads: {results!r}")
if not results[0].get("output_paths"):
    raise SystemExit(f"process produced no output paths: {results[0]!r}")
PY

"$BINARY_PATH" img2pdf "$SMOKE_IMAGE" "$SMOKE_PDF" --dpi 200 > "$SMOKE_DIR/img2pdf.stdout.log" 2> "$SMOKE_DIR/img2pdf.stderr.log"
python - "$SMOKE_PDF" <<'PY'
import sys
from pathlib import Path

pdf_path = Path(sys.argv[1])
if pdf_path.read_bytes()[:5] != b"%PDF-":
    raise SystemExit(f"img2pdf output is not a PDF: {pdf_path}")
PY

echo "  Binary fixture smoke passed"

# Step 7: Cleanup
echo ""
echo "=========================================="
echo "Cleaning up..."
echo "=========================================="

cleanup_build_artifacts
rm -rf "$SMOKE_DIR"
SMOKE_DIR=""
trap - EXIT

echo "  Cleanup completed"

# Step 8: Summary
echo ""
echo "=========================================="
echo "Build complete!"
echo "=========================================="
echo ""
echo "Output: $BINARY_PATH"
echo "Size:   $(du -h "$BINARY_PATH" | awk '{print $1}')"
echo ""
echo "Next steps:"
echo "1. Test the binary: $BINARY_PATH --help"
echo "2. Use manually for devkit maintenance, or opt in explicitly with EVB_INCLUDE_PAGE_PROCESSOR=1"
