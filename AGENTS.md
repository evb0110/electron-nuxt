# evb-viewer Agent Rules

- Read `CLAUDE.md` before changing this project.
- Create or switch branches only when the user asks or the harness requires it.

## Release And Packaging

- Keep `pnpm run release:verify` host-only, deterministic, and free of tracked-file mutations.
- Add host-independent unit coverage for cross-platform release decisions.
- Keep local release verification aligned with CI mode when runner semantics affect tests.
- Record release-critical install scripts in `pnpm-workspace.yaml` so fresh CI installs fail fast.
- For release-critical native tools on macOS, verify execution from inside the signed app bundle.
- Treat ad-hoc local mac packaging as insufficient evidence for LaunchServices startup behavior.
- Keep public releases working without macOS or Windows signing keys.
- Publish differential updater metadata only for signed builds it can safely update.

## Cross-Arch Changes

For Electron runtime, native binaries/tools, OCR/DjVu paths, workers, or packaging changes, verify after implementation with:

1. `pnpm lint && pnpm typecheck`
2. `pnpm run check:resources:matrix`
3. `scripts/verify-packaged-native-tools.sh <mac|win|linux> <x64|arm64>` when a packaged build exists

Use production paths that avoid `eval` workers and runtime package lookup.

## Electron Puppeteer

- Use the `electron-puppeteer` skill only when the user explicitly requests it.
- Verify Electron changes in large batches.
- If a verification script breaks, fix the script instead of working around it.
