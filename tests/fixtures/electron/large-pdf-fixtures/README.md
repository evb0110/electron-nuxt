# Local Large PDF Fixtures

This directory is reserved for local-only large PDF fixtures. Binary PDFs in this
directory are intentionally not committed because they are too large for the
repository and are only needed for opt-in regression coverage. The fixture-policy
unit suite enforces that only this README (`*.md`) ever lands here.

Two opt-in Electron e2e lanes read fixtures from here, and each resolves a fixture
independently.

## Annotation-save lane

`tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts` opens a large PDF,
preserves an existing FreeText note, then adds, saves, reopens, and verifies
another FreeText popup note. The default fixture it expects is:

```text
turkish-english-lexicon-letter-bookmarks.pdf
```

Run it with:

```sh
pnpm run test:e2e:electron:large
```

The resolver also supports these alternatives:

- Set `EVB_E2E_LARGE_PDF_FIXTURE` to an absolute path for the PDF.
- Place the same relative path under `.devkit/`, for example
  `.devkit/large-pdf-fixtures/turkish-english-lexicon-letter-bookmarks.pdf`.
- Set `EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1` to make a missing fixture fail the
  lane instead of skipping it.

Known local provenance is limited to the fixture filename and the audit note that
identifies this as a local-only large PDF fixture, about 172 MB, for the
opt-in large PDF annotation-save suite. The exact public download URL is not
recorded in this checkout. A replacement fixture should be a large PDF that opens
in the Electron viewer and preserves an existing FreeText note while allowing the
suite to add, save, reopen, and verify another FreeText popup note.

## Native-preview lane

`tests/e2e/electron/largePdfNativePreview.e2e.test.ts` proves that a path-backed
PDF above the PDF.js size cap opens through the native preview instead of failing
allocation. It requires a fixture **at least `PDFJS_NATIVE_PREVIEW_MIN_BYTES`
(512 MiB)**; the 172 MB annotation-save fixture is well below that. Below the
threshold this lane **skips permanently and by design** — it is never expected to
run against a committed artifact, because a >512 MiB binary must not enter the
repository.

To run it locally, point it at an oversized PDF and require the lane explicitly:

- `EVB_E2E_LARGE_PDF_FIXTURE` — absolute path to a ≥512 MiB PDF.
- `EVB_E2E_REQUIRE_NATIVE_LARGE_PDF_FIXTURE=1` — turn the skip into a hard failure
  so a misconfigured run cannot silently pass.

You do not need to store or download such a file. `scripts/generate-large-pdf-e2e-fixture.mjs`
produces a valid, deterministic ≥512 MiB PDF in well under a second by writing a
small pdf-lib document and sparse-padding it to the target size, so it costs a few
hundred KiB of real disk rather than 512 MiB:

```sh
fixture="$(mktemp -u).pdf"
node scripts/generate-large-pdf-e2e-fixture.mjs --output="$fixture"
EVB_E2E_LARGE_PDF_FIXTURE="$fixture" \
EVB_E2E_REQUIRE_NATIVE_LARGE_PDF_FIXTURE=1 \
  pnpm run test:e2e:electron:large
```

This is exactly how the nightly `nightly_electron_e2e_large_pdf` CI job
self-provisions the fixture into the runner's temp directory, so the lane runs on
every nightly build without committing a binary.
