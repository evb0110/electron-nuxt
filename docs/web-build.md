# Web Build Notes

## Commands

- `pnpm dev`
- `pnpm dev:web`
- `pnpm build`
- `pnpm build:desktop`
- `pnpm preview`
- `pnpm lint && pnpm typecheck && pnpm build`
- `pnpm validate`

## Intended Use

- `dev` starts one Nuxt dev server plus Electron, with the browser app at `/` and the Electron shell at `/electron`.
- `build` produces the Nuxt web build used for deployment, including prerendered app routes and Nitro server endpoints, and is the contract Vercel should use.
- `build:desktop` adds the Electron bundles on top of the Nuxt web build for local packaging and release flows.
- Vercel builds emit Nitro output into `.vercel/output`; local desktop flows keep using `nuxt-output/`.
- `pnpm lint && pnpm typecheck && pnpm build` is the current web-scope verification batch and is independent of the separate `landing/` app.

## Current Scope

- Browser routes:
  - `/` shared browser workspace
  - `/workspace` compatibility redirect to `/`
  - `/electron` desktop-only shell entry
- PDF-and-images-first browser runtime
- Browser-backed open/save/recent-files/search/page-ops flows
- OCR and searchable-PDF generation are desktop-only. Browser search uses
  text extracted from the current PDF bytes and does not consume browser OCR
  sidecar artifacts.
- DjVu viewing and explicit PDF conversion are available in browser runtime
  through the vendored DjVu.js worker path.
- Desktop app updates unavailable in browser runtime

## Broader Gates

- `pnpm run check:architecture` validates app/module boundaries.
- `pnpm validate` is the broad local gate: lint, typecheck, type coverage,
  strict build, fallow checks, and architecture checks.
