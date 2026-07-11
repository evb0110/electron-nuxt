#!/bin/bash
# Bundle Poppler and qpdf binaries for macOS
# Copies from Homebrew, recursively resolves dylib deps, fixes paths, codesigns
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="${EVB_PDF_TOOLS_RESOURCES_DIR:-$PROJECT_ROOT/resources}"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PLATFORM_ARCH="darwin-arm64" ;;
  x86_64) PLATFORM_ARCH="darwin-x64" ;;
  *)      echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
esac

POPPLER_DIR="$RESOURCES_DIR/poppler/$PLATFORM_ARCH"
QPDF_DIR="$RESOURCES_DIR/qpdf/$PLATFORM_ARCH"

echo "=========================================="
echo "Bundling PDF tools for $PLATFORM_ARCH"
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

# Ensure poppler and qpdf are installed via Homebrew
echo ""
echo "Ensuring poppler and qpdf are installed via Homebrew..."
brew install poppler qpdf

BREW_PREFIX="$(brew --prefix)"

required_tools=(pdftoppm pdftotext pdfinfo pdfimages qpdf)
for tool in "${required_tools[@]}"; do
    if [ ! -x "$BREW_PREFIX/bin/$tool" ]; then
        echo "Error: Missing required Homebrew tool: $BREW_PREFIX/bin/$tool"
        exit 1
    fi
done

shopt -s nullglob
find_soname_library() {
    local directory="$1"
    local expression="$2"
    find "$directory" -maxdepth 1 \( -type f -o -type l \) -print \
        | awk -F/ -v expression="$expression" '$NF ~ expression {print; exit}'
}

poppler_source_lib="$(find_soname_library "$BREW_PREFIX/opt/poppler/lib" '^libpoppler\.[0-9]+\.dylib$')"
qpdf_source_lib="$(find_soname_library "$BREW_PREFIX/opt/qpdf/lib" '^libqpdf\.[0-9]+\.dylib$')"
if [ -z "$poppler_source_lib" ]; then
    echo "Error: No Homebrew Poppler dylib found under $BREW_PREFIX/opt/poppler/lib"
    exit 1
fi
if [ -z "$qpdf_source_lib" ]; then
    echo "Error: No Homebrew qpdf dylib found under $BREW_PREFIX/opt/qpdf/lib"
    exit 1
fi

# ==========================================
# Shared helpers
# ==========================================

# Recursively copy all non-system dylib dependencies into dest/lib
copy_deps_recursive() {
    local dest_lib="$1"
    shift
    local files=("$@")

    local added=1
    while [ "$added" -gt 0 ]; do
        added=0
        for file in "${files[@]}"; do
            [ -f "$file" ] || continue
            local deps
            deps="$(otool -L "$file" | grep "$BREW_PREFIX" | awk '{print $1}')" || true
            for dep in $deps; do
                local dep_name
                dep_name="$(basename "$dep")"
                if [ ! -f "$dest_lib/$dep_name" ]; then
                    if [ -f "$dep" ]; then
                        # Copy resolved file contents even when the source is a symlink.
                        cp -L "$dep" "$dest_lib/$dep_name"
                        echo "    Copied: $dep_name"
                        files+=("$dest_lib/$dep_name")
                        added=1
                    else
                        echo "Error: Homebrew dependency does not exist: $dep (referenced by $file)"
                        exit 1
                    fi
                fi
            done
        done
    done
}

# Fix all Homebrew and @rpath references in a library to use @loader_path
fix_lib_paths() {
    local lib="$1"
    local lib_name
    lib_name="$(basename "$lib")"

    # Set the library's own ID
    install_name_tool -id "@loader_path/$lib_name" "$lib"

    # Fix Homebrew references
    local brew_deps
    brew_deps="$(otool -L "$lib" | grep "$BREW_PREFIX" | awk '{print $1}')" || true
    for dep in $brew_deps; do
        local dep_name
        dep_name="$(basename "$dep")"
        install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib"
    done

    # Fix @rpath references
    local rpath_deps
    rpath_deps="$(otool -L "$lib" | grep "@rpath" | awk '{print $1}')" || true
    for dep in $rpath_deps; do
        local dep_name
        dep_name="$(basename "$dep")"
        install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib"
    done
}

# Fix all Homebrew and @rpath references in a binary to use @executable_path/../lib
fix_bin_paths() {
    local bin="$1"

    local brew_deps
    brew_deps="$(otool -L "$bin" | grep "$BREW_PREFIX" | awk '{print $1}')" || true
    for dep in $brew_deps; do
        local dep_name
        dep_name="$(basename "$dep")"
        install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$bin"
    done

    local rpath_deps
    rpath_deps="$(otool -L "$bin" | grep "@rpath" | awk '{print $1}')" || true
    for dep in $rpath_deps; do
        local dep_name
        dep_name="$(basename "$dep")"
        install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$bin"
    done
}

# ==========================================
# Poppler
# ==========================================
echo ""
echo "=========================================="
echo "Bundling Poppler binaries..."
echo "=========================================="

# Clean previous build
rm -rf "$POPPLER_DIR"
mkdir -p "$POPPLER_DIR/bin" "$POPPLER_DIR/lib"

# Copy binaries
echo ""
echo "Copying binaries..."
for tool in pdftoppm pdftotext pdfinfo pdfimages; do
    cp "$BREW_PREFIX/bin/$tool" "$POPPLER_DIR/bin/"
    echo "  Copied $tool"
done

# Copy core poppler library
echo ""
echo "Copying libraries..."
for lib in "$poppler_source_lib"; do
    lib_name="$(basename "$lib")"
    if [ ! -f "$POPPLER_DIR/lib/$lib_name" ]; then
        cp "$lib" "$POPPLER_DIR/lib/"
        echo "    Copied: $lib_name"
    fi
done

# Recursively discover and copy all dependencies
echo ""
echo "Resolving transitive dependencies..."
all_files=("$POPPLER_DIR/bin"/* "$POPPLER_DIR/lib"/*.dylib)
copy_deps_recursive "$POPPLER_DIR/lib" "${all_files[@]}"

# Fix paths in all libraries
echo ""
echo "Fixing library paths..."
for lib in "$POPPLER_DIR/lib"/*.dylib; do
    [ -f "$lib" ] || continue
    fix_lib_paths "$lib"
    echo "  Fixed $(basename "$lib")"
done

# Fix paths in binaries
echo ""
echo "Fixing binary paths..."
for bin in "$POPPLER_DIR/bin"/*; do
    [ -f "$bin" ] || continue
    fix_bin_paths "$bin"
    echo "  Fixed $(basename "$bin")"
done

# Codesign
echo ""
echo "Codesigning (ad-hoc)..."
codesign --force --sign - "$POPPLER_DIR/bin"/* "$POPPLER_DIR/lib"/*.dylib
echo "  Done"

# ==========================================
# qpdf
# ==========================================
echo ""
echo "=========================================="
echo "Bundling qpdf..."
echo "=========================================="

# Clean previous build
rm -rf "$QPDF_DIR"
mkdir -p "$QPDF_DIR/bin" "$QPDF_DIR/lib"

# Copy qpdf binary
cp "$BREW_PREFIX/bin/qpdf" "$QPDF_DIR/bin/"
echo "  Copied qpdf"

# Copy core qpdf library
echo ""
echo "Copying libraries..."
for lib in "$qpdf_source_lib"; do
    lib_name="$(basename "$lib")"
    if [ ! -f "$QPDF_DIR/lib/$lib_name" ]; then
        cp "$lib" "$QPDF_DIR/lib/"
        echo "    Copied: $lib_name"
    fi
done

# Recursively discover and copy all dependencies
echo ""
echo "Resolving transitive dependencies..."
all_files=("$QPDF_DIR/bin"/* "$QPDF_DIR/lib"/*.dylib)
copy_deps_recursive "$QPDF_DIR/lib" "${all_files[@]}"

# Fix paths in all libraries
echo ""
echo "Fixing library paths..."
for lib in "$QPDF_DIR/lib"/*.dylib; do
    [ -f "$lib" ] || continue
    fix_lib_paths "$lib"
    echo "  Fixed $(basename "$lib")"
done

# Fix paths in binaries
echo ""
echo "Fixing binary paths..."
for bin in "$QPDF_DIR/bin"/*; do
    [ -f "$bin" ] || continue
    fix_bin_paths "$bin"
    echo "  Fixed $(basename "$bin")"
done

# Codesign
echo ""
echo "Codesigning (ad-hoc)..."
codesign --force --sign - "$QPDF_DIR/bin"/* "$QPDF_DIR/lib"/*.dylib
echo "  Done"

# ==========================================
# Verification
# ==========================================
echo ""
echo "=========================================="
echo "Verifying bundles..."
echo "=========================================="

echo ""
echo "Poppler binaries:"
for tool in pdftoppm pdftotext pdfinfo pdfimages; do
    if [ -f "$POPPLER_DIR/bin/$tool" ]; then
        echo "  OK  $tool ($(du -h "$POPPLER_DIR/bin/$tool" | awk '{print $1}'))"
    else
        echo "  MISSING  $tool"
    fi
done

echo ""
echo "qpdf:"
if [ -f "$QPDF_DIR/bin/qpdf" ]; then
    echo "  OK  qpdf ($(du -h "$QPDF_DIR/bin/qpdf" | awk '{print $1}'))"
else
    echo "  MISSING  qpdf"
fi

# Check for leftover Homebrew references
echo ""
echo "Checking for unresolved Homebrew references..."
FOUND_ISSUES=0
for file in "$POPPLER_DIR/bin"/* "$POPPLER_DIR/lib"/*.dylib "$QPDF_DIR/bin"/* "$QPDF_DIR/lib"/*.dylib; do
    [ -f "$file" ] || continue
    refs="$(otool -L "$file" | grep "$BREW_PREFIX" || true)"
    if [ -n "$refs" ]; then
        echo "  Error: $(basename "$file") still has Homebrew refs:"
        echo "$refs" | sed 's/^/    /'
        FOUND_ISSUES=1
    fi
done
if [ "$FOUND_ISSUES" -eq 0 ]; then
    echo "  All references resolved"
else
    echo "Error: Unresolved Homebrew references remain in the macOS PDF tool bundle"
    exit 1
fi

echo ""
echo "=========================================="
echo "Bundle complete!"
echo "=========================================="
echo ""
echo "Poppler: $POPPLER_DIR"
echo "qpdf:    $QPDF_DIR"
echo ""
echo "Total size:"
du -sh "$POPPLER_DIR" "$QPDF_DIR" 2>/dev/null || true
