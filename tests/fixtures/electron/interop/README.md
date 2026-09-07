# Annotation interoperability corpus

This directory contains the bounded corpus preparation for issue #167. The
manifest is the contract consumed by the ready-entry discovery in issue #177.
Every ready PDF is one page, deterministic, smaller than 2 MiB, qpdf-clean on
the generation host, and carries fixed neutral metadata.

Regenerate and validate the corpus with:

```sh
node scripts/generate-interop-corpus.mjs
node scripts/generate-interop-corpus.mjs --check
node scripts/verify-interop-corpus.mjs
node scripts/verify-interop-rendering.mjs --artifact-dir .devkit/artifacts/issue-167-interop
```

`synthetic-annotation-interoperability.pdf` is deliberately synthetic. The
generator uses pdf-lib 1.17.1 to create the low-level dictionaries and
appearance streams. It covers the five canonical kinds, a native `/Text`
note, a legacy `/FreeText` plus `/Popup` marker, a reply chain, review state,
rich text, unknown `EVBVendorKey` values, appearance streams, and an
unnamed foreign link. It is not described as a pdf.js-authored file.

`stock-pdfjs-save-of-synthetic.pdf` starts from the synthetic file and passes
it through the stock Mozilla PDF.js package exposed by
`pdfjs-dist-codex-preview` version 5.4.296. The generator also submits one
new FreeText annotation through `annotationStorage` before calling
`PDFDocumentProxy.saveDocument()`. That extra annotation is authored by the
stock editor/writer path. The other dictionaries came from the synthetic
input, so this fixture does not claim that stock pdf.js authored every
annotation kind.

The manifest records the exact byte count, SHA-256, page count, subtype,
markup-subtype and shape-subtype coverage, canonical-kind inventory, preserved
keys, scenario count, qpdf warning baseline, and provenance. Do not replace
either PDF with a hand-authored file and retain the stock provenance label. If a future preparation needs a corpus
whose five annotation kinds were all authored by stock pdf.js, it needs a
separate acquisition step and a new provenance record.

`verify-interop-rendering.mjs` runs Poppler's `pdftoppm` independently of EVB's
pdf.js renderer. It checks qpdf, page raster dimensions, and non-white crops
for the positioned canonical annotations. Its result records the Poppler,
qpdf, pdfinfo and ImageMagick versions plus the exact page-1, 144-DPI render
options. The intentionally blank legacy note marker is checked structurally
and is not treated as a Poppler paint failure.
