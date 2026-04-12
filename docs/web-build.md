# Web Build Notes

## Commands

- `pnpm dev`
- `pnpm dev:web`
- `pnpm build`
- `pnpm build:desktop`
- `pnpm generate:web`
- `pnpm preview`
- `pnpm lint && pnpm typecheck && pnpm build`

## Intended Use

- `dev` starts one Nuxt dev server plus Electron, with the browser app at `/` and the Electron shell at `/electron`.
- `build` produces the SSR Nuxt web build used for deployment and is the contract Vercel should use.
- `build:desktop` adds the Electron bundles on top of the SSR web build for local packaging and release flows.
- Vercel builds emit Nitro output into `.vercel/output`; local desktop flows keep using `nuxt-output/`.
- `generate:web` is available only for static-export experiments and does not preserve cookie-driven SSR behavior on `/`.
- `pnpm lint && pnpm typecheck && pnpm build` is the current web-scope verification batch.

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
