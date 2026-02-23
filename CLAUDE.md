# evb-viewer Rules

## OCR System
- Optimize for quality and robustness — no constraints on tool choice, language, or bundle size
- Always use `tessdata-best` models (~10-15MB per language) from `https://github.com/tesseract-ocr/tessdata_best`
- Place models in `resources/tesseract/tessdata/`, register in `AVAILABLE_LANGUAGES` in `electron/ocr/ipc.ts`

## Design System
Never hardcode CSS values — use design tokens from `app/assets/css/main.css`.
- Brand palette: `@theme` block (Tailwind v4)
- Semantic tokens: `:root` block (with `.dark` override)
- No raw color values in component `<style>` or inline styles

## Localization
Never hardcode UI-facing text. Use `t()` with keys in both `app/locales/en.ts` and `app/locales/ru.ts`.

## Icon Bundling
All icons must be in `clientBundle.icons` in `nuxt.config.ts`. Without this, icons fetch from Iconify API at runtime, violating CSP in Electron.

## Electron Skill
If the `electron-puppeteer` skill breaks, fix it and update `SKILL.md` — don't work around it.

## Cross-Arch Packaging
For native-tool or packaging changes, run `pnpm run check:resources:matrix` and verify with `scripts/verify-packaged-native-tools.sh`. No `eval` workers in production paths.

## Dead Code (Knip)
Run `pnpm validate` (includes `pnpm knip`) after major changes. Remove unused code instead of suppressing with `_` prefixes.

## Commands
```bash
pnpm lint && pnpm typecheck    # Before every commit
pnpm validate                  # Full validation (includes knip)
pnpm run check:resources:matrix # Cross-arch resource check
```
