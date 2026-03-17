# Vercel Deployment

## Project

- Vercel project name: `evb-viewer-web`
- Runtime target: static web build only

## Repo Configuration

- Vercel reads [`vercel.json`](<repo-root>/vercel.json)
- Install command: `pnpm install --frozen-lockfile`
- Build command: `NITRO_PRESET=vercel-static pnpm generate:web`
- Published output directory: `nuxt-output/static`

## Notes

- This deploy path is for the browser app, not the Electron shell.
- The generated app serves the web workspace at `/`.
- Electron-only routes such as `/electron` are not part of the intended Vercel product surface.
- Local Vercel link metadata lives in `.vercel/` and is gitignored.

## Suggested Dashboard Settings

- Project name: `evb-viewer-web`
- Root directory: repository root
- Package manager: `pnpm`
- Production branch: `main`

## Local Verification

- `pnpm generate:web`
- `NITRO_PRESET=vercel-static pnpm generate:web`
- `vercel build`
