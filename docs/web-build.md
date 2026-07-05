# Web Build Notes

## Commands

- `pnpm dev`
- `pnpm dev:web`
- `pnpm build`
- `pnpm build:desktop`
- `pnpm preview`
- `pnpm lint && pnpm typecheck && pnpm build`
- `pnpm run test:bundle-integrity:no-build`
- `pnpm exec vitest run --project unit-policy tests/unit/scripts/releasePolicy.test.ts`
- `pnpm run validate:changed`
- `pnpm run fallow:changed`
- `pnpm validate`

## Intended Use

- `dev` starts one Nuxt dev server plus Electron, with the browser app at `/` and the Electron shell at `/electron`.
- `build` produces the Nuxt web build used for deployment, including prerendered app routes, Nitro server endpoints, and a post-build check that required browser WASM assets were copied into the deploy output.
- `build:desktop` adds the Electron bundles on top of the Nuxt web build for local packaging and release flows.
- Vercel builds emit Nitro output into `.vercel/output`; local desktop flows keep using `nuxt-output/`.
- `pnpm lint && pnpm typecheck && pnpm build` is the current web-scope verification batch and is independent of the separate `landing/` app. `lint` owns ESLint, stylelint, and the fast static checks; slower static report/assets checks are split into `pnpm run check:static:reports` and `pnpm run check:static:assets`.
- After a desktop build has produced `dist-electron/`, `pnpm run test:bundle-integrity:no-build` runs the bundle-integrity assertions without forcing another build. Use `pnpm run test:bundle-integrity` when you want the script-managed build, prune, and hygiene wrapper.
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

- `pnpm run check:architecture` validates app/module boundaries and source-size policy. Normal `lint` runs the focused import/boundary subset through `check:architecture:imports`.
- `pnpm run check:dependency-lockstep` keeps Vue runtime/compiler pins,
  intlify runtime pins, `vue-i18n`, and pnpm overrides aligned.
- `pnpm validate` is the broad local gate: lint, split static report/assets
  checks, typecheck, unit tests, type coverage, strict build, fallow checks,
  and source-size policy.
- Changed or fast loops are for iteration only: `pnpm run validate:changed`
  runs cached ESLint, changed Vitest tests, and changed fallow checks;
  `pnpm exec vitest run --project unit-policy tests/unit/scripts/releasePolicy.test.ts`
  keeps release/local policy edits tight. Run the broader gate before relying
  on the result for release or merge confidence.

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
