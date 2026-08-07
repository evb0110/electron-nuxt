# Scan-cleanup live-run improvement ledger (2026-08-07)

Status: implemented and verified locally; final independent review and remote publication are recorded below. This ledger is based on a live 392-page development-app run and an independent read-only Claude Opus 5 design review. It supersedes guesses made from the screenshot alone and does not reopen completed stage-28 audit findings.

## Goal

Make a long cleanup run materially faster and smaller, make progress truthful and geometrically stable, make matched-canvas margins mean what the UI promises, and prevent stale preview/settings state from misleading the user.

The reference input is:

- `/Users/evb/Desktop/pdf/History of Ancient Rome_2005 raw.pdf`
- 392 pages, 38,272,924 bytes
- already-compact 360-DPI MRC: 392 full-page 1-bit JBIG2 selection masks plus continuous-tone JPX layers

The reference output is:

- `History of Ancient Rome_2005 raw — cleaned.pdf`
- 59,312,694 bytes, 1.550x the source
- 331 `bw`, 57 `mixed`, 2 `grayscale`, 2 `color`
- 331 generic-region JBIG2 images and 57 JBIG2 stencils stored at 720 DPI

Evidence is preserved under `.devkit/tmp/scan-cleanup-ledger-evidence/`; the source/output `pdfimages -list` reports are the byte-accounting ground truth for this run.

## Findings, corrected against the code

### F1 — Size and most of the runtime have the same cause

`SCAN_CLEANUP_BINARY_LAYER_RENDER_SCALE = 2` currently keys off whether the *output* carries a binary layer. It therefore sends an already-bilevel 360-DPI source through a 720-DPI RGB work grid and embeds the resulting B/W masks at 720 DPI.

That is useful for a continuous-tone source being thresholded for the first time: its gray edge coverage can place a better binary transition on the finer grid. It creates no new edge information when the dominant source layer is already a 1-bit mask. Poppler only expands those samples.

Consequences in the reference run:

- about 84 MiB of temporary PPM data per page and about 32 GiB over the run;
- native `render=554.5s`, `normalization=104.6s`, `write=25.6s`;
- about 42.1 MiB of 720-DPI B/W JBIG2 images plus 6.3 MiB of 720-DPI stencils;
- total native wall 831.5s and total conversion wall 969.5s.

This is not an encoder fallback. The assembler already verifies and chooses among JBIG2, CCITT G4, and Flate. The current 2.5x compact-source byte guard deliberately permits the 1.55x result; lowering the guard would turn the symptom into a late failure.

### F2 — The streaming pipeline is presented as two sequential phases

On POSIX, Poppler writes a FIFO while native consumes it. Rasterization and native rendering are one fused throughput stage, but TypeScript reports them as separate bands and suppresses native `page-complete` reports until rasterization is declared finished. The meter therefore sits near 26% and then jumps near 84%.

Native also uses a zero-capacity turnstile with an acknowledgement after page processing. That makes the single dedicated reader wait for page N to finish before it even opens page N+1. The TypeScript side launches and budgets three producers, but two mostly block. The reference native wall exceeds the sum of native page timings by about 121s.

### F3 — Toolbar progress width is content-derived

The toolbar centre grid track is `auto`; the meter asks for `min(100%, token-width)` inside that content-derived track. Phase labels, count visibility, and changing digit widths therefore change the meter width. The count and percent slots are conditionally removed rather than reserved.

### F4 — Five millimetres is not five millimetres on a matched canvas

Margins are expanded around the detected content first, then the padded result is fitted back into the fixed document canvas. The requested 5mm is therefore multiplied by the page's fit scale. In the reference run it becomes roughly 4.4–5.0mm depending on the page.

For `matchPageSize`, margin is a property of the final physical canvas: inset that canvas by the requested millimetres and fit content into the remaining inner rectangle. For unmatched pages, expanding the crop outward remains correct.

The preview pixels do contain a pale band, but the existing orange overlay marks the page edge rather than the margin boundary, so white padding on a white viewer is nearly invisible.

### F5 — A final run can display a stale cleaned preview

Starting the final run calls `previewResult.cancel(false)`. Cancellation clears loading and supersedes requests but retains the last result. If a margin edit's debounced preview has not completed, the old raster can remain visible for the entire run without a loading/stale notice.

### F6 — One malformed legacy settings entry aborts all migration

Legacy settings migration decodes each document inside one uncaught loop. One malformed override rejects `get()`, losing otherwise-valid global settings and other documents. New writes must remain strict; legacy import should salvage valid entries and emit one aggregate warning.

### F7 — MRC extraction is serial, but its remaining value must be measured

The 105.4s MRC extraction stage processes independent chunks serially. The previously reported qpdf-object-table reparse is already fixed by a once-promise and must not be redone. Extracted masks currently protect source ink during rendering; the old source-MRC output representation is otherwise unreachable. First retain the protection and parallelize chunks through the shared bounded mapper. Deleting extraction for bilevel sources requires a controlled corpus comparison and is not assumed safe.

## Decisions and rejected shortcuts

1. Suppress supersampling only when the source has a **dominant full-page bilevel layer**, not merely any incidental 1-bit decoration. Keep the global 2x/600-DPI policy for genuine continuous-tone-to-binary conversion.
2. Keep matched-canvas DPI a document-level source fact, independent of selected run scope, so a one-page rerun and a full run cannot move the canvas.
3. Report one fused `rendering` band on FIFO transports, driven from native page completion. Preserve a separate `rasterizing` band only on non-streaming transports.
4. Use fixed progress weights. Runtime-adaptive weights introduce a second owner of displayed percent and can rewind it.
5. Do not add a user-facing DPI control. Source detection, the document canvas, and the per-page plan remain the authorities.
6. Do not lower the compact-source byte cap as a substitute for smaller output.
7. Do not globally lower the 2x rule, switch blindly to CCITT, or add lossy/symbolic JBIG2 without a separate quality and compatibility campaign.
8. Do not parallelize native page processing for FIFO inputs. The prior Rayon/FIFO deadlock guard remains. Only add bounded reader look-ahead on the dedicated reader thread.
9. Do not claim that all color-to-B/W documents must be smaller than every source PDF. The correct product expectation is representation-aware: discarding continuous-tone layers generally shrinks ordinary scans, while an already compressed bilevel source should not be inflated by redundant sampling.

## Staged implementation

Each stage is independently committable on `main`. Reconcile with `origin/main` before each native/diagnostic conflict boundary. Every stage runs its affected tests; final verification runs lint, typecheck, the unit projects, native format/clippy/tests, and a real reference conversion.

### S1 — Source-representation-aware render DPI

Files:

- `scan-cleanup-core/sourceDpiDetection.ts`
- `scan-cleanup-core/types.ts`
- `scan-cleanup-core/policy/effectiveOptions.ts`
- final and preview call sites
- effective-options, DPI-detection, document-canvas, and pipeline unit tests

Implementation:

- derive `hasDominantBilevelLayer` only when a 1-bit image/mask covers at least 95% of the dominant page raster area;
- rename the ambiguous `carriesBinaryLayer` policy input to `outputCarriesBinaryLayer`;
- return source DPI when the output is binary and the source already has a dominant bilevel layer;
- otherwise retain `max(sourceDpi * 2, 600)` and existing allocation guardrails;
- feed the same source fact to preview, final per-page plans, and document-canvas planning.

Acceptance:

- policy pins: `(360, binary output, dominant bilevel source) -> 360`; `(360, binary output, continuous source) -> 720`; `(200, binary output, continuous source) -> 600`; `(200, binary output, dominant bilevel source) -> 200`;
- incidental small 1-bit decorations do not suppress supersampling;
- partial and full runs plan the same canvas DPI;
- reference output is targeted at `<= 0.85x` source and native wall `<= 260s`; these are measured acceptance targets, not hard-coded production limits;
- corpus/paired-image audits show no new word loss or stroke fragmentation.

### S2 — Truthful progress and stable toolbar geometry

Files:

- `scan-cleanup-core/createScanCleanupProgressReporter.ts`
- `scan-cleanup-core/runScanCleanupConversion.ts`
- scan-cleanup progress contract and formatter
- `ScanCleanupToolbar.vue`, reusing `ScanCleanupStableWidthText.vue`
- core/electron/app tests and the existing layout-stability quarantine proof

Implementation:

- use weights `normalizing 1, probing 3, extracting 6, rendering 78, collecting 1, assembling 9, handoff 2`;
- on streaming transport, emit rendering progress from the first native page completion and never emit a fake sequential rasterizing band;
- keep percentage monotonic across any quality-path profile change;
- compute an optional ETA in the reporter from an exponentially weighted per-unit duration; withhold it until at least 5 units and 10 seconds in the current stage;
- give the centre toolbar track the fixed width token, make the meter fill it, and reserve stable count/percent slots using the existing stable-width component;
- map native manifest indices explicitly rather than relying on scope-array coincidence.

Acceptance:

- streaming tests report no `rasterizing` stage and report `rendering` before producers finish;
- percent never rewinds; ETA is absent while under-sampled and bounded on a synthetic fixed-rate run;
- the progress element has identical width for probing, `313/392`, and handoff states;
- reference progress advances throughout the fused pipeline with no late 26% -> 84% jump.

### S3 — Exact matched-canvas margins and honest preview state

Files:

- native content/placement code, with minimal coordinated `render.rs` hunks
- document-canvas and preview planning
- `CleanedCanvas.vue` / preview presentation styles
- native, core, app, and matched-canvas tests

Implementation:

- when page size is matched, inset the final canvas by requested physical margins, fit content into the inner rectangle, and keep the outer document rectangle unchanged;
- leave outward crop expansion unchanged for unmatched pages;
- serialize metadata that describes the delivered margin, and warn through the existing warning channel when requested margins cannot apply because cropping/content detection is unavailable;
- draw a margin-boundary ring from applied-margin metadata while the margin control is focused or being edited; do not tint the document permanently;
- bind displayed preview results to the settings/request key that produced them; clear a result when cancellation leaves it mismatched instead of showing a stale raster as current.

Acceptance:

- 5mm requested on differently sized/cropped pages delivers `5.0 +/- 0.1mm` on every matched output while the PDF page rectangle remains unchanged;
- unmatched behavior retains current outward-rounded sample preservation;
- preview and final use identical geometry;
- changing margins then immediately starting a final run cannot leave `loading=false` with the previous settings' cleaned result.

### S4 — Bounded FIFO look-ahead

Files:

- `native/scan-cleanup/src/adapters/batch_cli.rs`
- manifest V3 and the TypeScript manifest builder/handoff policy
- native integration tests

Implementation:

- carry the already-owned raster concurrency/window into the manifest, defaulting conservatively for direct CLI callers;
- let the dedicated reader materialize at most that bounded window while processing stays one page at a time;
- release permits on page completion and preserve cancellation/failure cleanup;
- retain the existing FIFO deadline regression and the one-worker native deadlock guard.

Acceptance:

- a slow-task test proves bounded high-water, cancellation cleanup, and no failure hang;
- the reference run's native wall falls by at least 80s against the S1 measurement and `sum(page timings) / native wall > 0.93`;
- scratch high-water stays inside the handoff policy's declared budget.

### S5 — Bounded concurrent MRC extraction

Files:

- `scan-cleanup-adapters/extractPdfMrcLayers.ts`
- electron pipeline tests

Implementation:

- map independent extraction chunks through the existing bounded raster-page mapper at `policy.rasterConcurrency`;
- retain exactly one qpdf object-table inspection through the existing once-promise;
- aggregate completion counts so progress remains monotonic.

Acceptance:

- concurrency never exceeds policy;
- qpdf JSON inspection occurs once;
- extraction progress is monotonic and the reuse count is unchanged;
- reference extraction wall is targeted at `<= 40s`.

### S6 — Resilient legacy migration

Files:

- `electron/features/scan-cleanup/createScanCleanupSettingsStore.ts`
- settings-store tests

Implementation:

- isolate malformed legacy document entries, malformed legacy globals, and an invalid/oversized legacy envelope;
- salvage valid pieces and emit one aggregated warning with counts and the first cause;
- keep current-file decoding and every new update/write strict.

Acceptance:

- one malformed legacy document does not discard valid siblings or global settings;
- malformed global settings do not discard valid document entries;
- oversized/unparseable legacy input is skipped without damaging the current store;
- malformed new updates still reject.

### S7 — Verification, independent review, reconciliation, and publication

Verification:

- affected Vitest projects and focused regression files after every stage;
- `pnpm lint && pnpm typecheck`;
- `cargo fmt --check`, `cargo clippy --release`, and `cargo test --release` in each touched native crate;
- real reference-book conversion with preserved representation/provenance evidence;
- acceptance2/campaign corpus verification and generated-PDF compatibility/visual verification;
- do not recalibrate image-quality audits to hide a product regression.

Review and delivery:

- ask a fresh read-only Claude Opus 5 session to review the complete diff, tests, evidence, lifecycle ownership, and failure cleanup;
- apply only findings supported by current code/evidence and record disagreements;
- commit review fixes separately;
- fetch and reconcile with `origin/main`, rerun conflict-affected checks, and push `main`.

## Explicit deferrals

- Magnification-aware DPI above source DPI: revisit only if S1 visual evidence shows degradation on pages truly enlarged by the matched canvas.
- Resumable long runs: revisit after the measured S1/S4/S5 runtime; its value changes sharply if the full book falls below roughly four minutes.
- Deleting the unreachable source-MRC output path: handle with the extraction decision after corpus evidence, not inside this performance fix.
- Lossy/symbol-dictionary JBIG2: separate product-quality and licensing/compatibility decision.
- Permanently tinting margin bands: rejected because it obstructs document-quality judgment.

## Implemented outcome

### Stage commits

| Stage | Commit(s) | Outcome |
| --- | --- | --- |
| Ledger and independent design review | `756be00f8` | Reconstructed the live run from logs and PDF structure, then recorded decisions before implementation. |
| S1 source-aware render DPI | `7e2d17290` | Dominant full-page bilevel sources retain their source grid; continuous sources still receive the 2x/600-DPI thresholding policy. |
| S2 progress and toolbar | `49ea68584` | Streaming conversion is one weighted `rendering` stage with ETA; the toolbar track and numeric slots have stable geometry. |
| S3 matched margins and preview truth | `c8c8c5725`, `1469e3cd3` | Final-canvas insets preserve physical margins, preview uses the same geometry, and stale results are not presented as current. |
| S4 bounded FIFO look-ahead | `01a713213`, `34adf4099`, `b8a6a23e8`, `8d3d8a844` | Reader materialization overlaps native work within the declared raster window, with cancellation/deadline stress coverage. |
| S5 bounded MRC extraction | `a01216014`, `b3ffe76a9` | Independent chunks extract concurrently while qpdf inspection remains once-only and progress stays monotonic. |
| S6 migration salvage | `4c6bd1182` | Valid legacy settings survive malformed siblings; current writes remain strict. |
| Cleanup and verification support | `5c6d578bc`, `647cbbbb1`, `7e61cfc25`, `b1d27d049` | Removed obsolete shims, kept corpus DPI planning aligned, made restricted JPX verification fail-closed but correctly classified, and made word-loss checks consume canonical render geometry. |

### Reference-book result

The final 392-page parity conversion is at
`.devkit/tmp/scan-cleanup-ledger-evidence/reference-full-after/History of Ancient Rome_2005 raw — cleaned.pdf`.
Its adjacent machine summary is the authority for these figures:

- output: 34,274,282 bytes versus 38,272,924-byte source, ratio `0.895523`;
- size change: 10.5% smaller, reversing the previous 59,312,694-byte / `1.550x` inflation;
- total wall: 530.2s versus 969.5s, 45.3% faster;
- detection: 175.3s; conversion after detection: 354.9s;
- modes unchanged at 331 `bw`, 57 `mixed`, 2 `grayscale`, and 2 `color`;
- all 392 outputs use the 360-DPI source grid; the policy still supersamples continuous sources that are thresholded for the first time.

The aspirational `<= 0.85x` size target and `<= 260s` conversion target were not met. They were measurement goals, not product limits, and no quality or compatibility rule was weakened to force them. The remaining bytes belong chiefly to the 57 mixed and four continuous-tone pages; deleting their retained tone would be a different product-quality decision. The implemented result satisfies the user's representation-aware expectation for this already highly compressed MRC source: the predominantly B/W conversion is smaller despite retaining necessary mixed/color content.

### Progress and margin result

- Streaming logs now advance through `rendering:0/392 ... rendering:392/392`; they no longer present rasterization and native cleanup as sequential work.
- Reporter tests pin monotonic weighted progress and the ETA warm-up rule.
- Toolbar tests pin a fixed central track with reserved count and percent widths.
- Native/core/app tests pin final-grid 5mm margins to `5.0 +/- 0.1mm`, including rotated and differently cropped matched pages.
- Preview/final geometry parity and stale-result invalidation are covered at their ownership boundaries.

### Quality and compatibility evidence

- Acceptance2 corpus: 24/24 assertions, artifact audit 6/6 pages, no page or neighbor failures; evidence at `.devkit/tmp/scan-cleanup-ledger-evidence/acceptance2-after-2/corpus-summary.json`.
- Rome regression corpus: 29/29 assertions, including the visually inspected legitimate torch/staff boundary component; evidence at `.devkit/tmp/scan-cleanup-ledger-evidence/regress-corpus-final/corpus-summary.json`.
- Word-loss audit: acceptance2 0/6 flagged, Linguae page 2 clean after crop-level confirmation of the preserved header rule, and Rome pages 46/49/52/56 all clean with reliable canonical-geometry overlap. The synthetic standalone invented bar remains a failing negative control.
- Generated-PDF verifier: representative pages 1–10, 45, 120, 200, 300, 389, and 392 pass structural and visual checks; its negative control is detected. In a restricted no-WASM renderer, expected JPX-only pages are classified `requires-jpx-consumer`, not silently accepted. Ledger: `.devkit/tmp/scan-cleanup-ledger-evidence/reference-full-verification-3/verification-ledger.json`.
- The exact generated PDF was opened in the EVB Viewer product renderer; pages 1 and 392 rendered successfully. Captures are in the same verification directory.

### Gate evidence

- Full release runner passed at `.devkit/gates/2026-08-07T012851Z/summary.json`, including 929 test files, 6,928 passing tests, seven intentional skips, native/wasm/package checks, and release-cut preflight.
- Native `cargo fmt --check`, release clippy with warnings denied, and release tests passed (343 passing, four ignored, plus integration coverage).
- After the final diagnostic changes, `pnpm lint`, `pnpm typecheck`, 71 pipeline tests, and nine word-loss-audit tests passed.

### Methodology corrections made during implementation

- The previous assumption that every binary output benefits from 2x rendering was narrowed to continuous-source thresholding; existing dominant 1-bit information is not upsampled.
- The acceptance artifact failure was fixed through matched-canvas placement/margin semantics, never by lowering image-quality thresholds.
- Word-loss comparisons now consume canonical crop, matched-canvas scale, affine transform, and placement metadata from the conversion summary. Empirical fitting remains only for old summaries and unsupported/dewarped geometry.
- One-bit tolerance keys off bit depth rather than the PDF `stencil` spelling, because Poppler may report equivalent bilevel output as an `image`.
- “Invented component” now requires both a material unsupported area and at least 25% unsupported component ink. This cleared a visually confirmed printed rule with a 6.4% resampling fringe while the 100%-unsupported negative control still fails.
- The scanner-boundary baseline was not broadly exempted: one exact physical bbox was refreshed after source/output crop inspection showed the current component is the legitimate torch/staff drawing.

## Final independent review and publication

Pending the fresh read-only Claude Opus 5 implementation review required by S7. Its findings and dispositions will be appended here before the final push.

## Stop conditions

Stop and reassess instead of forcing the ledger if any of these occur:

- source-aware DPI creates measurable contour loss versus the 720-DPI output;
- the dominant-layer classifier cannot distinguish incidental bilevel art from a page selection mask;
- FIFO look-ahead reproduces a cancellation/deadline hang;
- exact margins require changing the matched PDF page rectangle;
- output size improves only by weakening image-quality checks.
