# Vercel Deployment

## Project

- Vercel project name: `evb-viewer-web`
- Runtime target: prerendered Nuxt web app with client-side runtime personalization

## Repo Configuration

- Do not commit a root `vercel.json` for this project.
- Configure the Vercel project in the dashboard or API instead:
- Framework preset: `Nuxt.js`
- Build command: leave unset so Vercel uses the repo default `pnpm build`
- Output directory: leave unset
- Install command: leave unset unless Vercel auto-detection regresses; the default `pnpm install` is compatible with `pnpm-lock.yaml` and `pnpm-workspace.yaml`
- Development command: optional `pnpm dev:web`

## Notes

- This deploy path is for the browser app, not the Electron shell.
- The generated app serves the web workspace at `/`.
- Electron-only routes such as `/electron` are not part of the intended Vercel product surface.
- Keep `/` prerendered for production Vercel builds. Browser settings, recent files, and install-hint visibility are seeded from client-readable cookies/local runtime storage after the static shell loads; do not reintroduce request-time SSR for that personalization path.
- `nuxt.config.ts` writes Nitro output to `.vercel/output` for Vercel-hosted builds and local `vercel build`, which lets Vercel consume the Build Output API artifact while Electron and release flows keep using `nuxt-output/`.
- Browser Rust/WASM artifacts are checked in under `public/wasm/`; `pnpm build` verifies they are present in `.vercel/output/static/wasm/` during Vercel builds.
- Desktop release artifacts are intentionally written to `release/`, not `dist/`, so they cannot be mistaken for web output during Vercel deploys.
- Local Vercel link metadata lives in `.vercel/` and is gitignored.
- Vercel only needs the root workspace package; the separate `landing/` app has its own package manager files and deploy path.
- `pnpm run check:web-deploy-source` verifies the local deploy source stays below Vercel upload limits and that Electron, native, fixture, coverage, and other local-only paths remain excluded.

## Suggested Dashboard Settings

- Project name: `evb-viewer-web`
- Root directory: repository root
- Package manager: `pnpm`
- Production branch: `main`

## Local Verification

- `pnpm build`
- `vercel build`
- `vc-private --prod`

## Production Database Migrations

- A production deploy does not apply Drizzle migrations automatically. Apply pending root viewer migrations with `pnpm run db:migrate` before deploying server code that depends on them.
- Pull the Vercel Production environment into a permission-restricted temporary file, export it only for the migration command, and remove it immediately afterward. Never print or commit the file.
- After deployment, send a valid event to `/api/analytics/events` and require an HTTP 200 response whose JSON body contains `"ok": true` and `"persisted": true`. A 200 response by itself is insufficient because the endpoint deliberately reports database failures in its response body.
- The root `drizzle/` migrations belong to `evb-viewer-web`. The separate `landing/drizzle/` migrations are for the landing project and must not be substituted for them.

## Private Email CLI Deploys

- Keep Git commits authored with the GitHub no-reply address to avoid leaking a personal email in public repositories.
- Use `vc-private --prod` instead of `vercel --prod` for local CLI deploys. The global wrapper copies the source tree into a temporary directory without `.git`, preserves `.vercel/project.json`, and runs a normal remote `vercel deploy` from that clean source tree.
- The wrapper passes `--archive=tgz` by default so Vercel receives a tarball upload instead of counting each source file against the direct upload item limit.
- The wrapper's temporary source copy omits local-only directories before upload and removes `.vercelignore` entries that point at omitted paths, which avoids Vercel archive-mode `ENOENT` failures.
- The local `vp` alias already expands to `vc-private --prod --logs`; use plain `vp` for the normal production deploy.
- This avoids sending the commit author email in Vercel CLI Git metadata, which prevents Vercel from treating the GitHub no-reply address as a separate team collaborator.
- Because Vercel still performs the build remotely, Production/Preview environment variables and normal alias behavior match dashboard or Git-backed deploys.
- Use `vc-private` for a preview deployment.
- If an upload fails due to a transient network error, rerun the same `vc-private` command.
