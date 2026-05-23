#!/bin/bash
# Download Tesseract language data files from tessdata_best
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TESSDATA_DIR="$PROJECT_ROOT/resources/tesseract/tessdata"

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

for lang in $LANGS; do
  FILE="$TESSDATA_DIR/${lang}.traineddata"
  if [ -f "$FILE" ]; then
    echo "  $lang: already exists ($(du -h "$FILE" | cut -f1))"
  else
    echo "  $lang: downloading..."
    curl -sL -o "$FILE" \
      "https://github.com/tesseract-ocr/tessdata_best/raw/main/${lang}.traineddata"
    echo "  $lang: done ($(du -h "$FILE" | cut -f1))"
  fi
done

echo ""
echo "Done! Language files:"
ls -lh "$TESSDATA_DIR/"
echo ""
echo "Total size: $(du -sh "$TESSDATA_DIR" | cut -f1)"
