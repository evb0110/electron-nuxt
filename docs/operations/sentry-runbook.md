# Sentry operations runbook

This runbook applies to the `evb-viewer-desktop` and `evb-viewer-web`
projects. It never authorizes a broader event payload than the closed
`DiagnosticRecord` contract. Sentry is an error lead, not proof of a defect.

Do not record credential values, event payloads, private Sentry URLs, user
content, document names, local paths, or screenshots in this file, a GitHub
issue, or a canary record.

## Production enable gate

Production reporting stays disabled until every applicable item is complete:

- the DPA and the account checklist in `sentry-account-controls.md` are complete;
- the current privacy notice and, for Nitro, the legitimate-interests review
  are approved;
- source maps for the exact release and dist were uploaded before the canary;
- the public artifact scans and served-byte parity check pass;
- the relevant client-consent or server-objection test passes;
- the privacy sentinel and no-client-report lifecycle suites pass;
- the preview canary is safe, single-event, symbolicated, and actionable;
- pay-as-you-go remains disabled and the four alert classes below exist.

If a gate fails, omit the affected DSN from the build or deployment. A missing
DSN is the safe production state.

## Alerts

Create exactly these four alert classes. The owner is the repository owner.
Automatic GitHub issue creation and automatic Sentry resolution stay off.

| Alert class | Project and filter | Trigger | Exclusions |
| --- | --- | --- | --- |
| New or regressed fatal | Both projects, `environment:production`, level `fatal`, high-priority issue | First new or regressed issue | Preview, development, test, expected teardown, recovery already in progress |
| New diagnostic code | Both projects, `environment:production`, `diagnostic_code` present | New issue or resolved issue regression | Expected outcomes, cancellation, validation, unsupported input, ordinary offline behavior |
| Code rate | Both projects, `environment:production`, `diagnostic_code` present | More than 20 events in one issue within five minutes | Preview, development, test, and client-suppressed repeats |
| Quota | Organization usage | 50, 70, and 90 percent of the included event quota | No pay-as-you-go continuation |

Record completion without private links:

| Control | Owner | Verified date | State |
| --- | --- | --- | --- |
| Fatal alert | Repository owner | 2026-09-04 | Enabled |
| New-code alert | Repository owner | 2026-09-04 | Enabled |
| Rate alert | Repository owner | 2026-09-04 | Enabled |
| Quota alert | Repository owner | Pending | Pending |

## Weekly and post-release triage

Run this checklist once per week and after every production release that has
diagnostics enabled.

1. Confirm each issue has the expected project, `production` environment,
   immutable release, and exact dist.
2. Confirm the top in-app frame has an EVB source file, function, and line.
   Run the symbolication canary again before using an unsymbolicated stack.
3. Inspect only the allowlisted fields. If any forbidden field appears, stop
   ordinary triage and follow the privacy incident procedure below.
4. Check the diagnostic code and its burst threshold. Confirm that expected
   outcomes did not create events and that repeats were bounded.
5. Merge Sentry issues only when diagnostic code and application frames support
   one root cause. Similar UI text or timing is not enough.
6. Reproduce from repository code, tests, a public fixture, or a maintainer-made
   synthetic fixture. Do not copy event content into a fixture.
7. When actionable, create a GitHub issue manually. Include the diagnostic code,
   release, dist or platform, a safe application-frame summary, frequency,
   Error ID, and reproduction status. Apply exactly one difficulty label.
8. Link the GitHub issue in Sentry. Resolve the Sentry issue only after the fix
   ships and the affected production release stays clean through the next
   weekly review.
9. Delete resolved Sentry issues and their event data. Record only the deletion
   date and count below.
10. Check event quota and every alert. Investigate missing alerts, loops, and
    unexplained volume before enabling another release.

Weekly evidence template:

| Review date | Releases checked | Open issues reviewed | GitHub issues created | Resolved issues deleted | Forbidden fields | Symbolication | Quota | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pending | Pending | Pending | Pending | Pending | None expected | Pending | Pending | Repository owner |

## Privacy incident response

A raw message, raw stack string, console argument, breadcrumb, UI copy, file
path, URL, query, document content, AI text, request field, identity field,
attachment, minidump, replay, span, profile, metric, log, session item, or any
unrecognized field is a privacy incident.

1. Disable the affected runtime using the procedure below. Do not inspect more
   affected events than needed to establish the incident.
2. Preserve only the event identifier, diagnostic code, release, dist, dates,
   and control state needed for the incident record. Do not copy the forbidden
   value.
3. Delete the affected events and issues in Sentry.
4. Rotate the affected DSN client key. Rotate the upload token too if it may
   have been exposed.
5. Open a private remediation record. State the forbidden field category and
   source code path, never its value.
6. Fix the closed-contract or adapter backstop and add a sentinel regression
   test for the field category.
7. Re-run the full privacy, envelope, public-artifact, and source-map suites.
8. Re-enable preview only. Production needs a new clean canary and a fresh
   approval of every production gate.

## Disable diagnostics

Use this procedure for a privacy incident, quota loop, broken symbolication, or
unsafe account state.

1. Remove `SENTRY_DESKTOP_DSN` from every desktop build environment and GitHub
   Actions secret scope that can produce a release.
2. Remove `SENTRY_BROWSER_DSN` and `SENTRY_NITRO_DSN` from the Vercel preview
   and production environments as applicable.
3. Redeploy the viewer and rebuild affected desktop artifacts. Existing shipped
   desktop clients can also be stopped by disabling or rotating their Sentry
   client key.
4. Keep `SENTRY_AUTH_TOKEN` disabled until uploads are safe again. Removing the
   token alone does not disable an already built client.
5. Prove the resulting artifact or deployment makes zero Sentry requests under
   a synthetic error. Confirm local logging, Error IDs, red UI, recovery, save,
   print, update, relaunch, and shutdown still work.
6. Record date, affected runtimes, reason category, release, and verifier. Do
   not record secret values.

## Credential rotation

The runtime keys are separate for desktop, hosted browser, and Nitro. The upload
token is a fourth credential with only release and source-map upload scope.

1. Create one replacement credential at a time with the same origin and scope
   restrictions recorded in `sentry-account-controls.md`.
2. Store it in the same GitHub or Vercel scope as the old credential. Never pass
   a token on a command line or print it in a workflow log.
3. Build or deploy preview, upload exact private maps, and run the applicable
   zero-request, one-event, revocation or objection, CSP, and symbolication
   checks.
4. Promote the replacement to production only after preview passes.
5. Revoke the old credential and verify that it no longer accepts events or
   uploads.
6. Record the credential role, rotation date, verifier, and outcome. Do not
   record the value, key identifier, DSN, or private URL.

## Canary records

Canary events use synthetic faults and contain only the closed record. Record
counts and outcomes, not payloads or private account links.

### Desktop matrix

Run the consent, main, renderer, worker-parent, UI-only, direct-console,
startup-marker, symbolication, recovery, relaunch, update, shutdown, and
artifact-scan checks for every dist below.

| Dist | Release | Unknown requests | Denied requests | Granted event count | Revocation requests | Error ID matched | Symbolicated | Artifact scan | Behavior deadlines | Date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `macos-arm64` | `evb-viewer-desktop@0.1.450` test build | Pending | Pending | 228 source-map canaries | Pending | Pending | Pass for sampled main, renderer, and worker bundles | Public build roots map-free | Pending | 2026-09-04 |
| `macos-x64` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| `windows-x64` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| `windows-arm64` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| `linux-x64` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| `linux-arm64` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| `store-appx-x64` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| `store-appx-arm64` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| `win7-legacy-x64` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

Every request count under unknown and denied must be zero. A granted canary must
produce one envelope with one event item. Revocation must produce no queued,
close-time, or client-report envelope.

The macOS arm64 source-map run uploaded 280 private bundles. It sent 228
deterministic canaries for bundles with an EVB source mapping and recorded 52
generated or vendor-only chunks as ineligible for original-source proof. This
is source-map evidence only. It does not replace the packaged consent and
behavior matrix still marked pending in the same row.

### Hosted browser

| Deployment | Served-byte parity | Unknown requests | Denied requests | Granted event count | Revocation requests | CSP origin count | Error ID matched | Symbolicated | Date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Preview | Pass, protected exact-byte deployment | Pending | Pending | 256 private source-map canaries | Pending | One EU ingest origin in built CSP | Pending | Pass, sampled browser frame | 2026-09-05 |
| Production | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

The CSP origin count must be one for the exact EU ingest origin. Electron CSP
must remain unchanged.

The Preview source-map run uploaded 473 bundles from separate visible Vercel
`static` and `functions` roots. It sent 256 canaries for bundles with a usable
EVB mapping and recorded 217 generated or vendor-only bundles as ineligible.
The sampled browser canary resolved by Debug ID to
`app/composables/useRuntimeErrorReports.ts:16`, including source context, with
`symbolicated_in_app` true. This proves private-map symbolication only. The
unknown, denied, grant, revocation, and Error ID rows still require the hosted
browser behavior canary.

### Viewer Nitro

| Environment | Uncaught 500 count | Explicit-code counts | Objecting request count | Request-derived fields | Error ID matched | Symbolicated | Review period | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Preview | Pending | Pending | Pending | None expected | Pending | Pending | Pending | Disabled |
| Production | Pending | Pending | Pending | None expected | Pending | Pending | Pending | Disabled |

Run Nitro in preview first. Production remains disabled until the preview gate
and legal approval pass. Review preview and production canary data for one full
week before completing the Nitro canary.

## Four-week production proof

After every enabled runtime passes its canary, record four consecutive weekly
reviews. A failed measure opens a remediation issue and leaves the Sentry parent
issue open.

| Week | Enabled runtimes and releases | Volume within thresholds | Suppression correct | Quota healthy | Forbidden fields | Symbolication | Actionable outcomes | Remediation issue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Pending | Pending | Pending | Pending | None expected | Pending | Pending | None |
| 2 | Pending | Pending | Pending | Pending | None expected | Pending | Pending | None |
| 3 | Pending | Pending | Pending | Pending | None expected | Pending | Pending | None |
| 4 | Pending | Pending | Pending | Pending | None expected | Pending | Pending | None |

## Package-removal rehearsal

Run this rehearsal in a disposable worktree. Do not publish the rehearsal.

1. Remove the three Sentry runtime packages, the pinned CLI, the three adapter
   roots, and only their initialization and upload wiring.
2. Keep the diagnostic registry, reporters, receipts, consent setting, Error ID
   presentation, local logs, recovery, and typed IPC intact. Replace adapter
   construction with the existing no-op transport.
3. Run typecheck, unit tests, architecture checks, and the applicable packaged
   smoke tests.
4. Exercise startup, file open, save, export, print, update, renderer recovery,
   relaunch, shutdown, and one red UI failure. Each local behavior must remain;
   network inspection must show zero Sentry requests.
5. Remove the disposable worktree and record only the tested commit, date,
   gates, platforms, and result.

| Tested commit | Date | Gates | Platforms | Local behavior | Sentry requests | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `f39a0e2d6fcb3610f96fcde81496a9dc5108483d` | 2026-09-04 | Typecheck, 10,876 unit tests, architecture, desktop build, package, packaged core PDF smoke | macOS arm64 | Startup, PDF open, annotation save, metadata-preserving rotation, source isolation, search, and shutdown passed; print, export, updater download, recovery relaunch, and fatal dialog were not exercised | Zero structurally possible; packages, adapters, ingest endpoint, upload commands, and credentials were absent, but no packet-capture proxy was used | Partial pass; repeat the omitted behaviors before calling the full rehearsal complete |
