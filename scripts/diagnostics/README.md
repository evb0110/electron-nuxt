# PDF diagnostics

## Generated PDF visual compatibility

Generated PDFs must pass the exact artifact-preview replica as well as a
reference renderer. The verifier first exercises a synthetic JPX negative
control, captures renderer warnings, compares every requested page, and writes
a human-viewable contact sheet:

```bash
pnpm run diag:verify-generated-pdf -- \
  --pdf /absolute/path/to/output.pdf \
  --artifact-dir .devkit/analysis/pdf-visual-verification
```

The default limit is 20 pages. Use a representative smoke extract; pass
`--allow-large` only for an intentional resource-exhaustion test. A successful
run writes `verification-ledger.json`. A renderer incompatibility writes
`verification-failure.json` and exits non-zero.

The three PDF diagnostics are scenarios on `runPdfDiagnosticScenario.ts`, which owns
isolated Electron sessions, diagnostic trace buffers, timed sampling, optional frame
capture, artifact writes, and cleanup. Their package commands, acceptance thresholds,
and JSON schemas remain scenario-specific.

## Save-pipeline timing

The save timing diagnostic extends the existing hidden-session save-pipeline benchmark;
it does not maintain a separate harness. Run the benchmark entry point:

```bash
pnpm run benchmark:save-pipeline -- --fixture path/to/source.pdf --iterations 10 --output .devkit/analysis/save-pipeline.json
```

`--pdf` aliases `--fixture`, and `--out` aliases `--output`. Relative paths resolve
from the caller's working directory; the source must be a non-empty PDF. The benchmark builds the native page-operations tool and
Electron, then runs native FreeText and serialized-fallback saves at the configured low
and high tiers in isolated hidden sessions.

The top-level JSON retains the existing schema-version, generation time, fixture size,
warmup/iteration counts, clone mode, and scenario fields. It additionally records the
normalized `inputPath` and `outputPath`, a streaming fixture SHA-256, plus the synchronous
`hostProfile` snapshot and its effective `hostTier`. Each scenario retains its numeric `totalMs.samples`, p50/p95,
peak RSS, I/O and phase placeholders, byte counts, output SHA-256, and raw semantic-reopen
summary. Additive comparable semantic summaries ignore structural Popup companions and
prove that every output contains exactly one additional FreeText annotation. Each
scenario identifies the annotation action used for its route. Its additive
`iterationMeasurements` entries contain `iteration`, `timestamp`, `beforeBytes`,
`afterBytes`, `durationMs`, and peak RSS; the scenario also records the synchronous
profile effective for that hidden session and the source/working-output paths.

## Scan-cleanup release corpus

Copy `scan-cleanup-corpus-config.example.json` to the ignored
`.devkit/scan-cleanup-corpus.json` and replace each `pdfPath` with an absolute local
path. Build the staged release tools, then run:

```bash
pnpm run build:scan-cleanup
pnpm run build:pdf-image-combine
pnpm run diag:scan-cleanup-corpus-verify -- --keep-artifacts
```

Machine-local fixture entries may include `expectedModeDistribution` (counts by
final output page for `bw`, `grayscale`, `color`, and `mixed`) and
`expectedOutputBytes`. These local values override the checked-in expectation for
the same fixture ID, so private corpora can enforce regression expectations without
committing fixture paths or results.

The diagnostic detects each selected page's dominant source DPI with `pdfimages`,
rasterizes with `pdftoppm`, runs protocol-v3 auto analysis and final rendering,
combines the output with the release PDF combiner, and reports every mode, codec,
roundtrip, MediaBox, size, and timing assertion separately. Linguae fixtures are
optional: mark them with `"optional": true` and they are reported as skipped when
their absolute path is absent. The checked-in expectations cover the Luther p6–9
session fixture and Rome pages 1, 2, and 49.

## Standing scan-cleanup regression net

The standing loop is one non-Electron command. Create the ignored
`.devkit/scan-cleanup-regress.json` manifest with `corpora.acceptance2`,
`corpora.regress`, `corpora.canvas-trio`, and `corpora.headers2` config paths,
`cli.acceptance2` and `cli.linguae-layouts` source entries, and a `rome.source`
entry. Then run:

```bash
pnpm scan-cleanup:regress
```

It runs those four corpus configs, the 17-case
`rome-mode-matrix-corpus-config.json`, parity CLI conversions with stamped
word-loss audits, and Rome pages 46/49/52/56 rendered at 150 dpi. The private
manifest may provide an `environment` object for `${EVB_SCAN_CLEANUP_*}` tokens
used by the matrix config. `pnpm scan-cleanup:regress -- --full` adds the
release-only `corpora.fullbook` gate; fullbook is intentionally not a nightly
fixture. Evidence and the compact stdout table are written below the selected
work directory.

### Retired ad-hoc checks

The unreferenced `scan-cleanup-forced-mode-audit.py` replay was deleted. Its
forced BW/grayscale diagnostic role is replaced by the standing regress
corpora, the 17-case binarization/crop matrix, and the stamped CLI word-loss
audits. `scan-cleanup-artifact-audit.py` remains because the corpus harness,
release verifier, and unit tests reference it; `scan-cleanup-synthetic-audit.py`
remains because the packaged release verifier references it. No other
scan-cleanup diagnostic under this directory was clearly superseded, so no
other deletion was made.

Grayscale and color scan-cleanup outputs use plain `image-jpeg` records because
their raster is already at final DPI; unlike `photo-jpeg`, this does not apply
another PPI cap. Mixed pages use `layered-jpeg`: a quality-85 tonal background
for grayscale or quality 87 for RGB under a full-render-DPI 1-bit text mask.
Binary text masks render on a grid at twice source DPI with a 600-DPI minimum.
That finer grid retains grayscale edge coverage when it becomes a 1-bit contour;
the per-mode pixel and dimension limits still cap oversized pages.
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
