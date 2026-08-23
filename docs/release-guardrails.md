# Release guardrails reference

Detailed guardrails, platform caveats, and runbooks behind the short flow in
[`releasing.md`](./releasing.md). Read the section you are touching; nothing
here is required reading for an ordinary cut.

## Local verification (`--full-verify` and on-demand)

- `pnpm run release:verify` mirrors the local parts of the release workflow, includes current-platform build and packaging verification, and fails if the successful verify run changes the working tree snapshot.
- `release:verify:checks` forces `CI=1` during clean app-scoped linting, split static report/assets checks, clean typechecking, Electron install verification, native-resource matrix checks, WASM portability checks, lint-owned architecture checks, Rust tests, unit coverage, Electron bundle static-integrity checks, and the single strict build.
- `pnpm run release:verify:package:local` owns the current-platform package proof: it accepts an exact verified build receipt from the combined verifier or performs a fresh strict build when invoked alone, then packages as the release workflow would, validates artifacts/updater metadata, verifies packaged native tools, and verifies packaged startup on macOS. Use `pnpm run test:electron-bundle-static-integrity:no-build` for a no-build static-integrity loop against existing `dist-electron/`.
- Changed or file-scoped local loops (for example `pnpm exec vitest run --changed origin/main ...`, `pnpm exec fallow dead-code --changed-since origin/main`) are iteration aids. They do not replace `pnpm run release:verify` for release proof.
- `pnpm run release:verify` is intentionally host-only for packaging. If you change cross-platform launcher or packaging decisions, add unit coverage for that branching logic instead of assuming a macOS-local release cut exercises Linux and Windows paths.
- Fresh installs follow the checked-in build-script policy in [`pnpm-workspace.yaml`](../pnpm-workspace.yaml). If a new dependency needs an install script for release-critical behavior, update that allow/ignore list deliberately instead of tolerating pnpm's warning output.
- Main app release checks are app-scoped and do not read or build `landing/`. Landing-only working tree changes are ignored by the release cutter so the desktop/web app release path stays independent of the separate landing deploy.
- Broad maintenance checks (`typecheck:coverage` and the cold lint/typecheck variants) run in scheduled nightly CI and do not block release cutting; the coverage zero-execution tripwire is blocking and runs in push CI's quality lane. Long serial Electron E2E and PDF tab diagnostics live in nightly/manual diagnostics.

## macOS signing, startup, and Gatekeeper

- The macOS packaged-startup step is meaningful only when local packaging uses real Developer ID credentials. Ad-hoc local signing still verifies bundled native-tool execution, but it does not faithfully reproduce LaunchServices/runtime-library-validation behavior for a shipped `.app`.
- After producing a signed macOS candidate, run `bash scripts/verify-macos-packaged-reactivation.sh mac <arm64|x64>` from the repository root. The diagnostic targets only `release/mac-<arch>/EVB Viewer.app`, launches a tokenized isolated profile, requires Accessibility access, and proves 20 Finder-to-LaunchServices foreground cycles plus minimized and hidden recovery. It closes the last window and requires the same macOS process to remain alive and recreate a window when activated, then explicitly terminates the app, requires its Electron process tree to exit, proves the bundle can be moved for replacement, and unregisters that exact workspace bundle from LaunchServices. It retains its main/window logs below `.devkit/test/macos-packaged-reactivation/` and terminates only the PID whose command contains the exact packaged executable and unique token. On a non-CI Mac it refuses to run without `EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST=1`, snapshots the Dock first, and removes only a matching test-path Dock item that did not pre-exist. Accessibility-denied hosts exit without weakening the assertions; keep this lane in a macOS manual/nightly environment with the permission pre-granted.
- The scripted reactivation matrix does not claim to automate the 30-minute soak, system sleep/wake, display or Space changes, or opening a user-selected document from Finder. Perform those checks manually against the same signed candidate with no installed production or development instance in scope, and record the evidence before a release whose macOS focus behavior changed.
- `codesign --verify` is not enough for macOS release safety. The GitHub mac packaging lanes must also pass `spctl --assess --type execute`, otherwise a bundle can look internally valid while still being rejected or crashing at launch on end-user machines.
- The signed macOS LaunchServices gate must start from a disposable copy of the final DMG, apply browser-download quarantine, mount it, copy the app to a disposable install location, and launch that installed copy. Launching the unpacked `release/mac-<arch>` bundle does not exercise Gatekeeper's first-launch execution policy. The diagnostic refuses local production-identity runs unless `EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST=1` is set after explicit approval, unregisters the mounted source bundle before detaching the DMG, and unregisters its exact disposable app path during cleanup.
- On macOS, packaged native-tool verification must execute the bundled tools from inside the signed app resources, not just inspect file presence or `otool` output. That is how we catch Team-ID/library-validation regressions in bundled DjVuLibre, Poppler, qpdf, and Tesseract payloads before tag push.
- The macOS PDF-tool bundler treats missing Homebrew binaries/libraries, failed install-name rewrites, and residual Homebrew references as fatal; it must never publish a partial Poppler/qpdf resource tree.

## Signing and updater-feed policy

- Public releases require the macOS Developer ID and notarization secrets. Artifact-only builds may remain ad-hoc signed and must still build and launch correctly.
- Ad-hoc macOS artifact builds are manual-install only. GitHub builds prune `latest-mac*.yml` and `.blockmap` for ad-hoc mac bundles so the updater feed cannot mix signed and ad-hoc framework blocks.
- Windows signing secrets are optional for public releases. Unsigned Windows releases are manual-install only: GitHub builds prune `latest*.yml` and `.blockmap` unless the Windows artifact is the signed x64 updater target.
- The release publish step must tolerate zero updater metadata files. Some releases are intentionally download-only across every platform.
- Distribution decisions must remain compatible with an individual, free, non-commercial project. Treat any business identity, paid account, or account conversion requirement as an explicit owner decision rather than an assumed release prerequisite.

## Artifact-only flow

- Run `pnpm run release:artifacts` from a clean worktree to have GitHub build the release artifacts without cutting a release. It uses the same preflight, clean-worktree, upstream, and publication-policy checks as the cutter, then dispatches [`Build Release Artifacts`](../.github/workflows/release-artifacts.yml) for the exact pushed commit.
- The workflow runs the focused release checks only when the target SHA has no successful exact-SHA push-CI `gates_ok` run (for example a branch commit); a CI-vouched commit goes straight to packaging. It packages the core matrix, the supplemental macOS Intel and Windows 7 legacy lanes, and Store AppX with `submit: false`, applying the same packaged native-tool and ASAR/content verification as release lanes.
- It never creates a tag, a GitHub Release, release assets, or Store submissions. Downloads live as GitHub Actions artifacts on the workflow run.

## Manual Microsoft Store submission

Use this when GitHub built Store AppX artifacts but Partner Center API submission is not configured, or when a human wants to inspect the draft before certification. Keep account-specific IDs, portal screenshots, submission IDs, and live troubleshooting notes out of tracked docs.

1. Download both Store package artifacts from the workflow run: `gh run download <run-id> -n store-appx-win-x64 -n store-appx-win-arm64`
2. Upload `store-appx-win-x64/EVB-Viewer-<version>-x64-store.appx` and `store-appx-win-arm64/EVB-Viewer-<version>-arm64-store.appx`.
3. In Partner Center, follow Microsoft's manual submission flow: create a draft update, upload the packages in the Packages section, complete required sections, and submit for certification. See [Create app submission for MSIX apps](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission) and [Upload MSIX app packages](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages).
4. Do not mix Partner Center edits with a submission created through the [Microsoft Store submissions API](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions). Keep a submission on one path: manual Partner Center or API.

Store AppX packages must declare every shipped UI locale in `electron-builder.yml`. The Store workflow validates those manifest resources so Partner Center can offer matching localized listings.

## Publication policy gate

`scripts/check-commit-attribution.mjs` is the single gate on what becomes public: the pre-commit hook checks the staged tree, the pre-push hook checks everything a push would newly publish (including annotated tag objects), the release cutter and the artifact-only flow run it before their push, and CI reruns it for pushes and pull requests. It rejects prohibited commit attribution and the local-only artifacts listed in `scripts/lib/local-artifact-policy.mjs`.

In CI, `--pushed-range <before> <head>` scans `before..head` when the before SHA is reachable, and otherwise scans the complete history of the pushed head. An absent SHA, a zero OID, and — after a force history rewrite — an unreachable SHA all take that wider path. This is intentional and fail-closed. The authorized public-history rewrite must remove agent instruction files and local-only directories from every public head and tag. After that rewrite has been validated and published, a full-history scan of a rewritten branch passes, and keeping it full prevents the purged content from re-entering public history through a later force push.

Until the rewrite is published, a complete-history scan is expected to report the legacy artifacts. After publication, a local branch created from the old history still contains them and will fail the gate. Rebase or cherry-pick its work onto the rewritten `main`, or rewrite the branch itself (`git rebase --onto`, `git filter-repo`) so no reachable commit adds those paths. Do not narrow the scanned range, skip the hook, or otherwise bypass the gate to push such a branch.

## Landing rollout, withdrawal, and rollback

The landing download endpoint selects from the public GitHub release list; it does not trust GitHub's mutable `latest` flag. Configure the deployed landing service with:

- `NUXT_RELEASE_STABLE_TAGS`: comma-separated, preference-ordered stable tags. The first available, non-withdrawn tag is served. Leave empty only for newest-public-release compatibility mode.
- `NUXT_RELEASE_WITHDRAWN_TAGS`: comma-separated tags that must never be served.
- `NUXT_RELEASE_CANARY_TAG` and `NUXT_RELEASE_CANARY_PERCENT`: an optional public canary and deterministic cohort percentage from 0 through 100.

To withdraw a bad release, add its tag to `NUXT_RELEASE_WITHDRAWN_TAGS`, put the prior known-good tag first in `NUXT_RELEASE_STABLE_TAGS`, set the canary percentage to zero, deploy the configuration, and verify `/api/releases/latest` from multiple user-agent/cohort keys. Keep the withdrawn release excluded until a replacement has passed the packaged smoke and downloaded-asset hash checks. Rollback is a server configuration change and does not require republishing or mutating old GitHub assets.

## Command behavior notes

- The release and artifact-only commands stop after the dispatched GitHub workflow run is visible; GitHub owns the remote matrix from that point.
- If GitHub takes longer than usual to surface a just-dispatched run, set `EVB_GITHUB_WORKFLOW_START_TIMEOUT_MS` to a larger positive integer.
- The publish-chain jobs (draft, checksums, mirror, promote, Intel attach) execute only during release runs. Latent defects there surface at release time by construction; the same-SHA repair path (re-run failed jobs, or re-dispatch the same tag and target) is the designed, proven recovery.
