# Local Large PDF Fixtures

This directory is reserved for local-only large PDF fixtures. Binary PDFs in this
directory are intentionally not committed because they are too large for the
repository and are only needed for opt-in regression coverage. The fixture-policy
unit suite enforces that only this README (`*.md`) ever lands here.

Two Electron e2e lanes cover large PDFs. Only the annotation-save lane reads a
fixture from here; its native-preview sibling generates its own oversized file
because the two lanes need opposite sides of the same size threshold.

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
  lane instead of skipping it. `pnpm run test:e2e:electron:large` sets it.

The fixture must stay below `PDFJS_NATIVE_PREVIEW_MIN_BYTES` (512 MiB). At or
above that cap the document opens through the native preview and never reaches
the PDF.js annotation surface this lane covers, so the resolver refuses it with
that explanation rather than letting the lane time out.

Known local provenance is limited to the fixture filename and the audit note that
identifies this as a local-only large PDF fixture, about 172 MB, for the
opt-in large PDF annotation-save suite. The exact public download URL is not
recorded in this checkout. A replacement fixture should be a large PDF that opens
in the Electron viewer and preserves an existing FreeText note while allowing the
suite to add, save, reopen, and verify another FreeText popup note.

## Native-preview lane

`tests/e2e/electron/largePdfNativePreview.e2e.test.ts` proves that a path-backed
PDF above the PDF.js size cap opens through the native preview instead of failing
allocation. Only the byte count decides that route, so this lane needs *size*, not
content, and it never reads `EVB_E2E_LARGE_PDF_FIXTURE`: the annotation-save
document is far below the cap, and a document above the cap could not drive the
annotation-save lane at all.

Instead the lane provisions its own fixture with
`scripts/generate-large-pdf-e2e-fixture.mjs`, which writes a small pdf-lib
document and sparse-pads it to `PDFJS_NATIVE_PREVIEW_MIN_BYTES + 1 MiB`. It runs
in well under a second, costs a few hundred KiB of real disk, and is cached under
`.devkit/tmp/e2e-fixture-cache/`. The lane therefore cannot be handed an
undersized PDF, and it needs no local binary and no CI download step:

```sh
pnpm run test:e2e:electron:large
```

Generate one by hand only when inspecting the fixture:

```sh
node scripts/generate-large-pdf-e2e-fixture.mjs --output=/tmp/native-preview.pdf
```
