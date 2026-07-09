# Releasing

Releases are cut locally and published by dispatching the GitHub Release workflow, which creates the version tag for the target commit.

## Normal flow

1. Run `pnpm run release:patch`, `pnpm run release:minor`, or `pnpm run release:major`.
   The release script now fails before the version bump unless it is running under the Node major pinned in `package.json` `engines.node`, which is the project's current latest-LTS baseline (currently `24.x`).
2. The script bumps `package.json`, then runs the local release gate against that exact would-be tagged tree. The gate is split into the CI-mode lint/static/test phase (`release:verify:checks`) and the current-platform build/package phase (`release:verify:package:local`): strict build, packaging, updater metadata checks when applicable, packaged native-tool verification, packaged startup verification on macOS, and host native-resource verification.
3. If that local release gate passes, the script verifies that only `package.json` changed, commits the release version, pushes the branch update, and dispatches the GitHub [`Release`](../.github/workflows/release.yml) workflow with the intended tag and target ref.
4. The release workflow reruns the focused release checks, packages the main artifacts, creates the matching `v*` tag, and publishes the release in one run.
5. The local command exits after the GitHub Actions run is visible. It prints the run URL, the future artifact section URL, the future release URL, and the expected artifact group names.

## Artifact-only flow

- Run `pnpm run release:artifacts` from a clean worktree when you want GitHub to build the release artifacts without cutting a release.
- The command uses the same Node/GitHub CLI preflight, clean-worktree check, named-branch/upstream check, and branch push handoff as the release cutter, then dispatches [`Build Release Artifacts`](../.github/workflows/release-artifacts.yml) for the exact pushed commit.
- The artifact-only workflow reruns the focused release checks, packages the same core release matrix, runs the supplemental macOS Intel and Windows 7 legacy lanes, and builds Store AppX packages with `submit: false`.
- It never creates a tag, creates or updates a GitHub Release, uploads release assets, or submits Store packages. Downloads live as GitHub Actions artifacts on the workflow run.

## Manual Microsoft Store submission

Use this when GitHub built Store AppX artifacts but Partner Center API submission is not configured, or when a human wants to inspect the draft before certification. Keep account-specific IDs, portal screenshots, submission IDs, and live troubleshooting notes out of tracked docs.

1. Download both Store package artifacts from the workflow run:
   `gh run download <run-id> -n store-appx-win-x64 -n store-appx-win-arm64`
2. Upload these package files from the downloaded artifact directories:
   - `store-appx-win-x64/EVB-Viewer-<version>-x64-store.appx`
   - `store-appx-win-arm64/EVB-Viewer-<version>-arm64-store.appx`
3. In Partner Center, follow Microsoft's manual submission flow: create a draft update from the product overview, open the Packages section, upload the packages, complete required submission sections, and submit for certification. See [Create app submission for MSIX apps](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission) and [Upload MSIX app packages](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages).
4. Do not mix Partner Center edits with a submission created through the [Microsoft Store submissions API](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions). Keep a submission on one path: manual Partner Center or API.

## Local guardrails

- `pnpm run release:verify` mirrors the local parts of the release workflow, includes current-platform build and packaging verification, and fails if the successful verify run changes the working tree snapshot.
- `release:verify:checks` forces `CI=1` during app-scoped linting, split static report/assets checks, typechecking, Electron install verification, native-resource matrix checks, WASM portability checks, lint-owned architecture import checks, Rust tests, unit coverage, and bundle-integrity checks so the local gate stays closer to the GitHub release runner.
- `pnpm run release:verify:package:local` owns the strict build and current-platform package proof: it packages the current platform exactly as the release workflow would, validates produced artifacts and updater metadata, verifies packaged native tools, and verifies packaged startup on macOS. After that build has produced `dist-electron/`, use `pnpm run test:bundle-integrity:no-build` for a no-build bundle-integrity loop; use `pnpm run test:bundle-integrity` when you want its script-managed build, prune, and hygiene wrapper.
- Manual CI quality lanes run the split quality sequence directly, then coverage, native Rust tests, and landing checks on demand; nightly maintenance keeps the broader deterministic coverage running outside the local patch-cut path.
- Main app release checks are app-scoped and do not read or build `landing/`. Landing-only working tree changes are ignored by the release cutter so the desktop/web app release path stays independent of the separate landing deploy.
- Broad maintenance checks (`typecheck:coverage`, `fallow`, the coverage ratchet, OCR model registry, and Python page-processor smoke) remain part of scheduled nightly CI, but they do not block every local release cut. The page-processor smoke is retained as dormant devkit-tool maintenance coverage, not as a local release gate.
- Release-critical tests should stay deterministic and fast. Long serial Electron E2E and PDF tab diagnostics are available in nightly/manual diagnostics, but they do not block release cutting.
- Changed or file-scoped local loops, including `pnpm run validate:changed`, `pnpm run test:changed`, `pnpm exec vitest run --project unit-policy tests/unit/scripts/releasePolicy.test.ts`, `pnpm run fallow:changed`, and `pnpm run test:bundle-integrity:no-build`, are iteration aids. They do not replace `pnpm run release:verify` for release proof.
- Fresh installs now follow the checked-in build-script policy in [`pnpm-workspace.yaml`](../pnpm-workspace.yaml). If a new dependency needs an install script for release-critical behavior, update that allow/ignore list deliberately instead of tolerating pnpm's warning output.
- `pnpm run release:verify` is intentionally host-only for packaging. If you change cross-platform launcher or packaging decisions, add unit coverage for that branching logic instead of assuming a macOS-local release cut exercises Linux and Windows paths.
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
- If local `release:verify` changes any tracked, staged, or untracked file, treat that as a release-script regression and fix it before retrying. The cutter also refuses to auto-stage unexpected release changes.

## Release command behavior

- The release and artifact-only commands stop after the dispatched GitHub workflow run is visible, because GitHub owns the remote matrix from that point onward.
- The handoff poll uses `gh auth status` / `gh run ...` under the hood. If GitHub takes longer than usual to surface a just-dispatched run, set `EVB_GITHUB_WORKFLOW_START_TIMEOUT_MS` to a larger positive integer.

## Why this is less brittle

- Validation, packaging, and publication now happen inside one workflow run.
- Release artifacts are downloaded from the same run that built them, so there is no cross-workflow run-id lookup or artifact certification handoff.
- Local release cutting dispatches one focused `gh workflow run` for the release workflow instead of relying on a tag-push trigger or cross-workflow artifact lookup.
- Slow or flaky `macos-15-intel` runners no longer hold the GitHub release hostage; they only affect the later Intel ZIP attachment.
