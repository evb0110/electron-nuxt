# evb-viewer Rules

## OCR

- Prioritize OCR quality and robustness over tool, language, or bundle-size constraints.
- Use `tessdata-best` models from `https://github.com/tesseract-ocr/tessdata_best`.
- Keep OCR language models and the canonical registry in sync.

## UI

- Use design tokens from `app/assets/css/main.css`; avoid raw CSS values in components.
- Localize UI-facing text with `t()` and update the English and Russian message files together.
- Register all icons in `clientBundle.icons` in `nuxt.config.ts`.

## Naming

- Use lower kebab-case for Nuxt, Vue, Electron, package, and feature directories.
- Use camelCase for TypeScript files, with dot suffixes only for established roles.
- Use PascalCase for Vue components.
- Keep route files lower kebab-case when Nuxt route conventions call for it.

## Verification

- `pnpm run check:naming` is part of `pnpm lint`.
- Run `pnpm validate` after major changes.
- Use `pnpm run fallow:all` for failing dead-code and duplicate checks; use `pnpm run fallow:health:summary` only when you need the informational maintainability report.

## PDF Notes

- Read the FreeText note-persistence documentation before changing annotation serialization or note-window code.
- Electron e2e runs in nightly/manual diagnostics until the smoke lane is stable enough to promote; keep release gates focused on deterministic checks.
- For visual PDF navigation blink/skeleton debugging, see `scripts/diagnostics/README.md`.
