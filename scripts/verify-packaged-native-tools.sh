#!/bin/bash
set -euo pipefail

source "$(dirname "$0")/release/platform-arch.sh"

if [ "$#" -ne 2 ]; then
  release_target_usage "$0"
  exit 1
fi

platform="$1"
arch="$2"
release_dir="release"
resolve_release_target_platform_arch "$platform" "$arch"
platform_arch="$RELEASE_PLATFORM_ARCH"
exe_suffix="$RELEASE_EXE_SUFFIX"

resource_root=""
while IFS= read -r -d '' candidate; do
  if [ -d "$candidate/tesseract/$platform_arch" ]; then
    resource_root="$candidate"
    break
  fi
done < <(find "$release_dir" -type d \( -name resources -o -name Resources \) -print0)

if [ -z "$resource_root" ]; then
  echo "Error: Could not locate packaged resources for $platform_arch in $release_dir/"
  exit 1
fi

echo "Verifying packaged native tools in: $resource_root"

check_file() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    echo "Error: Missing $label ($path)"
    exit 1
  fi
}

check_dir() {
  local path="$1"
  local label="$2"
  if [ ! -d "$path" ]; then
    echo "Error: Missing $label ($path)"
    exit 1
  fi
}

check_no_absolute_symlinks() {
  local root="$1"
  local label="$2"
  local has_absolute_symlink=0

  while IFS= read -r -d '' link_path; do
    local target
    target="$(readlink "$link_path" || true)"
    case "$target" in
      /*)
        echo "Error: Absolute symlink in $label: $link_path -> $target"
        has_absolute_symlink=1
        ;;
    esac
  done < <(find "$root" -type l -print0)

  if [ "$has_absolute_symlink" -ne 0 ]; then
    exit 1
  fi
}

macos_macho_arch_for_release_arch() {
  case "$1" in
    arm64)
      echo "arm64"
      ;;
    x64)
      echo "x86_64"
      ;;
    *)
      echo "Error: Unsupported macOS release architecture for Mach-O verification: $1"
      exit 1
      ;;
  esac
}

check_macos_file_arch() {
  local file_path="$1"
  local expected_arch="$2"
  if ! file "$file_path" 2>/dev/null | grep -q 'Mach-O'; then
    return 0
  fi

  local archs
  archs="$(lipo -archs "$file_path" 2>/dev/null || true)"
  if [ -z "$archs" ]; then
    echo "Error: Unable to determine Mach-O architecture for $file_path"
    return 1
  fi

  case " $archs " in
    *" $expected_arch "*)
      return 0
      ;;
    *)
      echo "Error: $file_path does not contain expected architecture $expected_arch (found: $archs)"
      return 1
      ;;
  esac
}

page_processor_required_for_platform() {
  [ "$platform" = "mac" ]
}

check_file "$resource_root/tesseract/$platform_arch/bin/tesseract$exe_suffix" "tesseract binary"
if [ "$platform" != "win" ]; then
  check_file "$resource_root/tesseract/$platform_arch/bin/unpaper$exe_suffix" "unpaper binary"
fi

tessdata_dir="$resource_root/tesseract/tessdata"
if [ ! -d "$tessdata_dir" ]; then
  echo "Error: Missing tessdata directory ($tessdata_dir)"
  exit 1
fi
if ! find "$tessdata_dir" -maxdepth 1 -type f -name '*.traineddata' -print -quit | grep -q .; then
  echo "Error: No traineddata files found in $tessdata_dir"
  exit 1
fi

check_file "$resource_root/poppler/$platform_arch/bin/pdftoppm$exe_suffix" "pdftoppm binary"
check_file "$resource_root/poppler/$platform_arch/bin/pdftotext$exe_suffix" "pdftotext binary"
if [ "$platform" = "win" ]; then
  check_file "$resource_root/poppler/$platform_arch/bin/pdftocairo$exe_suffix" "pdftocairo binary"
  check_dir "$resource_root/poppler/$platform_arch/share/poppler" "poppler data directory"
fi
check_file "$resource_root/qpdf/$platform_arch/bin/qpdf$exe_suffix" "qpdf binary"
check_file "$resource_root/djvulibre/$platform_arch/bin/ddjvu$exe_suffix" "ddjvu binary"
check_file "$resource_root/djvulibre/$platform_arch/bin/djvused$exe_suffix" "djvused binary"
check_file "$resource_root/pdf-image-combine/$platform_arch/bin/evb-pdf-image-combine$exe_suffix" "pdf image combine binary"
check_file "$resource_root/pdf-page-ops/$platform_arch/bin/evb-pdf-page-ops$exe_suffix" "pdf page ops binary"
check_file "$resource_root/pdf-search/$platform_arch/bin/evb-pdf-search$exe_suffix" "pdf search binary"

page_processor_root="$resource_root/page-processing/$platform_arch"
page_processor_binary="$page_processor_root/bin/page-processor/page-processor$exe_suffix"
page_processor_internal_dir="$page_processor_root/bin/page-processor/_internal"
if [ -d "$page_processor_root" ]; then
  check_file "$page_processor_binary" "page-processor binary"
  if [ "$platform" = "mac" ]; then
    check_dir "$page_processor_internal_dir" "page-processor PyInstaller _internal directory"
    if ! find "$page_processor_internal_dir" -type f -print -quit | grep -q .; then
      echo "Error: page-processor PyInstaller _internal directory is empty ($page_processor_internal_dir)"
      exit 1
    fi
    check_no_absolute_symlinks "$page_processor_internal_dir" "page-processor PyInstaller _internal directory"
  fi
elif page_processor_required_for_platform; then
  echo "Error: Missing required page-processor packaged resources ($page_processor_root)"
  exit 1
else
  echo "Skipping page-processor packaged resource check for $platform_arch"
fi

find_tool_files() {
  local tag="$1"
  local kind="$2"
  local dirs=(
    "$resource_root/tesseract/$tag/$kind"
    "$resource_root/poppler/$tag/$kind"
    "$resource_root/page-processing/$tag/$kind"
    "$resource_root/pdf-image-combine/$tag/$kind"
    "$resource_root/pdf-page-ops/$tag/$kind"
    "$resource_root/pdf-search/$tag/$kind"
    "$resource_root/qpdf/$tag/$kind"
    "$resource_root/djvulibre/$tag/$kind"
  )

  for dir in "${dirs[@]}"; do
    if [ -d "$dir" ]; then
      find "$dir" -type f
    fi
  done
}

run_macos_packaged_tool_smoke() {
  local tool_name="$1"
  shift
  local tool_path="$1"
  shift
  local output_file
  output_file="$(mktemp)"

  if [ ! -f "$tool_path" ]; then
    echo "Error: Missing packaged tool for smoke test ($tool_path)"
    exit 1
  fi

  local resource_base="$resource_root"
  local dyld_paths=()
  for candidate in \
    "$resource_base/tesseract/$platform_arch/lib" \
    "$resource_base/poppler/$platform_arch/lib" \
    "$resource_base/qpdf/$platform_arch/lib" \
    "$resource_base/djvulibre/$platform_arch/lib"
  do
    if [ -d "$candidate" ]; then
      dyld_paths+=("$candidate")
    fi
  done

  local joined_dyld_path=""
  if [ "${#dyld_paths[@]}" -gt 0 ]; then
    joined_dyld_path="$(IFS=:; printf '%s' "${dyld_paths[*]}")"
  fi

  echo "Smoke testing packaged tool: $tool_path $*"
  local exit_code=0
  local attempt=1
  local max_attempts=8
  while true; do
    : >"$output_file"
    if env \
      DYLD_LIBRARY_PATH="$joined_dyld_path" \
      LD_LIBRARY_PATH="$joined_dyld_path" \
      "$tool_path" "$@" >"$output_file" 2>&1
    then
      exit_code=0
    else
      exit_code=$?
    fi

    if [ "$exit_code" -ne 137 ] || [ "$attempt" -ge "$max_attempts" ]; then
      break
    fi

    echo "Packaged tool was killed by macOS immediately after signing; verifying signature and retrying: $tool_path"
    codesign --verify --strict --verbose=2 "$tool_path"
    sleep 5
    attempt=$((attempt + 1))
  done

  if ! node scripts/release/assert-packaged-tool-smoke.mjs "$tool_name" "$exit_code" "$output_file"; then
    cat "$output_file"
    rm -f "$output_file"
    if [ "$exit_code" -eq 0 ]; then
      exit 1
    fi
    exit "$exit_code"
  fi

  rm -f "$output_file"
}

if [ "$platform" = "mac" ]; then
  if ! command -v lipo >/dev/null 2>&1; then
    echo "Error: lipo is required for macOS architecture verification"
    exit 1
  fi
  if ! command -v file >/dev/null 2>&1; then
    echo "Error: file is required for macOS architecture verification"
    exit 1
  fi

  expected_macho_arch="$(macos_macho_arch_for_release_arch "$arch")"
  unresolved=0
  arch_mismatch=0
  while IFS= read -r file; do
    refs="$(otool -L "$file" 2>/dev/null | grep -E '/opt/homebrew|/usr/local/opt|/usr/local/Cellar' || true)"
    if [ -n "$refs" ]; then
      echo "Error: Unresolved Homebrew reference in $file"
      echo "$refs" | sed 's/^/  /'
      unresolved=1
    fi

    if ! check_macos_file_arch "$file" "$expected_macho_arch"; then
      arch_mismatch=1
    fi
  done < <(
    if [ -f "$resource_root/tesseract/$platform_arch/bin/tesseract" ]; then
      echo "$resource_root/tesseract/$platform_arch/bin/tesseract"
    fi
    find_tool_files "$platform_arch" "bin"
    find_tool_files "$platform_arch" "lib"
  )

  if [ "$unresolved" -ne 0 ]; then
    exit 1
  fi
  if [ "$arch_mismatch" -ne 0 ]; then
    exit 1
  fi

  run_macos_packaged_tool_smoke "djvused" "$resource_root/djvulibre/$platform_arch/bin/djvused" --help
  # ddjvu prints usage to stdout and exits 1 for --help on healthy builds.
  run_macos_packaged_tool_smoke "ddjvu" "$resource_root/djvulibre/$platform_arch/bin/ddjvu" --help
  run_macos_packaged_tool_smoke "qpdf" "$resource_root/qpdf/$platform_arch/bin/qpdf" --version
  run_macos_packaged_tool_smoke "pdftoppm" "$resource_root/poppler/$platform_arch/bin/pdftoppm" -v
  run_macos_packaged_tool_smoke "pdftotext" "$resource_root/poppler/$platform_arch/bin/pdftotext" -v
  run_macos_packaged_tool_smoke "evb-pdf-image-combine" "$resource_root/pdf-image-combine/$platform_arch/bin/evb-pdf-image-combine" --version
  run_macos_packaged_tool_smoke "evb-pdf-page-ops" "$resource_root/pdf-page-ops/$platform_arch/bin/evb-pdf-page-ops" --version
  run_macos_packaged_tool_smoke "evb-pdf-search" "$resource_root/pdf-search/$platform_arch/bin/evb-pdf-search" --version
  if page_processor_required_for_platform || [ -f "$page_processor_binary" ]; then
    run_macos_packaged_tool_smoke "page-processor" "$page_processor_binary" --version
  fi
  run_macos_packaged_tool_smoke "tesseract" "$resource_root/tesseract/$platform_arch/bin/tesseract" --version
  run_macos_packaged_tool_smoke "unpaper" "$resource_root/tesseract/$platform_arch/bin/unpaper" --help
fi

if [ "$platform" = "linux" ]; then
  if ! command -v ldd >/dev/null 2>&1; then
    echo "Error: ldd is required for linux dependency verification"
    exit 1
  fi

  unresolved=0
  while IFS= read -r file; do
    if ! file "$file" 2>/dev/null | grep -q 'ELF'; then
      continue
    fi

    refs="$(ldd "$file" 2>/dev/null || true)"
    if echo "$refs" | grep -q 'not found'; then
      echo "Error: Missing shared library dependency in $file"
      echo "$refs" | sed 's/^/  /'
      unresolved=1
    fi
  done < <(
    find_tool_files "$platform_arch" "bin"
    find_tool_files "$platform_arch" "lib"
  )

  if [ "$unresolved" -ne 0 ]; then
    exit 1
  fi
fi

if [ "$platform" = "win" ]; then
  if ! command -v objdump >/dev/null 2>&1; then
    echo "Error: objdump is required for windows dependency verification"
    exit 1
  fi

  script_dir="$(cd "$(dirname "$0")" && pwd)"
  source "$script_dir/win-system-dll-pattern.sh"

  bundled_dlls_file="$(mktemp)"
  trap 'rm -f "$bundled_dlls_file"' EXIT

  while IFS= read -r file; do
    basename "$file" | tr '[:upper:]' '[:lower:]' >> "$bundled_dlls_file"
  done < <(find_tool_files "$platform_arch" "bin" | grep -i '\.dll$' || true)
  sort -u -o "$bundled_dlls_file" "$bundled_dlls_file"

  unresolved=0
  while IFS= read -r file; do
    while IFS= read -r dep; do
      dep_lc="$(printf '%s' "$dep" | tr '[:upper:]' '[:lower:]')"
      if [[ "$dep_lc" =~ $system_dll_pattern ]]; then
        continue
      fi
      if ! grep -Fxq "$dep_lc" "$bundled_dlls_file"; then
        # MinGW/MSYS2 DLLs may be named with lib prefix (e.g. libglib-2.0-0.dll)
        # while the import table references the non-prefixed name (glib-2.0-0.dll)
        if ! grep -Fxq "lib$dep_lc" "$bundled_dlls_file"; then
          echo "Error: Missing bundled DLL dependency \"$dep\" for $file"
          unresolved=1
        fi
      fi
    done < <(objdump -p "$file" 2>/dev/null | awk '/DLL Name:/{print $3}')
  done < <(find_tool_files "$platform_arch" "bin" | grep -Ei '\.(exe|dll)$' || true)

  rm -f "$bundled_dlls_file"
  trap - EXIT

  if [ "$unresolved" -ne 0 ]; then
    exit 1
  fi
fi

echo "Native tool packaging verification passed for $platform_arch"
