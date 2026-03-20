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
- `build:web` produces the SSR Nuxt web build used for deployment.
- `generate:web` is available only for static-export experiments and does not preserve cookie-driven SSR behavior on `/`.
- `validate:web` runs lint, typecheck, and `build:web`.

## Current Scope

- Browser routes:
  - `/` shared browser workspace
  - `/workspace` compatibility redirect to `/`
  - `/electron` desktop-only shell entry
- PDF-and-images-first browser runtime
- Browser-backed open/save/recent-files/search/page-ops flows
- OCR unavailable in browser runtime
- DjVu viewing and explicit PDF conversion available in browser runtime
- Desktop app updates unavailable in browser runtime
