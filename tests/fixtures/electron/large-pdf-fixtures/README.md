# Local Large PDF Fixtures

This directory is reserved for local-only large PDF fixtures. Binary PDFs in this
directory are intentionally not committed because they are too large for the
repository and are only needed for opt-in regression coverage.

The default fixture expected by the Electron e2e helper is:

```text
turkish-english-lexicon-letter-bookmarks.pdf
```

It is used by `tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts`, which can
be run with:

```sh
pnpm run test:e2e:electron:large
```

The resolver also supports these alternatives:

- Set `EVB_E2E_LARGE_PDF_FIXTURE` to an absolute path for the PDF.
- Place the same relative path under `.devkit/`, for example
  `.devkit/large-pdf-fixtures/turkish-english-lexicon-letter-bookmarks.pdf`.

Known local provenance is limited to the fixture filename and the audit note that
identifies this as a local-only large PDF fixture, about 172 MB, for the
opt-in large PDF annotation-save suite. The exact public download URL is not
recorded in this checkout. A replacement fixture should be a large PDF that opens
in the Electron viewer and preserves an existing FreeText note while allowing the
suite to add, save, reopen, and verify another FreeText popup note.
