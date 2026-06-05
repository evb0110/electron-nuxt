# Releasing

Releases are cut locally and published from GitHub by pushing a version tag.

## Normal flow

1. Run `pnpm run release:patch`, `pnpm run release:minor`, or `pnpm run release:major`.
   The release script now fails before the version bump unless it is running under the Node major pinned in `package.json` `engines.node`, which is the project's current latest-LTS baseline (currently `24.x`).
2. The script bumps `package.json`, then runs the local release gate against that exact would-be tagged tree: linting, typechecking, Electron install verification, fast release-critical tests, strict current-platform build and packaging, updater metadata checks when applicable, packaged native-tool verification, packaged startup verification on macOS, and the cross-arch resource matrix.
3. If that local release gate passes, the script verifies that only `package.json` changed, commits the release version, creates the matching `v*` tag, and pushes the branch update and tag atomically.
4. The tag push triggers the GitHub [`Release`](../.github/workflows/release.yml) workflow, which reruns the focused release checks, packages the main artifacts, and publishes the release in one run.

## Local guardrails

- `pnpm run release:verify` mirrors the local parts of the release workflow and includes current-platform build and packaging verification.
- `release:verify:checks` forces `CI=1` during linting, typechecking, Electron install verification, and the fast release-critical test lane so the local gate stays closer to the GitHub release runner.
- Main app release checks are app-scoped and do not read or build `landing/`. Landing-only working tree changes are ignored by the release cutter so the desktop/web app release path stays independent of the separate landing deploy.
- Broad maintenance checks (`typecheck:coverage`, `fallow`, and architecture graph checks) remain part of `pnpm validate` and pull-request CI, but they do not block every local release cut.
- Release-critical tests should stay deterministic and fast. Long serial Electron E2E checks are available for manual diagnostics, but they no longer block release cutting.
- Fresh installs now follow the checked-in build-script policy in [`pnpm-workspace.yaml`](../pnpm-workspace.yaml). If a new dependency needs an install script for release-critical behavior, update that allow/ignore list deliberately instead of tolerating pnpm's warning output.
- `pnpm run release:verify` is intentionally host-only for packaging. If you change cross-platform launcher or packaging decisions, add unit coverage for that branching logic instead of assuming a macOS-local release cut exercises Linux and Windows paths.
- `pnpm run release:verify:package:local` packages the current platform exactly as the release workflow would, then validates produced artifacts and updater metadata, verifies packaged native tools, and verifies packaged startup on macOS.
- The macOS packaged-startup step is meaningful only when local packaging uses real Developer ID credentials. Ad-hoc local signing still verifies bundled native-tool execution, but it does not faithfully reproduce LaunchServices/runtime-library-validation behavior for a shipped `.app`.
- `codesign --verify` is not enough for macOS release safety. The GitHub mac packaging lanes must also pass `spctl --assess --type execute`, otherwise a bundle can look internally valid while still being rejected or crashing at launch on end-user machines.
- On macOS, packaged native-tool verification must execute the bundled tools from inside the signed app resources, not just inspect file presence or `otool` output. That is how we catch Team-ID/library-validation regressions in bundled DjVuLibre, Poppler, qpdf, and Tesseract payloads before tag push.
- Cross-platform runner differences, hosted-runner quirks, and secret-only signing/notarization failures can still require GitHub Actions, but ordinary release regressions should now fail before tag push.
- macOS and Windows signing secrets are optional. Unsigned releases must still build and launch correctly.
- Unsigned macOS releases are manual-install only. GitHub builds prune `latest-mac*.yml` and `.blockmap` for ad-hoc mac bundles so the updater feed cannot mix signed and ad-hoc framework blocks.
- Unsigned Windows releases are manual-install only too. GitHub builds prune `latest*.yml` and `.blockmap` unless the Windows artifact is the signed x64 updater target.
- The release publish step must tolerate zero updater metadata files. Some releases are intentionally download-only across every platform.

## Critical-path rule

- The release must publish as soon as the core release matrix is done: macOS arm64, Linux x64/arm64, and Windows x64/arm64.
- The supplemental `macos-15-intel` lane is intentionally not on the critical path. It runs in parallel and attaches its ZIP to the already-published GitHub release afterward.
- The supplemental Windows 7 legacy lane is best-effort only. It packages a renamed legacy installer when available and must not block the main release.
- Do not move the `macos-15-intel` or Windows 7 legacy builds back into the blocking reusable build workflow or make `Create GitHub Release` depend on them. If that happens, supplemental runner slowness or flakes will delay the whole release again.

## Recovery flow

- If GitHub Actions flakes during packaging or publishing, rerun the failed `Release` workflow for the same tag in GitHub Actions.
- If you need to retry from scratch, use the workflow's manual dispatch and provide the existing tag.
- If local `release:verify` changes any tracked file besides `package.json`, treat that as a release-script regression and fix it before retrying. The cutter now refuses to auto-stage those extra changes.

## Release command behavior

- The release command now waits for the tag-triggered GitHub `Release` workflow by default and exits non-zero if that workflow fails, so you do not need to check Actions manually after every cut.
- This wait uses `gh auth status` / `gh run ...` under the hood. If you intentionally want fire-and-forget behavior, set `EVB_RELEASE_SKIP_GITHUB_WAIT=1`.

## Why this is less brittle

- Validation, packaging, and publication now happen inside one workflow run.
- Release artifacts are downloaded from the same run that built them, so there is no cross-workflow run-id lookup or artifact certification handoff.
- Local release cutting no longer depends on `gh workflow run` orchestration to publish a tag.
- Slow or flaky `macos-15-intel` runners no longer hold the GitHub release hostage; they only affect the later Intel ZIP attachment.
