# Contributing

Thanks for helping improve EVB Viewer. This project is a shared Nuxt/Electron document viewer, so changes can affect both the browser workspace and the packaged desktop app.

## Development

1. Install dependencies with `pnpm install`.
2. Start the desktop development flow with `pnpm dev`, or the browser workspace with `pnpm dev:web`.
3. Keep secrets and local-only paths in `.env` files or ignored `.devkit/` files. Use `.env.example` and `landing/.env.example` as templates.

## Checks

Run the smallest useful check while iterating, then run the broader gates before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

For release, packaging, Electron runtime, native-tool, OCR, DjVu, worker, or cross-architecture changes, also run:

```bash
pnpm run check:resources:matrix
```

Use `pnpm validate` for the full maintenance gate when the change touches shared architecture, build tooling, or release-critical behavior.

## Pull Requests

- Keep pull requests focused and explain the user-visible behavior change.
- Include screenshots or recordings for UI changes.
- Add or update tests for bug fixes and behavior changes.
- Leave unrelated formatting, generated files, and local artifacts out of the diff.

## Manual Fixtures

Large PDF regression files are intentionally not committed. Put local-only diagnostic PDFs under `.devkit/manual-pdf-fixtures/` or set the `EVB_E2E_*` paths documented in `.env.example`.
