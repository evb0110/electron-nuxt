# EVB Viewer Landing

Nuxt marketing and download site for EVB Viewer web and desktop entry points.

## What it does

- Presents EVB Viewer as both a browser app and a desktop app
- Fetches latest desktop release assets from GitHub at `/api/releases/latest`
- Detects user platform and architecture from browser user agent
- Suggests the most likely desktop installer automatically
- Lets users pick any other desktop build manually
- Includes feature overview and end-user documentation

## Configuration

The release API reads these environment variables at runtime:

- `NUXT_GITHUB_OWNER` (default: `evb0110`)
- `NUXT_GITHUB_REPO` (default: `evb-viewer`)
- `NUXT_GITHUB_API_BASE` (default: `https://api.github.com`)
- `NUXT_GITHUB_TOKEN` (optional; recommended to raise GitHub API limits)

## Local development

```bash
pnpm install
pnpm dev
```

## Deploy with Vercel CLI

From `landing/`:

```bash
pnpm install
pnpm build
vercel deploy
vercel deploy --prod
```

Optional environment variables on Vercel:

```bash
vercel env add NUXT_GITHUB_OWNER
vercel env add NUXT_GITHUB_REPO
vercel env add NUXT_GITHUB_TOKEN
```

## License

[MIT](./LICENSE) Copyright © 2026 Eugene Barsky
