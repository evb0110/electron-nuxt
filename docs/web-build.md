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
- `build` produces the Nuxt web build used for deployment, including prerendered app routes, Nitro server endpoints, and a post-build check that required browser WASM assets were copied into the deploy output.
- `build:desktop` adds the Electron bundles on top of the Nuxt web build for local packaging and release flows.
- Vercel builds emit Nitro output into `.vercel/output`; local desktop flows keep using `nuxt-output/`.
- `pnpm lint && pnpm typecheck && pnpm build` is the current web-scope verification batch and is independent of the separate `landing/` app.
- Browser Rust/WASM artifacts are prebuilt under `public/wasm/`; web deploys verify and serve those artifacts but do not rebuild them remotely.

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
- `pnpm run check:dependency-lockstep` keeps Vue runtime/compiler pins,
  intlify runtime pins, `vue-i18n`, and pnpm overrides aligned.
- `pnpm validate` is the broad local gate: lint, typecheck, type coverage,
  strict build, fallow checks, and architecture checks.

## Dependency Lockstep

The web build ships Nuxt/Nitro production dependencies; desktop packaging
bundles all runtime code into dist-electron via esbuild and ships no
node_modules (enforced by scripts/release/assert-packaged-app-contents.mjs).
The direct Vue runtime/compiler
packages therefore stay exact-pinned to `dependencies.vue`, with
`@vue/compiler-sfc` pinned through `pnpm.overrides`; the intlify runtime
packages stay exact-pinned together, and `vue-i18n` must declare a range that
includes that intlify runtime pin. When bumping either family, update every
matching direct pin and override together, run
`pnpm run check:dependency-lockstep`, then run the normal lint/typecheck or
`pnpm validate` gate. The same check also verifies that every pnpm override
still points at a package resolved in `pnpm-lock.yaml`, so removed transitive
dependencies leave a visible cleanup failure instead of a quiet stale override.
