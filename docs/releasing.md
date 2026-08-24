# Releasing

Releases are cut locally and published by dispatching the GitHub
[`Release`](../.github/workflows/release.yml) workflow, which creates the
version tag for the target commit. Push CI's `gates_ok` is the single
validation authority: the release workflow resolves a green target, packages,
verifies artifacts, and publishes — it revalidates nothing.

## Normal flow

1. Run `pnpm run release:cut -- patch` (or `minor` / `major`).
2. When the pre-bump `HEAD` is the advertised `origin/main` tip with a green
   `gates_ok` push-CI run, the cut skips the local release gate and reaches
   dispatch in minutes. Preflight, the version bump, and the publication-policy
   scan always run. Pass `--full-verify` to force the full local gate after
   changing packaging configuration (electron-builder, bundlers, native tool
   packaging); without the fast path the full gate runs automatically.
3. The workflow waits for the release commit's own push CI to finish; the
   wait budget is policy-tested to stay ahead of the slowest blocking CI
   lane's declared timeout, so an immediate post-push dispatch self-serves
   the wait (issue #109). It then builds the core
   five-target matrix, stages and finalizes the draft with `SHA256SUMS` and
   provenance attestations, stages the mirror, promotes, and attaches the
   supplemental Intel ZIP afterward. The local command exits once the run is
   visible and prints its URLs.

## Critical-path rule

- Publish as soon as the core matrix is done: macOS arm64, Linux x64/arm64,
  Windows x64/arm64. Nothing else may gate `publish` or `promote_release`.
- Supplemental lanes attach or run afterward: the `macos-15-intel` ZIP attaches
  post-promotion (outside the immutable `SHA256SUMS` set, tolerated via
  `isSupplementalReleaseAsset` in `scripts/release/policy.mjs`); Windows 7
  legacy is best-effort; Store AppX runs in parallel with promotion.
- Advisory-by-evidence gates stay advisory: the Windows ARM64 NSIS installed
  journey and the packaged scan-cleanup verifier annotate and upload evidence
  without blocking (their contracts are pinned continuously in push CI, for
  example `scanCleanupToolbarContract.e2e.test.ts`).

## Anti-accretion rule

A release-failure fix may add provisioning or diagnostics, but a new
*blocking* gate must name an existing blocking gate it demotes or deletes.
Incident-response guards start advisory (`continue-on-error` plus a warning
annotation) and are promoted only after catching a real defect twice. Prefer a
cheap continuously-running contract in push CI over any release-time-only
proof: release-path code that never executes between releases is where
campaigns die. Every blocking CI lane's `timeout-minutes` is its duration
budget, pinned by the topology policy test at roughly twice measured
reality: an addition that outgrows its lane fails the commit introducing
it, and raising a budget is a deliberate, reviewed edit that also feeds
the release wait-budget assertion.

## Recovery flow

- For an infrastructure flake, the first action is "Re-run failed jobs" on the
  same run. Same-tag repair is fully supported: `prepare` accepts an existing
  tag at the requested SHA, `publish` reconciles an existing finalized draft,
  and mirror objects are content-addressed — a fresh dispatch with the same
  tag and target SHA resumes where the failure happened.
- Only a code or workflow defect requires a new commit, and only a defect in
  the release commit itself requires a new version. Never bump the version to
  retry an infra failure.

## Pointers

- Detailed guardrails, macOS signing/Gatekeeper runbooks, the artifact-only
  flow, manual Store submission, the publication-policy gate, and landing
  rollout/rollback: [`release-guardrails.md`](./release-guardrails.md).
