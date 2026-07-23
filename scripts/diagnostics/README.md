# PDF diagnostics

The three PDF diagnostics are scenarios on `pdfDiagnosticsEngine.ts`, which owns
isolated Electron sessions, diagnostic trace buffers, timed sampling, optional frame
capture, artifact writes, and cleanup. Their package commands, acceptance thresholds,
and JSON schemas remain scenario-specific.

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
