# Releasing

Releases are cut locally and published from GitHub by pushing a version tag.

## Normal flow

1. Run `pnpm run release:patch`, `pnpm run release:minor`, or `pnpm run release:major`.
   The release script now fails before the version bump unless it is running under Node 24.x, which is the project's current LTS baseline.
2. The script bumps `package.json`, then runs the local release gate against that exact would-be tagged tree: validation, tests, Electron smoke, current-platform packaging, updater metadata checks when applicable, packaged native-tool verification, packaged startup verification on macOS, and the cross-arch resource matrix.
3. If that local release gate passes, the script commits the release version, pushes the commit, then pushes the matching `v*` tag.
4. The tag push triggers the GitHub [`Release`](<repo-root>/.github/workflows/release.yml) workflow, which validates, smoke-tests, packages, and publishes the release in one run.

## Local guardrails

- `pnpm run release:verify` mirrors the local parts of the release workflow and now includes current-platform packaging verification.
- `pnpm run release:verify:package:local` packages the current platform exactly as the release workflow would, then validates produced artifacts and updater metadata, verifies packaged native tools, and verifies packaged startup on macOS.
- Cross-platform runner differences, hosted-runner quirks, and secret-only signing/notarization failures can still require GitHub Actions, but ordinary release regressions should now fail before tag push.

## Critical-path rule

- The release must publish as soon as the core release matrix is done: macOS arm64, Linux x64/arm64, and Windows x64/arm64.
- The supplemental `macos-15-intel` lane is intentionally not on the critical path. It runs in parallel and attaches its ZIP to the already-published GitHub release afterward.
- Do not move the `macos-15-intel` build back into the blocking reusable build workflow or make `Create GitHub Release` depend on it. If that happens, Intel runner slowness or flakes will delay the whole release again.

## Recovery flow

- If GitHub Actions flakes during packaging or publishing, rerun the failed `Release` workflow for the same tag in GitHub Actions.
- If you need to retry from scratch, use the workflow's manual dispatch and provide the existing tag.

## Why this is less brittle

- Validation, packaging, and publication now happen inside one workflow run.
- Release artifacts are downloaded from the same run that built them, so there is no cross-workflow run-id lookup or artifact certification handoff.
- Local release cutting no longer depends on `gh workflow run` orchestration to publish a tag.
- Slow or flaky `macos-15-intel` runners no longer hold the GitHub release hostage; they only affect the later Intel ZIP attachment.
