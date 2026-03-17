# Web Build Notes

## Commands

- `pnpm dev:web`
- `pnpm build:web`
- `pnpm generate:web`
- `pnpm preview:web`

## Intended Use

- `build:web` produces the standard Nuxt web build.
- `generate:web` produces a prerendered static web artifact for static hosting.
- Static output is written to `nuxt-output/public`.

## Current Scope

- PDF-and-images-first browser runtime
- Browser-backed open/save/recent-files/search/page-ops flows
- OCR unavailable in browser runtime
- DjVu unavailable in browser runtime
- Desktop app updates unavailable in browser runtime
