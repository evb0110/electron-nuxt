# Web Build Notes

## Commands

- `pnpm dev`
- `pnpm dev:web`
- `pnpm build`
- `pnpm build:desktop`
- `pnpm preview`
- `pnpm lint && pnpm typecheck && pnpm build`
- `pnpm run test:electron-bundle-static-integrity:no-build`
- `pnpm exec vitest run --project unit-policy tests/unit/scripts/releasePolicy.test.ts`
- `pnpm run validate:changed`
- `pnpm run fallow:changed`
- `pnpm validate`

## Intended Use

- `dev` starts one Nuxt dev server plus Electron, with the browser app at `/` and the Electron shell at `/electron`.
- `build` produces the Nuxt web build used for deployment, including prerendered app routes, Nitro server endpoints, and a post-build check that required browser WASM assets were copied into the deploy output.
- `build:desktop` adds the Electron bundles on top of the Nuxt web build for local packaging and release flows.
- Vercel builds emit Nitro output into `.vercel/output`; local desktop flows keep using `nuxt-output/`.
- `pnpm lint && pnpm typecheck && pnpm build` is the current browser-app verification batch. The landing app shares the root pnpm workspace and lockfile but keeps its own lint, typecheck, and build commands. `lint` owns ESLint, stylelint, and the fast static checks; slower static report/assets checks are split into `pnpm run check:static:reports` and `pnpm run check:static:assets`.
- After a desktop build has produced `dist-electron/`, `pnpm run test:electron-bundle-static-integrity:no-build` runs static bundle assertions without forcing another build. Use `pnpm run test:electron-bundle-static-integrity` when you want the script-managed build, prune, and hygiene wrapper.
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

- `pnpm run check:architecture` validates app/module boundaries. Normal `lint` runs the focused import/boundary subset through `check:architecture:imports`.
- `pnpm validate` is the broad local gate: lint, split static report/assets
  checks, typecheck, unit tests, type coverage, strict build, and fallow checks.
- Changed or fast loops are for iteration only: `pnpm run validate:changed`
  runs cached ESLint, changed Vitest tests, and changed fallow checks;
  `pnpm exec vitest run --project unit-policy tests/unit/scripts/releasePolicy.test.ts`
  keeps release/local policy edits tight. Run the broader gate before relying
  on the result for release or merge confidence.

## Dependency graph

The browser app, landing app, and shared packages use one root pnpm workspace
and one `pnpm-lock.yaml`. Run installs from the repository root; package-level
commands such as `pnpm --dir landing run build` reuse that graph.
