#!/bin/bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

usage() {
  cat <<'EOF'
Usage: scripts/check-native-tools-source-matrix.sh [--all]

Default mode:
- Validate native tool resources for the current host platform/arch

--all mode:
- Validate source readiness for the full release matrix. Generated non-host
  native tool folders may be absent locally when a CI bundling script owns that
  target; host resources are still required.
EOF
}

check_all=0
if [ "$#" -gt 1 ]; then
  usage
  exit 1
fi
if [ "$#" -eq 1 ]; then
  case "$1" in
    --all)
      check_all=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
fi

missing=0
tag_file="$(mktemp)"
trap 'rm -f "$tag_file"' EXIT

resolve_host_tag() {
  local uname_s
  local uname_m
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"

  local platform=""
  local arch=""

  case "$uname_s" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) platform="win32" ;;
    *)
      echo "Error: Unsupported host platform: $uname_s"
      exit 1
      ;;
  esac

  case "$uname_m" in
    x86_64|amd64|x64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "Error: Unsupported host architecture: $uname_m"
      exit 1
      ;;
  esac

  echo "${platform}-${arch}"
}

host_tag="$(resolve_host_tag)"

has_ci_bundler_for_tag() {
  local tag="$1"
  case "$tag" in
    darwin-arm64|darwin-x64)
      [ -f "scripts/bundle-tesseract-macos.sh" ] \
        && [ -f "scripts/bundle-leptonica-unpaper-macos.sh" ] \
        && [ -f "scripts/bundle-pdf-tools-macos.sh" ] \
        && [ -f "scripts/bundle-djvu-macos.sh" ]
      ;;
    linux-arm64|linux-x64)
      [ -f "scripts/bundle-tools-linux.sh" ]
      ;;
    win32-arm64|win32-x64)
      [ -f "scripts/bundle-tools-windows.sh" ]
      ;;
    *)
      return 1
      ;;
  esac
}

mark_missing() {
  local path="$1"
  local label="$2"
  local tag="$3"

  if [ "$check_all" -eq 1 ] && [ "$tag" != "$host_tag" ] && has_ci_bundler_for_tag "$tag"; then
    echo "  CI-GEN  $label: $path"
    return
  fi

  echo "  MISSING $label: $path"
  missing=1
}

check_file_for_tag() {
  local path="$1"
  local label="$2"
  local tag="$3"
  if [ ! -f "$path" ]; then
    mark_missing "$path" "$label" "$tag"
  else
    echo "  OK      $label: $path"
  fi
}

check_dir_for_tag() {
  local path="$1"
  local label="$2"
  local tag="$3"
  if [ ! -d "$path" ]; then
    mark_missing "$path" "$label" "$tag"
  else
    echo "  OK      $label: $path"
  fi
}

check_tag() {
  local tag="$1"
  local platform="${tag%-*}"
  local exe_suffix=""
  if [ "$platform" = "win32" ]; then
    exe_suffix=".exe"
  fi

  echo "== Checking $tag =="
  check_file_for_tag "resources/tesseract/$tag/bin/tesseract$exe_suffix" "tesseract" "$tag"
  if [ "$platform" != "win32" ]; then
    check_file_for_tag "resources/tesseract/$tag/bin/unpaper$exe_suffix" "unpaper" "$tag"
  else
    echo "  SKIP    unpaper: not bundled on Windows"
  fi
  check_file_for_tag "resources/poppler/$tag/bin/pdftoppm$exe_suffix" "pdftoppm" "$tag"
  check_file_for_tag "resources/poppler/$tag/bin/pdftotext$exe_suffix" "pdftotext" "$tag"
  if [ "$platform" = "win32" ]; then
    check_file_for_tag "resources/poppler/$tag/bin/pdftocairo$exe_suffix" "pdftocairo" "$tag"
    check_dir_for_tag "resources/poppler/$tag/share/poppler" "poppler data directory" "$tag"
  fi
  check_file_for_tag "resources/qpdf/$tag/bin/qpdf$exe_suffix" "qpdf" "$tag"
  check_file_for_tag "resources/djvulibre/$tag/bin/ddjvu$exe_suffix" "ddjvu" "$tag"
  check_file_for_tag "resources/djvulibre/$tag/bin/djvused$exe_suffix" "djvused" "$tag"
}

if [ "$check_all" -eq 1 ]; then
  for platform in darwin win32 linux; do
    for arch in x64 arm64; do
      echo "${platform}-${arch}" >> "$tag_file"
    done
  done
else
  resolve_host_tag >> "$tag_file"
fi

sort -u "$tag_file" -o "$tag_file"

while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  check_tag "$tag"
done < "$tag_file"

if [ ! -d "resources/tesseract/tessdata" ]; then
  echo "MISSING tessdata directory: resources/tesseract/tessdata"
  missing=1
elif ! find "resources/tesseract/tessdata" -maxdepth 1 -type f -name '*.traineddata' -print -quit | grep -q .; then
  echo "MISSING traineddata files in resources/tesseract/tessdata"
  missing=1
else
  echo "OK tessdata directory and traineddata files present"
  pnpm run check:ocr-language-model-registry
fi

if [ "$missing" -ne 0 ]; then
  if [ "$check_all" -eq 1 ]; then
    echo "Native tool source matrix check failed (--all)."
  else
    echo "Native tool source matrix check failed (host tag)."
  fi
  exit 1
fi

echo ""
bash "$root_dir/scripts/check-win-dll-allowlist.sh"

if [ "$check_all" -eq 1 ]; then
  echo "Native tool source matrix check passed (--all)."
else
  echo "Native tool source matrix check passed (host tag)."
fi
