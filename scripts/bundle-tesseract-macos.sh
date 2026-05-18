#!/bin/bash
# Bundle Tesseract and dependencies for macOS
# Makes binaries relocatable using @executable_path and @loader_path
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PLATFORM_ARCH="darwin-arm64"; BREW="/opt/homebrew" ;;
  x86_64) PLATFORM_ARCH="darwin-x64"; BREW="/usr/local" ;;
  *)      echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

DEST="$PROJECT_ROOT/resources/tesseract/$PLATFORM_ARCH"
echo "Bundling Tesseract for $PLATFORM_ARCH..."
echo "Homebrew prefix: $BREW"

# Create directories
mkdir -p "$DEST/bin" "$DEST/lib"

# Clean previous build
rm -f "$DEST/bin/"* "$DEST/lib/"*

echo "Copying binaries and libraries..."

# Copy tesseract binary
cp "$BREW/bin/tesseract" "$DEST/bin/"

copy_dylib() {
  local source="$1"
  local name
  name="$(basename "$source")"

  if [ ! -f "$DEST/lib/$name" ]; then
    cp -L "$source" "$DEST/lib/$name"
    echo "  Copied $name"
  fi
}

resolve_dylib_source() {
  local dep="$1"
  local dep_name
  dep_name="$(basename "$dep")"

  if [[ "$dep" == "$BREW/"* ]] && [ -f "$dep" ]; then
    echo "$dep"
    return
  fi

  find "$BREW" \( -type f -o -type l \) -name "$dep_name" -print -quit 2>/dev/null || true
}

copy_deps_recursive() {
  local files=("$@")
  local added=1

  while [ "$added" -gt 0 ]; do
    added=0
    for file in "${files[@]}"; do
      [ -f "$file" ] || continue

      local deps
      deps="$(otool -L "$file" 2>/dev/null | awk 'NR > 1 {print $1}' || true)"
      for dep in $deps; do
        case "$dep" in
          /usr/lib/*|/System/*)
            continue
            ;;
        esac

        local dep_name
        dep_name="$(basename "$dep")"
        if [ -f "$DEST/lib/$dep_name" ]; then
          continue
        fi

        local dep_source
        dep_source="$(resolve_dylib_source "$dep")"
        if [ -n "$dep_source" ]; then
          copy_dylib "$dep_source"
          files+=("$DEST/lib/$dep_name")
          added=1
        fi
      done
    done
  done
}

# Seed with the direct libraries expected by the bundled tesseract binary.
copy_dylib "$BREW/opt/tesseract/lib/libtesseract.5.dylib"
copy_dylib "$BREW/opt/leptonica/lib/libleptonica.6.dylib"
copy_dylib "$BREW/opt/libarchive/lib/libarchive.13.dylib"

# Homebrew formulas gain transitive dependencies over time. Copy the closure so
# signed app smoke tests catch missing dylibs before release packaging does.
copy_deps_recursive "$DEST/bin/tesseract" "$DEST/lib/"*.dylib

echo "Fixing library paths..."

# Helper function to fix a library's dependencies
fix_lib() {
  local lib="$1"
  local lib_name="$(basename "$lib")"

  # Set the library's own ID to use @loader_path
  install_name_tool -id "@loader_path/$lib_name" "$lib" 2>/dev/null || true

  # Fix all Homebrew dependencies to use @loader_path
  local brew_deps
  brew_deps="$(otool -L "$lib" | grep "$BREW" | awk '{print $1}')" || true
  for dep in $brew_deps; do
    local dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done

  # Fix @rpath references to use @loader_path
  local rpath_deps
  rpath_deps="$(otool -L "$lib" | grep "@rpath" | awk '{print $1}')" || true
  for dep in $rpath_deps; do
    local dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done
}

# Fix all libraries
for lib in "$DEST/lib/"*.dylib; do
  echo "  Fixing $(basename "$lib")..."
  fix_lib "$lib"
done

echo "Fixing tesseract binary..."

# Fix the tesseract binary to use @executable_path/../lib/
TESS_DEPS="$(otool -L "$DEST/bin/tesseract" | grep "$BREW" | awk '{print $1}')" || true
for dep in $TESS_DEPS; do
  dep_name="$(basename "$dep")"
  install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$DEST/bin/tesseract"
done

# Run another dependency pass after install-name rewriting to catch dependencies
# that now appear as @loader_path names inside copied libraries.
copy_deps_recursive "$DEST/bin/tesseract" "$DEST/lib/"*.dylib
for lib in "$DEST/lib/"*.dylib; do
  echo "  Fixing $(basename "$lib")..."
  fix_lib "$lib"
done

echo "Verifying..."

# Verify tesseract binary
echo ""
echo "=== tesseract binary dependencies ==="
otool -L "$DEST/bin/tesseract"

# Verify one library
echo ""
echo "=== libtesseract.5.dylib dependencies ==="
otool -L "$DEST/lib/libtesseract.5.dylib"

# Ad-hoc codesign for local testing
echo ""
echo "=== Codesigning (ad-hoc) ==="
codesign --force --sign - "$DEST/bin/tesseract" "$DEST/lib/"*.dylib

# Test run
echo ""
echo "=== Testing binary ==="
"$DEST/bin/tesseract" --version

echo ""
echo "Done! Tesseract bundled to $DEST"
echo ""
echo "Files:"
ls -la "$DEST/bin/"
ls -la "$DEST/lib/"
