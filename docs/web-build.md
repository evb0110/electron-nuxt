# Web Build Notes

## Commands

- `pnpm dev:all`
- `pnpm dev:electron`
- `pnpm dev:web`
- `pnpm build:web`
- `pnpm generate:web`
- `pnpm preview:web`
- `pnpm validate:web`

## Intended Use

- `dev:all` starts one Nuxt dev server plus Electron, with the browser app at `/` and the Electron shell at `/electron`.
- `dev:electron` is an alias for `dev:all`.
- `build:web` produces the standard Nuxt web build.
- `generate:web` produces a prerendered static web artifact for static hosting.
- `validate:web` runs lint, typecheck, `build:web`, and `generate:web` sequentially.
- Static output is written to `nuxt-output/public`.

## Current Scope

- Browser routes:
  - `/` shared browser workspace
  - `/workspace` compatibility redirect to `/`
  - `/electron` desktop-only shell entry
- PDF-and-images-first browser runtime
- Browser-backed open/save/recent-files/search/page-ops flows
- OCR unavailable in browser runtime
- DjVu unavailable in browser runtime
- Desktop app updates unavailable in browser runtime
