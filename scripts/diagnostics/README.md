# PDF diagnostics

The three PDF diagnostics are scenarios on `runPdfDiagnosticScenario.ts`, which owns
isolated Electron sessions, diagnostic trace buffers, timed sampling, optional frame
capture, artifact writes, and cleanup. Their package commands, acceptance thresholds,
and JSON schemas remain scenario-specific.

## Scan-cleanup release corpus

Copy `scan-cleanup-corpus-config.example.json` to the ignored
`.devkit/scan-cleanup-corpus.json` and replace each `pdfPath` with an absolute local
path. Build the staged release tools, then run:

```bash
pnpm run build:scan-cleanup
pnpm run build:pdf-image-combine
pnpm run diag:scan-cleanup-corpus-verify -- --keep-artifacts
```

The diagnostic detects each selected page's dominant source DPI with `pdfimages`,
rasterizes with `pdftoppm`, runs protocol-v3 auto analysis and final rendering,
combines the output with the release PDF combiner, and reports every mode, codec,
roundtrip, MediaBox, size, and timing assertion separately. Linguae fixtures are
optional: mark them with `"optional": true` and they are reported as skipped when
their absolute path is absent. The checked-in expectations cover the Luther p6–9
session fixture and Rome pages 1, 2, and 49.

Grayscale and color scan-cleanup outputs use plain `image-jpeg` records because
their raster is already at final DPI; unlike `photo-jpeg`, this does not apply
another PPI cap. Mixed pages use `layered-jpeg`: a quality-85 tonal background
for grayscale or quality 87 for RGB under a full-render-DPI 1-bit text mask.
The background is capped at source DPI
(`min(source DPI, render DPI)`), so supersampling sharpens the JBIG2 text layer
without spending JPEG bytes on invented picture detail. Final-stencil pixels use
paper fill in the tonal layer; pixels excluded from the stencil by picture-mask
dilation retain source tone so content cannot disappear from both layers. The
existing 3 mm distance feather still blends picture-mask boundaries without
preserving dark text ghosts. The combiner keeps the lossless Flate candidate
whenever it is smaller.

The July 2026 MRC follow-up changed the `rome-selected` three-page corpus
expectation from 3,247,404 B to 2,135,347 B. Luther p6–9 remains byte-identical
at 727,236 B; the Rome reduction comes from page 49 moving from a flattened
mixed JPEG to a JPEG background plus JBIG2 text stencil.

The supersampling/content-coverage fix then changed `rome-selected` from
2,135,347 B to 2,795,244 B. Luther p6–9 remains byte-identical at 727,236 B.
Rome page 49 now carries a 720-DPI stencil over its unchanged 360-DPI background;
the standalone page changed from 287,787 B to 941,353 B because the full-resolution
stencil and non-stencil source tones are retained.

## Navigation blink trace

Use the blink trace for blank frames, delayed skeletons, or canvas/skeleton flicker:

```bash
pnpm run diag:pdf-navigation-blink-trace -- --pdf /path/to/source.pdf --out .devkit/pdf-navigation-blink-trace.json
```

The PDF defaults to `EVB_DIAGNOSTIC_PDF_PATH`, then
`.devkit/manual-pdf-fixtures/page-jump-source.pdf`. Add `--video` or
`--video-dir <dir>` for timestamped JPEG frames, `trace.mp4`, and
`contact-sheet.jpg`. Capture uses CDP screencasting and falls back to Puppeteer
screenshots; ffmpeg artifacts are optional. The JSON preserves `video.artifactPaths`
and `summary.frameAnalysis`; `skeletonAfterCanvasObserved` identifies a skeleton seen
after canvas ownership.

## Skeleton navigation scenarios

Run the high-zoom next-page, toolbar direct-jump, and rapid next-to-last scenarios:

```bash
EVB_E2E_NAVIGATION_PDF_PATH=/path/to/navigation-source.pdf pnpm run diag:pdf-skeleton-navigation
```

The path falls back through `EVB_DIAGNOSTIC_PDF_PATH` to
`.devkit/manual-pdf-fixtures/navigation-source.pdf`. Outputs remain:

- `.devkit/girgas-page-navigation-skeleton-diagnostics.json`
- `.devkit/girgas-page-500-input-skeleton-diagnostics.json`
- `.devkit/girgas-rapid-next-to-last-skeleton-diagnostics.json`

## Arnold PDF open

Run the open, settle, scroll, and high-zoom acceptance scenario with:

```bash
EVB_E2E_ARNOLD_PDF_PATH=/path/to/arnold-grammar.pdf pnpm run diag:arnold-pdf-open
```

The default fixture is `.devkit/manual-pdf-fixtures/arnold-grammar.pdf`. Artifacts
remain `.devkit/arnold-pdf-open-diagnostics.json` and
`.devkit/arnold-pdf-open-console.log`.
