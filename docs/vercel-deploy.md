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
- Desktop release artifacts are intentionally written to `release/`, not `dist/`, so they cannot be mistaken for web output during Vercel deploys.
- Local Vercel link metadata lives in `.vercel/` and is gitignored.
- Vercel only needs the root workspace package; the separate `landing/` app has its own package manager files and deploy path.

## Suggested Dashboard Settings

- Project name: `evb-viewer-web`
- Root directory: repository root
- Package manager: `pnpm`
- Production branch: `main`

## Local Verification

- `pnpm build`
- `vercel build`
- `vc-private --prod`

## Private Email CLI Deploys

- Keep Git commits authored with the GitHub no-reply address to avoid leaking a personal email in public repositories.
- Use `vc-private --prod` instead of `vercel --prod` for local CLI deploys. The global wrapper copies the source tree into a temporary directory without `.git`, preserves `.vercel/project.json`, and runs a normal remote `vercel deploy` from that clean source tree.
- This avoids sending the commit author email in Vercel CLI Git metadata, which prevents Vercel from treating the GitHub no-reply address as a separate team collaborator.
- Because Vercel still performs the build remotely, Production/Preview environment variables and normal alias behavior match dashboard or Git-backed deploys.
- Use `vc-private` for a preview deployment.
- If an upload fails due to a transient network error, rerun the same `vc-private` command.
