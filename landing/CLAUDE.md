# Landing — deployment & vendored packages

This Nuxt app is its **own Vercel project** (`evb-viewer`), deployed by running
`vercel` / `vp` from inside `landing/`. That uploads **only** `landing/`, so the
monorepo's `../packages/*` are **not** present in the build.

## Keep the landing self-contained
The shared code the landing needs is vendored into `landing/vendor/`:
- `vendor/i18n-core` and `vendor/release-selection` — copies of the matching
  `../packages/*` (the monorepo remains the source of truth).
- `vendor/contracts` — minimal: only `release.ts` (the release types).

The aliases (`@i18n-core`, `@releaseSelection`, `@contracts`) and the
`nuxt.config.ts` locale import point at `./vendor/*`, so the build never touches
`../packages`.

**Never import from `../packages/*` in this app** — it builds locally (full
monorepo present) but breaks the Vercel deploy with
`Cannot find module '../packages/...'`.

After changing `packages/{contracts,i18n-core,release-selection}` in the
monorepo, run `pnpm sync:vendor` from `landing/` and commit the result.
`pnpm check:vendor` fails if `vendor/` has drifted from the source packages.
