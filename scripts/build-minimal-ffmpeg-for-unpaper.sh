#!/bin/bash
# Build the small FFmpeg surface unpaper requires for PNM OCR preprocessing.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <work-directory> <install-prefix>" >&2
  exit 2
fi

resolve_path() {
  node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$1"
}

WORK_DIR="$(resolve_path "$1")"
INSTALL_PREFIX="$(resolve_path "$2")"
PROJECT_ROOT="$(resolve_path "$(dirname "$0")/..")"

for target in "$WORK_DIR" "$INSTALL_PREFIX"; do
  target_parent="$(dirname "$target")"
  if [ -z "$target" ] || [ "$target" = "/" ] || [ "$target_parent" = "/" ] || [ "$target" = "$PROJECT_ROOT" ] || [ "$target" = "${HOME:-/__unset_home__}" ]; then
    echo "Error: refusing unsafe FFmpeg build cleanup target: ${target:-<empty>}" >&2
    exit 2
  fi
  case "$PROJECT_ROOT/" in
    "$target/"*)
      echo "Error: refusing FFmpeg cleanup target that contains the project: $target" >&2
      exit 2
      ;;
  esac
done
if [ "$WORK_DIR" = "$INSTALL_PREFIX" ]; then
  echo "Error: FFmpeg work directory and install prefix must be different" >&2
  exit 2
fi
case "$WORK_DIR/" in
  "$INSTALL_PREFIX/"*)
    echo "Error: install prefix must not contain the FFmpeg work directory" >&2
    exit 2
    ;;
esac

FFMPEG_TAG="n7.1.1"
FFMPEG_COMMIT="db69d06eeeab4f46da15030a80d539efb4503ca8"
SOURCE_DIR="$WORK_DIR/ffmpeg"

rm -rf -- "$SOURCE_DIR" "$INSTALL_PREFIX"
git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git "$SOURCE_DIR"
if [ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" != "$FFMPEG_COMMIT" ]; then
  echo "Error: FFmpeg tag $FFMPEG_TAG did not resolve to pinned commit $FFMPEG_COMMIT" >&2
  exit 1
fi

cd "$SOURCE_DIR"
./configure \
  --prefix="$INSTALL_PREFIX" \
  --enable-shared \
  --disable-static \
  --disable-programs \
  --disable-doc \
  --disable-debug \
  --disable-network \
  --disable-autodetect \
  --disable-everything \
  --disable-avdevice \
  --disable-avfilter \
  --disable-swresample \
  --disable-swscale \
  --enable-avcodec \
  --enable-avformat \
  --enable-avutil \
  --enable-decoder=pam,pbm,pgm,pgmyuv,ppm \
  --enable-encoder=pam,pbm,pgm,pgmyuv,ppm \
  --enable-demuxer=image2,image2pipe \
  --enable-muxer=image2,image2pipe \
  --enable-protocol=file,pipe \
  --disable-x86asm

if command -v sysctl >/dev/null 2>&1; then
  JOBS="$(sysctl -n hw.ncpu 2>/dev/null || true)"
fi
if [ -z "${JOBS:-}" ] && command -v nproc >/dev/null 2>&1; then
  JOBS="$(nproc)"
fi
make -j"${JOBS:-2}"
make install

find "$INSTALL_PREFIX/lib" -maxdepth 1 -type f \
  \( -name 'libavcodec.*' -o -name 'libavformat.*' -o -name 'libavutil.*' \) -print
