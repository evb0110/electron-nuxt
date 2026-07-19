#!/bin/bash
set -euo pipefail

source "$(dirname "$0")/release/platform-arch.sh"

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 <platform: mac|win|linux> <arch: x64|arm64> [release-dir]"
  exit 1
fi

platform="$1"
arch="$2"
release_dir="${3:-release}"
resolve_release_target_platform_arch "$platform" "$arch"
platform_arch="$RELEASE_PLATFORM_ARCH"
exe_suffix="$RELEASE_EXE_SUFFIX"

resource_root=""
native_tool_root=""
mac_app_path=""
if [ "$platform" = "mac" ]; then
  while IFS= read -r -d '' candidate; do
    if [ -d "$candidate/tesseract/$platform_arch" ]; then
      native_tool_root="$candidate"
      contents_dir="$(dirname "$(dirname "$candidate")")"
      resource_root="$contents_dir/Resources"
      mac_app_path="$(dirname "$contents_dir")"
      break
    fi
  done < <(find "$release_dir" -path "*/Contents/MacOS/native-tools" -type d -print0)
else
  while IFS= read -r -d '' candidate; do
    if [ -d "$candidate/tesseract/$platform_arch" ]; then
      resource_root="$candidate"
      native_tool_root="$candidate"
      break
    fi
  done < <(find "$release_dir" -type d \( -name resources -o -name Resources \) -print0)
fi

if [ -z "$resource_root" ] || [ -z "$native_tool_root" ]; then
  echo "Error: Could not locate packaged native tools for $platform_arch in $release_dir/"
  exit 1
fi

echo "Verifying packaged native tools in: $native_tool_root"

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

get_bundled_language_codes() {
  pnpm exec tsx scripts/printOcrLanguageCodes.ts --bundled
}

verify_tessdata_bundle_complete() {
  local tessdata_path="$1"
  local missing=0
  local registry_code
  while IFS= read -r bundled_code; do
    [ -n "$bundled_code" ] || continue
    if [ ! -s "$tessdata_path/$bundled_code.traineddata" ]; then
      echo "Error: Missing default packaged tessdata \"$bundled_code\" ($tessdata_path/$bundled_code.traineddata)"
      missing=1
    fi
  done < <(get_bundled_language_codes)

  local traineddata_file
  while IFS= read -r -d '' traineddata_file; do
    local code
    code="$(basename "$traineddata_file" .traineddata)"
    if ! get_bundled_language_codes | grep -Fxq "$code"; then
      echo "Error: Packaged tessdata contains non-default language \"$code\" ($traineddata_file)"
      missing=1
    fi
  done < <(find "$tessdata_path" -maxdepth 1 -type f -name '*.traineddata' -print0)

  if [ "$missing" -ne 0 ]; then
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

is_macos_app_adhoc_signed() {
  local app_path="$1"
  if [ -z "$app_path" ] || [ ! -d "$app_path" ]; then
    return 1
  fi

  local sign_info
  sign_info="$(codesign -dv --verbose=4 "$app_path" 2>&1 || true)"
  echo "$sign_info" | grep -Eq 'Signature=adhoc|TeamIdentifier=not set'
}

check_file "$native_tool_root/tesseract/$platform_arch/bin/tesseract$exe_suffix" "tesseract binary"
if [ "$platform" != "win" ]; then
  check_file "$native_tool_root/tesseract/$platform_arch/bin/unpaper$exe_suffix" "unpaper binary"
else
  echo "Windows unpaper preprocessing is explicitly unavailable in this package; OCR preprocessing validation must report it missing."
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
verify_tessdata_bundle_complete "$tessdata_dir"

check_file "$native_tool_root/poppler/$platform_arch/bin/pdfinfo$exe_suffix" "pdfinfo binary"
check_file "$native_tool_root/poppler/$platform_arch/bin/pdftoppm$exe_suffix" "pdftoppm binary"
check_file "$native_tool_root/poppler/$platform_arch/bin/pdftotext$exe_suffix" "pdftotext binary"
if [ "$platform" = "win" ]; then
  check_file "$native_tool_root/poppler/$platform_arch/bin/pdftocairo$exe_suffix" "pdftocairo binary"
  check_dir "$native_tool_root/poppler/$platform_arch/share/poppler" "poppler data directory"
fi
if [ "$platform" = "linux" ]; then
  check_dir "$native_tool_root/poppler/$platform_arch/share/poppler" "poppler data directory"
  check_dir "$native_tool_root/poppler/$platform_arch/etc/fonts" "fontconfig directory"
  check_file "$native_tool_root/poppler/$platform_arch/etc/fonts/fonts.conf" "fontconfig configuration"
fi
check_file "$native_tool_root/qpdf/$platform_arch/bin/qpdf$exe_suffix" "qpdf binary"
check_file "$native_tool_root/djvulibre/$platform_arch/bin/ddjvu$exe_suffix" "ddjvu binary"
check_file "$native_tool_root/djvulibre/$platform_arch/bin/djvused$exe_suffix" "djvused binary"
check_file "$native_tool_root/djvulibre/$platform_arch/bin/djvudump$exe_suffix" "djvudump binary"
check_file "$native_tool_root/pdf-image-combine/$platform_arch/bin/evb-pdf-image-combine$exe_suffix" "pdf image combine binary"
check_file "$native_tool_root/pdf-page-ops/$platform_arch/bin/evb-pdf-page-ops$exe_suffix" "pdf page ops binary"
check_file "$native_tool_root/pdf-search/$platform_arch/bin/evb-pdf-search$exe_suffix" "pdf search binary"
check_file "$native_tool_root/scan-cleanup/$platform_arch/bin/evb-scan-cleanup$exe_suffix" "scan cleanup binary"

find_tool_files() {
  local tag="$1"
  local kind="$2"
  local dirs=(
    "$native_tool_root/tesseract/$tag/$kind"
    "$native_tool_root/poppler/$tag/$kind"
    "$native_tool_root/pdf-image-combine/$tag/$kind"
    "$native_tool_root/pdf-page-ops/$tag/$kind"
    "$native_tool_root/pdf-search/$tag/$kind"
    "$native_tool_root/scan-cleanup/$tag/$kind"
    "$native_tool_root/qpdf/$tag/$kind"
    "$native_tool_root/djvulibre/$tag/$kind"
  )

  for dir in "${dirs[@]}"; do
    if [ -d "$dir" ]; then
      find "$dir" -type f
    fi
  done
}

run_macos_tool_once() {
  local command_path="$1"
  shift
  "$command_path" "$@"
}

run_macos_ad_hoc_payload_smoke_mirror() {
  local tool_name="$1"
  shift
  local tool_path="$1"
  shift
  local relative_tool_path="${tool_path#"$native_tool_root"/}"
  local tool_family="${relative_tool_path%%/*}"
  local remaining_path="${relative_tool_path#*/}"
  local tool_tag="${remaining_path%%/*}"
  local payload_root="$native_tool_root/$tool_family/$tool_tag"
  local temp_dir
  local mirror_root
  local mirror_payload_root
  local mirror_tool_path
  local output_file
  local exit_code=0

  if [ "$relative_tool_path" = "$tool_path" ] || [ "$tool_family" = "$relative_tool_path" ] || [ "$tool_tag" = "$remaining_path" ]; then
    echo "Error: Unable to mirror packaged tool path: $tool_path"
    return 1
  fi
  if [ ! -d "$payload_root" ]; then
    echo "Error: Missing packaged payload root for smoke mirror ($payload_root)"
    return 1
  fi

  temp_dir="$(mktemp -d)"
  mirror_root="$temp_dir/native-tools"
  mirror_payload_root="$mirror_root/$tool_family/$tool_tag"
  mirror_tool_path="$mirror_root/$relative_tool_path"
  output_file="$(mktemp)"

  mkdir -p "$(dirname "$mirror_payload_root")"
  cp -R "$payload_root" "$mirror_payload_root"

  echo "Ad-hoc macOS app execution was killed by provenance policy; smoke testing copied signed payload outside .app: $mirror_tool_path $*"
  if run_macos_tool_once "$mirror_tool_path" "$@" >"$output_file" 2>&1; then
    exit_code=0
  else
    exit_code=$?
  fi

  if ! node scripts/release/assert-packaged-tool-smoke.mjs "$tool_name" "$exit_code" "$output_file"; then
    cat "$output_file"
    rm -rf "$temp_dir"
    rm -f "$output_file"
    return 1
  fi

  rm -rf "$temp_dir"
  rm -f "$output_file"
  return 0
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

  echo "Smoke testing packaged tool: $tool_path $*"
  local exit_code=0
  local attempt=1
  local max_attempts=18
  local is_adhoc_app=0
  if is_macos_app_adhoc_signed "$mac_app_path"; then
    is_adhoc_app=1
    max_attempts=1
  fi
  while true; do
    : >"$output_file"
    if run_macos_tool_once "$tool_path" "$@" >"$output_file" 2>&1
    then
      exit_code=0
    else
      exit_code=$?
    fi

    if [ "$exit_code" -ne 137 ] || [ "$attempt" -ge "$max_attempts" ]; then
      break
    fi

    echo "Packaged tool was killed by macOS immediately after signing; verifying signature and retrying ($attempt/$max_attempts): $tool_path"
    codesign --verify --strict --verbose=2 "$tool_path"
    sleep 5
    attempt=$((attempt + 1))
  done

  if [ "$exit_code" -eq 137 ] && [ "$is_adhoc_app" -eq 1 ]; then
    codesign --verify --strict --verbose=2 "$tool_path"
    if run_macos_ad_hoc_payload_smoke_mirror "$tool_name" "$tool_path" "$@"; then
      rm -f "$output_file"
      return
    fi
  fi

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

host_release_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      echo "x64"
      ;;
    arm64|aarch64)
      echo "arm64"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

host_can_execute_target() {
  local target_platform="$1"
  local target_arch="$2"
  local host_os
  host_os="$(uname -s)"
  local host_arch
  host_arch="$(host_release_arch)"

  if [ "$host_arch" != "$target_arch" ]; then
    return 1
  fi

  case "$target_platform:$host_os" in
    linux:Linux)
      return 0
      ;;
    win:MINGW*|win:MSYS*|win:CYGWIN*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

windows_pe_allowed_machines_for_release_arch() {
  case "$1" in
    arm64)
      echo "arm64"
      ;;
    x64)
      echo "ia32,x64"
      ;;
    *)
      echo "Error: Unsupported Windows release architecture for PE verification: $1"
      exit 1
      ;;
  esac
}

run_host_packaged_tool_smoke() {
  local tool_name="$1"
  shift
  local expected_pattern="$1"
  shift
  local tool_path="$1"
  shift
  local output_file
  output_file="$(mktemp)"

  if [ ! -f "$tool_path" ]; then
    echo "Error: Missing packaged tool for smoke test ($tool_path)"
    exit 1
  fi

  echo "Smoke testing packaged tool: $tool_path $*"
  local exit_code=0
  "$tool_path" "$@" >"$output_file" 2>&1 || exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    cat "$output_file"
    rm -f "$output_file"
    echo "Error: Packaged tool smoke test failed ($tool_name) with exit code $exit_code"
    exit "$exit_code"
  fi

  if ! grep -Eiq "$expected_pattern" "$output_file"; then
    cat "$output_file"
    rm -f "$output_file"
    echo "Error: Packaged tool smoke test output for $tool_name did not match /$expected_pattern/"
    exit 1
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
  readonly_update_payload=0
  while IFS= read -r payload_path; do
    echo "Error: macOS update payload is not owner-writable; ShipIt cannot remove quarantine metadata: $payload_path"
    readonly_update_payload=1
  done < <(find "$native_tool_root" \( -type f -o -type d \) ! -perm -u+w -print)
  if [ "$readonly_update_payload" -ne 0 ]; then
    exit 1
  fi

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
    if [ -f "$native_tool_root/tesseract/$platform_arch/bin/tesseract" ]; then
      echo "$native_tool_root/tesseract/$platform_arch/bin/tesseract"
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

  run_macos_packaged_tool_smoke "djvused" "$native_tool_root/djvulibre/$platform_arch/bin/djvused" --help
  run_macos_packaged_tool_smoke "djvudump" "$native_tool_root/djvulibre/$platform_arch/bin/djvudump" --help
  # ddjvu prints usage to stdout and exits 1 for --help on healthy builds.
  run_macos_packaged_tool_smoke "ddjvu" "$native_tool_root/djvulibre/$platform_arch/bin/ddjvu" --help
  run_macos_packaged_tool_smoke "qpdf" "$native_tool_root/qpdf/$platform_arch/bin/qpdf" --version
  run_macos_packaged_tool_smoke "pdfinfo" "$native_tool_root/poppler/$platform_arch/bin/pdfinfo" -v
  run_macos_packaged_tool_smoke "pdftoppm" "$native_tool_root/poppler/$platform_arch/bin/pdftoppm" -v
  run_macos_packaged_tool_smoke "pdftotext" "$native_tool_root/poppler/$platform_arch/bin/pdftotext" -v
  run_macos_packaged_tool_smoke "evb-pdf-image-combine" "$native_tool_root/pdf-image-combine/$platform_arch/bin/evb-pdf-image-combine" --version
  run_macos_packaged_tool_smoke "evb-pdf-image-combine-protocol" "$native_tool_root/pdf-image-combine/$platform_arch/bin/evb-pdf-image-combine" --protocol-version
  run_macos_packaged_tool_smoke "evb-pdf-image-combine-compact-manifest" "$native_tool_root/pdf-image-combine/$platform_arch/bin/evb-pdf-image-combine" --compact-manifest
  run_macos_packaged_tool_smoke "evb-pdf-page-ops" "$native_tool_root/pdf-page-ops/$platform_arch/bin/evb-pdf-page-ops" --version
  run_macos_packaged_tool_smoke "evb-pdf-search" "$native_tool_root/pdf-search/$platform_arch/bin/evb-pdf-search" --version
  run_macos_packaged_tool_smoke "evb-scan-cleanup" "$native_tool_root/scan-cleanup/$platform_arch/bin/evb-scan-cleanup" --version
  run_macos_packaged_tool_smoke "evb-scan-cleanup-protocol" "$native_tool_root/scan-cleanup/$platform_arch/bin/evb-scan-cleanup" --protocol-version
  run_macos_packaged_tool_smoke "tesseract" "$native_tool_root/tesseract/$platform_arch/bin/tesseract" --version
  run_macos_packaged_tool_smoke "unpaper" "$native_tool_root/tesseract/$platform_arch/bin/unpaper" --help
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

  if host_can_execute_target "$platform" "$arch"; then
    run_host_packaged_tool_smoke "tesseract" "tesseract" "$native_tool_root/tesseract/$platform_arch/bin/tesseract" --version
    run_host_packaged_tool_smoke "unpaper" "unpaper|usage" "$native_tool_root/tesseract/$platform_arch/bin/unpaper" --help
  else
    echo "Skipping Linux OCR native tool smoke: host cannot execute $platform_arch"
  fi
fi

if [ "$platform" = "win" ]; then
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  node "$script_dir/release/windows-tesseract-payload-policy.mjs" \
    "$native_tool_root/tesseract/$platform_arch/bin"
  windows_pe_files="$(mktemp)"
  trap 'rm -f "$windows_pe_files"' EXIT
  find_tool_files "$platform_arch" "bin" | grep -Ei '\.(exe|dll)$' > "$windows_pe_files" || true

  if ! node "$script_dir/release/windows-pe-dependencies.mjs" verify \
    --allowed-machines "$(windows_pe_allowed_machines_for_release_arch "$arch")" \
    --system-dll-pattern-file "$script_dir/win-system-dll-pattern.sh" \
    --file-list "$windows_pe_files"
  then
    exit 1
  fi

  rm -f "$windows_pe_files"
  trap - EXIT

  if host_can_execute_target "$platform" "$arch"; then
    run_host_packaged_tool_smoke "tesseract" "tesseract" "$native_tool_root/tesseract/$platform_arch/bin/tesseract$exe_suffix" --version
  else
    echo "Skipping Windows OCR native tool smoke: host cannot execute $platform_arch"
  fi
fi

echo "Native tool packaging verification passed for $platform_arch"
