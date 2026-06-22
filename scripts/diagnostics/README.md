# Diagnostics

## PDF Navigation Blink Trace

Use `pdfNavigationBlinkTrace.ts` when PDF page navigation shows blank frames, delayed skeletons, or canvas/skeleton flicker.

```bash
pnpm exec tsx scripts/diagnostics/pdfNavigationBlinkTrace.ts --pdf /path/to/source.pdf --out .devkit/pdf-navigation-blink-trace.json
```

Add `--video` when a visual blink needs frame-by-frame review:

```bash
pnpm exec tsx scripts/diagnostics/pdfNavigationBlinkTrace.ts --video --out .devkit/pdf-navigation-blink-trace.json
```

If `--pdf` is omitted, the script reads `EVB_DIAGNOSTIC_PDF_PATH` and otherwise falls back to `.devkit/manual-pdf-fixtures/page-jump-source.pdf`.

Use `--video-dir <dir>` to control where visual artifacts go. The recorder writes timestamped JPEG frames under `<dir>/frames`, then creates `trace.mp4` and `contact-sheet.jpg` when `ffmpeg` is available. Capture uses CDP `Page.startScreencast` so macOS screen-recording permission is not required; if CDP screencast startup fails, it falls back to timestamped Puppeteer screenshots.

The JSON output includes `video.artifactPaths` and `summary.frameAnalysis`. `summary.frameAnalysis.skeletonAfterCanvasObserved` is the quick flag to check when debugging whether skeleton UI appeared again after a canvas had already been observed during the trace window.

## PDF Skeleton Navigation Diagnostics

Use `runPdfSkeletonNavigationDiagnostics.ts` for the Girgas/manual navigation PDF scenarios that write the legacy skeleton diagnostics reports:

```bash
EVB_E2E_NAVIGATION_PDF_PATH=/path/to/navigation-source.pdf pnpm run diag:pdf-skeleton-navigation
```

If `EVB_E2E_NAVIGATION_PDF_PATH` is omitted, the script reads `EVB_DIAGNOSTIC_PDF_PATH` and otherwise falls back to `.devkit/manual-pdf-fixtures/navigation-source.pdf`.

Artifacts are written to:

- `.devkit/girgas-page-navigation-skeleton-diagnostics.json`
- `.devkit/girgas-page-500-input-skeleton-diagnostics.json`
- `.devkit/girgas-rapid-next-to-last-skeleton-diagnostics.json`

## Arnold PDF Open Diagnostics

Use `runArnoldPdfOpenDiagnostics.ts` for the personal Arnold lexicon PDF open/settle trace:

```bash
EVB_E2E_ARNOLD_PDF_PATH=/path/to/arnold-grammar.pdf pnpm run diag:arnold-pdf-open
```

If `EVB_E2E_ARNOLD_PDF_PATH` is omitted, the script falls back to `.devkit/manual-pdf-fixtures/arnold-grammar.pdf`.

Artifacts are written to `.devkit/arnold-pdf-open-diagnostics.json` and `.devkit/arnold-pdf-open-console.log`.
