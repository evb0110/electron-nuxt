# Vercel Deployment

## Project

- Vercel project name: `evb-viewer-web`
- Runtime target: SSR Nuxt web app

## Repo Configuration

- Do not commit a root `vercel.json` for this project.
- Configure the Vercel project in the dashboard or API instead:
- Framework preset: `Nuxt.js`
- Build command: leave unset so Vercel uses the repo default `pnpm build`
- Output directory: leave unset
- Install command: leave unset unless Vercel auto-detection regresses; the default `pnpm install` is compatible with `pnpm-lock.yaml`
- Development command: optional `pnpm dev:web`

## Notes

- This deploy path is for the browser app, not the Electron shell.
- The generated app serves the web workspace at `/`.
- Electron-only routes such as `/electron` are not part of the intended Vercel product surface.
- Do not switch production Vercel builds to `generate:web` or set an explicit output directory: `/` relies on cookie-backed SSR state for browser settings, recent files, and install-hint visibility.
- `nuxt.config.ts` writes Nitro output to `.vercel/output` for Vercel-hosted builds and local `vercel build`, which lets Vercel consume the Build Output API artifact while Electron and release flows keep using `nuxt-output/`.
- Desktop release artifacts are intentionally written to `release/`, not `dist/`, so they cannot be mistaken for web output during Vercel deploys.
- Local Vercel link metadata lives in `.vercel/` and is gitignored.

## Suggested Dashboard Settings

- Project name: `evb-viewer-web`
- Root directory: repository root
- Package manager: `pnpm`
- Production branch: `main`

## Local Verification

- `pnpm build`
- `vercel build`
- `vercel --prod`
