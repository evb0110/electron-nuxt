#!/bin/bash
# Bundle DjVuLibre tools (ddjvu, djvused, djvudump) for macOS
# Copies from Homebrew, fixes dylib paths, ad-hoc codesigns
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="${EVB_DJVU_RESOURCES_DIR:-$PROJECT_ROOT/resources}"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PLATFORM_ARCH="darwin-arm64" ;;
  x86_64) PLATFORM_ARCH="darwin-x64" ;;
  *)      echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
esac

DEST="$RESOURCES_DIR/djvulibre/$PLATFORM_ARCH"

echo "=========================================="
echo "Bundling DjVuLibre for $PLATFORM_ARCH"
echo "=========================================="

# Check for Homebrew
if ! command -v brew &> /dev/null; then
  echo "Error: Homebrew is required. Install from https://brew.sh"
  exit 1
fi

for required_command in otool install_name_tool codesign; do
  if ! command -v "$required_command" &> /dev/null; then
    echo "Error: Required macOS bundling command not found: $required_command"
    exit 1
  fi
done

# Install/update djvulibre
echo ""
echo "Installing/updating djvulibre via Homebrew..."
brew install djvulibre || brew upgrade djvulibre || true

BREW_PREFIX="$(brew --prefix)"

# Create directories
mkdir -p "$DEST/bin" "$DEST/lib"

# Clean previous build
rm -f "$DEST/bin/"* "$DEST/lib/"*

# ==========================================
# Copy binaries
# ==========================================
echo ""
echo "Copying binaries..."

for tool in ddjvu djvused djvudump; do
  if [ -f "$BREW_PREFIX/bin/$tool" ]; then
    cp "$BREW_PREFIX/bin/$tool" "$DEST/bin/"
    echo "  Copied $tool"
  else
    echo "  Error: $tool not found at $BREW_PREFIX/bin/$tool"
    exit 1
  fi
done

# ==========================================
# Copy libraries
# ==========================================
echo ""
echo "Copying libraries..."

DJVU_OPT="$BREW_PREFIX/opt/djvulibre"

# Core DjVuLibre library
cp -L "$DJVU_OPT/lib/libdjvulibre.21.dylib" "$DEST/lib/"
echo "  Copied libdjvulibre.21.dylib"

copy_dylib() {
  local source="$1"
  local name
  name="$(basename "$source")"

  if [ ! -f "$DEST/lib/$name" ]; then
    cp -L "$source" "$DEST/lib/$name"
    echo "  Copied transitive dependency: $name"
  fi
}

resolve_dylib_source() {
  local dependency="$1"
  local dependency_name
  dependency_name="$(basename "$dependency")"

  if [ -f "$dependency" ]; then
    echo "$dependency"
    return
  fi

  find "$BREW_PREFIX" \( -type f -o -type l \) -name "$dependency_name" -print -quit 2>/dev/null || true
}

# Homebrew formulas gain and lose transitive dependencies independently of
# DjVuLibre. Derive the complete non-system closure from the installed Mach-O
# files instead of maintaining another formula snapshot here.
copy_deps_recursive() {
  local files=("$@")
  local added=1

  while [ "$added" -gt 0 ]; do
    added=0
    for file in "${files[@]}"; do
      [ -f "$file" ] || continue

      local dependencies
      dependencies="$(otool -L "$file" 2>/dev/null | awk 'NR > 1 {print $1}' || true)"
      for dependency in $dependencies; do
        case "$dependency" in
          /usr/lib/*|/System/*)
            continue
            ;;
        esac

        local dependency_name
        dependency_name="$(basename "$dependency")"
        if [ -f "$DEST/lib/$dependency_name" ]; then
          continue
        fi

        local dependency_source
        dependency_source="$(resolve_dylib_source "$dependency")"
        if [ -z "$dependency_source" ]; then
          echo "Error: Unable to resolve non-system dependency $dependency (referenced by $file)"
          exit 1
        fi

        copy_dylib "$dependency_source"
        files+=("$DEST/lib/$dependency_name")
        added=1
      done
    done
  done
}

copy_deps_recursive "$DEST/bin/"* "$DEST/lib/"*.dylib

# ==========================================
# Fix library paths
# ==========================================
echo ""
echo "Fixing library paths..."

# Fix all libraries: set ID and rewrite Homebrew references
for lib in "$DEST/lib/"*.dylib; do
  lib_name="$(basename "$lib")"

  # Set the library's own ID
  install_name_tool -id "@loader_path/$lib_name" "$lib" 2>/dev/null || true

  # Fix Homebrew dependencies to use @loader_path
  brew_deps="$(otool -L "$lib" | grep "$BREW_PREFIX" | awk '{print $1}')" || true
  for dep in $brew_deps; do
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done

  # Fix @rpath references
  rpath_deps="$(otool -L "$lib" | grep "@rpath" | awk '{print $1}')" || true
  for dep in $rpath_deps; do
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done

  echo "  Fixed $lib_name"
done

# Fix binaries: point to ../lib/
echo ""
echo "Fixing binary paths..."
for bin in "$DEST/bin/"*; do
  bin_name="$(basename "$bin")"

  brew_deps="$(otool -L "$bin" | grep "$BREW_PREFIX" | awk '{print $1}')" || true
  for dep in $brew_deps; do
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$bin"
  done

  rpath_deps="$(otool -L "$bin" | grep "@rpath" | awk '{print $1}')" || true
  for dep in $rpath_deps; do
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$bin"
  done

  echo "  Fixed $bin_name"
done

verify_dependency_closure() {
  local files=("$@")

  for file in "${files[@]}"; do
    [ -f "$file" ] || continue

    local dependencies
    dependencies="$(otool -L "$file" 2>/dev/null | awk 'NR > 1 {print $1}' || true)"
    for dependency in $dependencies; do
      case "$dependency" in
        /usr/lib/*|/System/*)
          continue
          ;;
      esac

      local dependency_name
      dependency_name="$(basename "$dependency")"
      if [ ! -f "$DEST/lib/$dependency_name" ]; then
        echo "Error: Bundled dependency closure is missing $dependency_name (referenced by $file)"
        exit 1
      fi
    done
  done
}

verify_dependency_closure "$DEST/bin/"* "$DEST/lib/"*.dylib

# ==========================================
# Codesign
# ==========================================
echo ""
echo "Codesigning (ad-hoc)..."

codesign --force --sign - "$DEST/bin/"* "$DEST/lib/"*.dylib
echo "  Done"

# ==========================================
# Verify
# ==========================================
echo ""
echo "=========================================="
echo "Verification"
echo "=========================================="

echo ""
echo "ddjvu dependencies:"
otool -L "$DEST/bin/ddjvu"

echo ""
echo "djvused dependencies:"
otool -L "$DEST/bin/djvused"

echo ""
echo "djvudump dependencies:"
otool -L "$DEST/bin/djvudump"

echo ""
echo "libdjvulibre dependencies:"
otool -L "$DEST/lib/libdjvulibre.21.dylib"

# Test run
echo ""
echo "Testing ddjvu..."
smoke_output="$(mktemp)"
smoke_exit_code=0
if "$DEST/bin/ddjvu" --help > "$smoke_output" 2>&1; then
  smoke_exit_code=0
else
  smoke_exit_code=$?
fi
if node "$PROJECT_ROOT/scripts/release/assert-packaged-tool-smoke.mjs" \
  ddjvu "$smoke_exit_code" "$smoke_output"; then
  rm -f "$smoke_output"
  echo "  ddjvu runs successfully"
else
  cat "$smoke_output"
  rm -f "$smoke_output"
  echo "Error: Bundled ddjvu failed its smoke test"
  exit 1
fi

echo ""
echo "Files:"
ls -lh "$DEST/bin/"
echo ""
ls -lh "$DEST/lib/"

echo ""
echo "Total size: $(du -sh "$DEST" | awk '{print $1}')"
echo ""
echo "Done!"
