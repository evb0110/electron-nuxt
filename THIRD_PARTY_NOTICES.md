# Third-Party Notices

This file is a practical index of the major third-party components and assets that EVB Viewer bundles or vendors. It is not a substitute for the upstream license files; keep those files with the assets when refreshing dependencies.

## Bundled Web Assets

- PDF.js assets from `pdfjs-dist` are copied under `public/pdf/`. Upstream license files for CMaps, ICC profiles, standard fonts, and WebAssembly helpers are retained in that tree.
- DjVu.js browser assets are vendored under `public/vendor/djvujs/`; see `public/vendor/djvujs/LICENSE.md`.

## Desktop Native Resources

- Tesseract OCR binaries and `tessdata_best` language models are bundled under `resources/tesseract/`.
- Poppler binaries and poppler-data resources are bundled under `resources/poppler/`; Windows poppler-data license files are retained under `resources/poppler/win32-x64/share/poppler/`.
- qpdf binaries are bundled under `resources/qpdf/`.
- DjVuLibre binaries are bundled under `resources/djvulibre/`.

## Package Dependencies

Application and development dependencies are declared in `package.json`, workspace package manifests, and `landing/package.json`. Refresh this notice whenever bundled native resources, vendored browser assets, or license-carrying package artifacts change.
