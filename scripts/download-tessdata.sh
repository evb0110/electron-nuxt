#!/bin/bash
# Download Tesseract language data files from tessdata_best
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TESSDATA_DIR="$PROJECT_ROOT/resources/tesseract/tessdata"
TESSDATA_BEST_REF="e12c65a915945e4c28e237a9b52bc4a8f39a0cec"
TESSDATA_BASE_URL="https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/${TESSDATA_BEST_REF}"

mkdir -p "$TESSDATA_DIR"

LANGS="$(
  PROJECT_ROOT="$PROJECT_ROOT" \
  node - <<'NODE'
const fs = require('fs');
const path = require('path');
const registryPath = path.join(process.env.PROJECT_ROOT, 'packages/contracts/ocrLanguages.ts');
const source = fs.readFileSync(registryPath, 'utf8');
const quote = String.fromCharCode(39);
const languageCodePattern = new RegExp(`code:\\s*${quote}([^${quote}]+)${quote}`, 'g');
const codes = [...source.matchAll(languageCodePattern)].map(match => match[1]);
if (codes.length === 0) {
  throw new Error(`No OCR language codes found in ${registryPath}`);
}
process.stdout.write(codes.join(' '));
NODE
)"

echo "Downloading tessdata_best language files to $TESSDATA_DIR..."
echo "Pinned tessdata_best ref: $TESSDATA_BEST_REF"

for lang in $LANGS; do
  FILE="$TESSDATA_DIR/${lang}.traineddata"
  if [ -f "$FILE" ]; then
    echo "  $lang: already exists ($(du -h "$FILE" | cut -f1))"
  else
    echo "  $lang: downloading..."
    TMP_FILE="$(mktemp "$TESSDATA_DIR/${lang}.traineddata.XXXXXX")"
    cleanup_download_tmp() {
      rm -f "$TMP_FILE"
    }
    if ! curl --fail --location --show-error --silent --retry 3 --retry-delay 2 --output "$TMP_FILE" \
      "$TESSDATA_BASE_URL/${lang}.traineddata"; then
      cleanup_download_tmp
      exit 1
    fi
    if [ ! -s "$TMP_FILE" ]; then
      echo "Error: downloaded tessdata for $lang is empty"
      cleanup_download_tmp
      exit 1
    fi
    bytes="$(wc -c < "$TMP_FILE" | tr -d '[:space:]')"
    if [ "$bytes" -lt 1024 ]; then
      echo "Error: downloaded tessdata for $lang is unexpectedly small ($bytes bytes)"
      cleanup_download_tmp
      exit 1
    fi
    mv "$TMP_FILE" "$FILE"
    echo "  $lang: done ($(du -h "$FILE" | cut -f1))"
  fi
done

echo ""
echo "Done! Language files:"
ls -lh "$TESSDATA_DIR/"
echo ""
echo "Total size: $(du -sh "$TESSDATA_DIR" | cut -f1)"
