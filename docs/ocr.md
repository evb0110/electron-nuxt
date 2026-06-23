# OCR Notes

EVB Viewer keeps Tesseract as the default OCR backend and uses `tessdata-best`
models from `resources/tesseract/tessdata`. The near-term quality work should
improve the wrapper profile, language ordering, page rendering, and optional
preprocessing before adding another engine.

PaddleOCR or hosted/local vision models may become optional future backends, but
they should not replace Tesseract until they have a repeatable quality,
offline/privacy, packaging, and searchable-PDF story.

## Profile Benchmark

Run the manual profile benchmark when tuning OCR options:

```bash
pnpm run diag:ocr-profile-benchmark -- tests/fixtures/electron/test-scanned.pdf --pages 1 --languages eng
```

Use `--dry-run` to validate the selected tools, tessdata models, pages, and
profile matrix without rendering or running OCR.

The script renders selected PDF pages to PNG, or uses PNG/JPEG/TIFF inputs
directly, then compares the same profile names exposed by the app:

- `balanced`: current EVB language ordering, spacing, and dictionary settings
- `accurate`: EVB ordering and spacing while preserving Tesseract dictionaries
- `poor-scan`: balanced settings plus `unpaper` cleanup and adaptive thresholding

The benchmark can also include internal comparison baselines, such as `stock`
for Tesseract without EVB wrapper options. Those baselines are not app-exposed
quality profiles.

Artifacts are written under `.devkit/tmp/ocr-profile-benchmark/<timestamp>/`.
Start with `summary.csv` for a quick comparison and keep `summary.ndjson` for
automation. The minimum useful metrics are `text_length`, `word_count`,
`mean_confidence`, `median_confidence`, `preprocessing_result`, and
`runtime_ms`; inspect per-run TSV, logs, rendered images, preprocessed images,
and `parsed-text.txt` before accepting a profile change.

Higher confidence with similar or better text length is usually a good sign.
Lower runtime only matters when text quality does not regress for the document
class being tuned.
