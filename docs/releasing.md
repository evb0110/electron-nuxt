# Releasing

Releases are cut locally and published by dispatching the GitHub
[`Release`](../.github/workflows/release.yml) workflow, which creates the
version tag for the target commit. Release-commit push CI's `gates_ok` is the
validation authority: the release workflow resolves a green target, packages,
verifies artifacts, and publishes — it revalidates nothing.

## Normal flow

1. Run `pnpm run release:cut -- patch` (or `minor` / `major`).
2. When the pre-bump `HEAD` is the advertised `origin/main` tip, the cut skips
   the duplicate local release gate and reaches dispatch in minutes. Preflight,
   the version bump, and the publication-policy scan always run. The version
   change touches `package.json`, which triggers full exact-SHA push CI. Pass
   `--full-verify` to get earlier local feedback after changing packaging
   configuration such as electron-builder, bundlers, or native tool packaging.
3. The workflow waits for the release commit's own push CI to finish; the
   wait budget is policy-tested to stay ahead of the slowest blocking CI
   lane's declared timeout, so an immediate post-push dispatch self-serves
   the wait (issue #109). It then builds the
   four-target core matrix, stages and finalizes the draft with `SHA256SUMS`
   and provenance attestations, stages the mirror, and promotes. The macOS
   Intel ZIP and Windows ARM64 installer and provenance record attach afterward.
   The local command exits once the run is visible and prints its URLs.

## Critical-path rule

- Publish as soon as the core matrix is done: macOS arm64, Linux x64/arm64,
  and Windows x64. Nothing else may gate `publish` or `promote_release`.
- Supplemental lanes attach or run afterward. The `macos-15-intel` ZIP and
  Windows ARM64 installer and provenance record attach post-promotion. They
  stay outside the immutable `SHA256SUMS` set, tolerated via
  `isSupplementalReleaseAsset` in `scripts/release/policy.mjs`. Windows 7
  legacy is best-effort. Store AppX packaging runs in parallel with promotion.
  Partner Center comparison and submission wait for the Windows ARM64 attachment
  because they require its verified direct provenance record.
- Advisory-by-evidence gates stay advisory: the Windows ARM64 NSIS installed
  journey and the packaged scan-cleanup verifier annotate and upload evidence
  without blocking (their contracts are pinned in the required local gate, for
  example `scanCleanupToolbarContract.e2e.test.ts`).

## Anti-accretion rule

A release-failure fix may add provisioning or diagnostics, but a new
*blocking* gate must name an existing blocking gate it demotes or deletes.
Incident-response guards start advisory (`continue-on-error` plus a warning
annotation) and are promoted only after catching a real defect twice. Prefer a
cheap contract in the required local full gate over any release-time-only
proof. Every blocking CI lane's `timeout-minutes` is its duration
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
- An infrastructure flake does not require a new commit or version. Re-run the
  same SHA and tag. Any code or workflow repair creates a new commit, so cut a
  new version. Its package metadata change starts exact-SHA hosted CI. Never
  bump the version only to retry an infrastructure failure.

## Pointers

- Detailed guardrails, macOS signing/Gatekeeper runbooks, the artifact-only
  flow, manual Store submission, the publication-policy gate, and landing
  rollout/rollback: [`release-guardrails.md`](./release-guardrails.md).
