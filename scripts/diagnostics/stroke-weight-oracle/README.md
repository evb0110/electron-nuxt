# Component stroke-weight oracle

Adjudicates whether a cleaned page carries **intra-line stroke-weight
discontinuities** — a component that is visibly heavier than its immediate
neighbours on the same text line. Uniform weight change across a page is not a
defect; a single word or letter rendered fat next to normal-weight text is.

The oracle exists so that binarization work (`native/scan-cleanup/src/bw.rs`
and the rescue paths that feed it) can be judged from a clone instead of a
one-off research host. It is a **diagnostic runner**, not a CI gate: nothing in
`ci.yml` invokes it yet.

## Measurement

1. Obtain a foreground mask: for `--pdf`, the exact full-resolution JBIG2 mask
   of each output page (never a thresholded composite render); for `--image`,
   the rendered page raster at the declared `--dpi`.
2. Label 8-connected components and drop those outside the eligible size band.
3. Measure each component's stroke width as twice the median L2
   distance-transform ridge radius inside the component.
4. Group components into text lines by center-Y proximity.
5. For every component, compare its width against the median width of the
   components within the local horizontal radius on the same line.
6. A component whose ratio exceeds the offender threshold is an offender. The
   gate passes only when every requested page is measurable and no page has an
   offender.

## Calibration constants

These values were adjudicated on the Vorwort specimen (below) and are the
identity of the measurement. Changing any of them makes a report incomparable
with the recorded baseline and with the FAIL verdict already on record.

| constant | value |
|---|---:|
| connectivity | 8 |
| eligible area | ≥ 8 px at 300 DPI |
| eligible height | 12–70 px at 300 DPI |
| eligible width | 2–200 px at 300 DPI |
| line center gap | 0.72 × median eligible height |
| minimum components per line | 8 |
| local horizontal radius | 32 mm |
| minimum local components | 7 |
| offender ratio | > 1.6 × local median |

The radius was chosen because 32 mm is the smallest tested value that keeps the
audit's 1.6× threshold, makes both Vorwort leaves red, and leaves the manually
inspected clean control (source 126R) green — 16/24 mm also redden the control,
40/48 mm lose specimen sensitivity.

## Running it

```sh
node scripts/diagnostics/stroke-weight-oracle/stroke-weight-oracle.mjs \
  --image <cleaned-page.png> --dpi 300 --out <report.json>

node scripts/diagnostics/stroke-weight-oracle/stroke-weight-oracle.mjs \
  --pdf <cleaned.pdf> --summary <conversion-summary.json> --pages 9-16 \
  --out <report.json>
```

Exit status is 0 for a green gate, 1 for a red gate, 2 for invalid input or a
measurement failure. `--pdf` additionally needs `pdfimages`/`jbig2dec` on PATH,
because it reuses `scan-cleanup-rendered-metrics.py` for mask extraction.

The measurement helper needs OpenCV, NumPy and Pillow. CI installs Pillow only,
so the interpreter is selectable with `--python` or `$EVB_PYTHON`; a virtualenv
with `opencv-python-headless numpy Pillow` is enough.

## Specimen provenance

`native/scan-cleanup/tests/fixtures/rescue/luther-p5-*.png` are the three
adjudicated Vorwort line regions — `Diyarbakır in`, `wahrscheinlich`, and the
body `Handschrift` line — cropped at intrinsic 300 DPI from source spread 5 of
`003319_luther_syr_chronik_josua_styllites.djvu`. They are byte-identical to the
fixtures on `fix/rescue-caps-fold-mask` (`8a3e5e5c0`) and are committed here so
the oracle has a specimen without the 134 MB source book.

The research host measured whole Vorwort leaves from a full-book conversion and
recorded main as red at **23/21** offenders (5L/5R) with the candidate branch
worsening to **24/34**; that corpus cannot be tracked, so the repository
baseline below measures the same adjudicated line regions instead. The two are
the same measurement with different amounts of page context and their offender
counts are not directly comparable.

## Recorded red calibration baseline

`calibration/main-ed92303ba.json` is the run of record.

- Ref: `origin/main` at `ed92303ba328bcd7e24c0f080263f9e7b9d53503`.
- Binary: `cargo build --release -p evb-scan-cleanup` from that tree,
  SHA-256 `2d3ea4e52618d991622136ca08e426c0769294eaa9d6bb8abfd2fb4d4e6d4d22`.
- Environment: Python 3.14.6, OpenCV 5.0.0, NumPy 2.5.2, Pillow 11.3.0.
- Verdict: **RED — 6 offenders, gate fails (exit 1)**, all six on the
  `Diyarbakır in` line; `wahrscheinlich` and the body `Handschrift` line are
  clean at this amount of line context.

| specimen line | components | line p50 mm | line p95 mm | offenders |
|---|---:|---:|---:|---:|
| `Diyarbakır in` | 53 | 0.508 | 0.677 | **6** |
| `wahrscheinlich` | 53 | 0.508 | 0.576 | 0 |
| body `Handschrift` | 75 | 0.339 | 0.508 | 0 |

Reproduce from a clean checkout at that ref:

```sh
cargo build --release -p evb-scan-cleanup --manifest-path native/Cargo.toml
mkdir -p .devkit/tmp/stroke-weight-oracle
./native/target/release/evb-scan-cleanup \
  --manifest scripts/diagnostics/stroke-weight-oracle/calibration/render-manifest.json
node scripts/diagnostics/stroke-weight-oracle/stroke-weight-oracle.mjs \
  --image .devkit/tmp/stroke-weight-oracle/diyarbakir-clean.png \
  --image .devkit/tmp/stroke-weight-oracle/wahrscheinlich-clean.png \
  --image .devkit/tmp/stroke-weight-oracle/handschrift-clean.png \
  --dpi 300 --out <report.json>
```

`calibration/render-manifest.json` pins how the specimen reaches the oracle:
single layout, Auto binarization, BW output, illumination correction on, no
content crop and no page-size matching, so the measured raster keeps the
crop's own geometry.
