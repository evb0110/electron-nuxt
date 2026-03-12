# Releasing

Releases are cut locally and published from GitHub by pushing a version tag.

## Normal flow

1. Run `pnpm run release:patch`, `pnpm run release:minor`, or `pnpm run release:major`.
2. The script runs the local verification steps, bumps `package.json`, commits the release version, pushes the commit, then pushes the matching `v*` tag.
3. The tag push triggers the GitHub [`Release`](<repo-root>/.github/workflows/release.yml) workflow, which validates, smoke-tests, packages, and publishes the release in one run.

## Recovery flow

- If GitHub Actions flakes during packaging or publishing, rerun the failed `Release` workflow for the same tag in GitHub Actions.
- If you need to retry from scratch, use the workflow's manual dispatch and provide the existing tag.

## Why this is less brittle

- Validation, packaging, and publication now happen inside one workflow run.
- Release artifacts are downloaded from the same run that built them, so there is no cross-workflow run-id lookup or artifact certification handoff.
- Local release cutting no longer depends on `gh workflow run` orchestration to publish a tag.
