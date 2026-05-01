# evb-viewer Rules

## OCR System
- Optimize for quality and robustness — no constraints on tool choice, language, or bundle size
- Always use `tessdata-best` models (~10-15MB per language) from `https://github.com/tesseract-ocr/tessdata_best`
- Keep OCR language models and their canonical registry in sync.

## Design System
Never hardcode CSS values — use design tokens from `app/assets/css/main.css`.
- Brand palette: `@theme` block (Tailwind v4)
- Semantic tokens: `:root` block (with `.dark` override)
- No raw color values in component `<style>` or inline styles

## Localization
Never hardcode UI-facing text. Use `t()` with keys in `packages/i18n-app/messages/en.ts` and `packages/i18n-app/messages/ru.ts`.

## Icon Bundling
All icons must be in `clientBundle.icons` in `nuxt.config.ts`. Without this, icons fetch from Iconify API at runtime, violating CSP in Electron.

## Electron Skill
If the `electron-puppeteer` skill breaks, fix it and update `SKILL.md` — don't work around it.

## Cross-Arch Packaging
For native-tool or packaging changes, run `pnpm run check:resources:matrix` and verify with `scripts/verify-packaged-native-tools.sh`. No `eval` workers in production paths.

## Code Health (Fallow)
Run `pnpm validate` (includes `pnpm fallow`) after major changes. Remove unused code instead of suppressing with `_` prefixes.
Use `pnpm run fallow:all` when intentionally checking dead code, duplicates, and complexity together.

## FreeText Note Persistence
FreeText+Popup annotation persistence is non-trivial due to PDF.js reading `/Contents` from the parent dict. Review the project note-persistence documentation before modifying annotation serialization or note window code.

## Commands
```bash
pnpm run gate:commit           # Fast staged-file checks used by pre-commit
pnpm lint && pnpm typecheck    # Baseline local verification
pnpm validate                  # Full validation (includes fallow)
pnpm run gate:pre-release      # Full pre-release validation + full tests
pnpm run check:resources:matrix # Cross-arch resource check
```
