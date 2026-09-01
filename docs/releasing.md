# Releasing

Run one command from a clean, green `main` checkout:

```sh
pnpm run release:cut patch
```

Use `minor` or `major` when that is the intended version change.

## What the command checks

Before changing `package.json`, the cutter checks the following.

- The checkout is clean, the branch is `main`, and `HEAD` equals freshly fetched `origin/main`.
- `ci.yml` passed for that exact `HEAD`. A running check is awaited. Every push to `main` runs `ci.yml`, so a `HEAD` without a run is one whose run has not appeared yet; the cutter waits up to a minute for it.
- The current-version GitHub release is not a draft, and the next tag does not exist.

The cutter then writes only the new package version and creates `release: <version> [skip ci]`. The commit is pushed and `release.yml` is dispatched with that commit SHA. The command stops after the workflow appears and prints the run and release links.

The release workflow waits for exact-SHA CI. For a version-only release commit with `[skip ci]`, it accepts a successful `gates_ok` run from the parent commit. Core packaging, checksum creation, mirror staging, and public promotion run in the core release workflow.

The supplemental workflow attaches the macOS Intel ZIP, Windows ARM64 installer and provenance, and Store results after promotion. It is dispatched automatically and can be rerun with:

```sh
gh workflow run release-supplemental.yml -f tag=vX.Y.Z
```

`pnpm run release:verify` remains available as a developer tool when a packaging change needs local proof. It is not part of `release:cut`.

## Check a release

Use the read-only status command for one-screen state:

```sh
pnpm run release:status vX.Y.Z
```

It reports the tag, draft or public release state, publication time, core and supplemental assets, `SHA256SUMS`, both workflow runs, and the mirror pointer when local mirror credentials are configured. Exit code 0 means the public core release is complete. Exit code 1 means it is not.

## Resume a failed release

Use resume only from the release commit for the current package version:

```sh
pnpm run release:resume
```

Resume checks that `HEAD` is the version-only release commit and that it exists on `origin/main`. A stale draft is deleted before the same tag and release SHA are dispatched again. An already-public release is not redispatched. Check it with `release:status` and repair only the missing supplemental work.

## When a release run is red

| Failing job or area | Action |
| --- | --- |
| `prepare` or exact-SHA CI | Inspect the run URL. Every push to `main` runs `ci.yml`, so a release parent without a run means its push run was cancelled or never appeared; check the Actions page for that commit. Only push runs count; a `workflow_dispatch` run of `ci.yml` executes the manual lanes and carries no `gates_ok`. A target with code changes needs a new green commit and version. |
| Core package, validate, checksum, mirror, or promotion job | Rerun failed jobs on the same run. If a stale draft remains, run `pnpm run release:resume` from the release commit. Do not create a new version for an infrastructure retry. |
| macOS Intel, Windows ARM64, or Store supplemental job | The core release can remain public. Check the missing assets with `release:status`, then rerun `gh workflow run release-supplemental.yml -f tag=vX.Y.Z`. |
| A release is already public but the status is incomplete | Keep the tag. Repair the named missing asset or supplemental workflow and use `release:status` again. |
