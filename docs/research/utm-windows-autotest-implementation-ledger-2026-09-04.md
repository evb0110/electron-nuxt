# UTM Windows autotest implementation ledger

Date: 2026-09-04

Source plan: [utm-windows-autotest-plan-2026-09-04.md](utm-windows-autotest-plan-2026-09-04.md).

Repository baseline: `ce8e95c082abc752446e507f13ed7affe28f66b6`.

## Purpose

This ledger turns the plan into bounded packages with closure gates and records
their state. It is a plan and closure record, not proof that any package has
run. Every package below is open. The plan stays the design reference; status
changes belong here, and the plan's own status line changes only when M1
closes.

The ledger separates package state, invariants that every package must
preserve, the initial critical-suite registry, the open-question matrix, and
proposals that reviews already declined so nobody re-proposes them by accident.

## Baseline and publication boundary

- Planning baseline: `main` at `ce8e95c08`, clean apart from the untracked plan.
- Creating this ledger and correcting the plan changed documentation only. No
  tool was installed, no VM was created, cloned, started, stopped or deleted,
  and no schedule was enabled.
- The only host operations run while verifying the plan were read-only: two
  `utmctl` probes that failed with OSStatus -1743 before reaching UTM, one
  `plutil` read of the personal VM configuration, and version reads from the
  installed UTM bundle.
- The personal VM's UUID and bundle path belong in the host config allowlist
  under the proposed data root, never in this repository.
- Implement each package directly on `main` under the repository rules. Ship
  runner code, registry entries, documentation and tests together per package.
  Do not combine independent packages to save commits.

## State vocabulary

| State | Meaning |
| --- | --- |
| Planned | Design and closure gates are concrete; no implementation commit exists. |
| Evidence first | Run the named experiment or oracle before writing runner or product code. |
| Blocked | A recorded prerequisite failed or is unproven. Do not start. |
| In progress | An implementation commit exists but closure gates are incomplete. |
| Qualified | Every closure gate has linked evidence in this ledger. |
| Declined | Reviewed and rejected. Do not re-propose without new evidence. |
| Invariant | A safety property every package must preserve. |

## Invariants

| ID | Invariant | Plan section |
| --- | --- | --- |
| I1 | The recovered personal VM, registered under the display name `Windows`, is never a clone source, test target, delete target or force-stop target. Destructive operations require the allowlisted test UUID and a bundle path under the test-image root. | 2, 6 |
| I2 | Acceptance runs keep CSP, renderer sandbox, UAC, Defender real-time protection and TLS validation intact. `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-web-security` and certificate-error suppression are rejected. | 4 |
| I3 | A host CLI exit code is transport evidence only. Success requires a validated guest completion record whose run, boot and artifact identities match the job. | 5 |
| I4 | The first result of a run is preserved. A rerun gets a new run ID and never replaces a failed result in metrics or reports. | 10, 11 |
| I5 | Cleanup is limited to owned processes, identified by PID plus start time plus executable, and owned print jobs. Nothing is killed by name. | 11 |
| I6 | No self-hosted runner on this Mac serves pull requests or arbitrary branches. Trusted dispatch is outbound-only with artifact digest verification. | 9 |
| I7 | A locally patched `app.asar` is diagnosis, never release certification. Every result binds to source SHA, artifact hash, signing mode, OS and app architectures and image ID. | 9 |
| I8 | Coverage is reported per capability and environment with an explicit denominator. Hardware, native x64, legacy and manual obligations are never counted as passed. | 7, 10 |
| I9 | The UI worker runs in the logged-on user's interactive session. A Session 0 or locked-desktop launch is an infrastructure failure, not a user journey. | 5 |

## Packages

### M0a image and transport

Status: Planned

Owner roles: Windows/VM maintainer, infrastructure engineer.

Depends on: nothing. This is the first package, and M0b may run in parallel
once a stopped clone exists.

Proposed location: `scripts/windows-test/images/`, `scripts/windows-test/host/`.

Closure gates:

- [ ] Golden image built from a fresh Windows 11 Pro ARM64 installation with
      Microsoft media and nonproduction accounts. Licensing, activation and
      device-encryption state recorded in the image manifest.
- [ ] Clone yields a distinct UUID, bundle path, MAC address, hostname and
      guest test marker. `utmctl list` before and after shows exactly one new
      UUID. The personal VM is refused by UUID and by path.
- [ ] Full reset unit (disk, configuration, EFI variables, TPM state,
      removable media, manifest) restores a bootable clone three consecutive
      times. BitLocker state after restore recorded.
- [ ] Automatic guest sign-in qualified on the isolated image: three cold-reset
      cycles reach an unlocked interactive desktop with no assistance.
- [ ] Worker handshake reports boot ID, SID, session ID, integrity level and
      input desktop. A Session 0 launch is rejected.
- [ ] Mailbox ACLs validated cross-session. Stale run ID, unsupported schema,
      path outside root, duplicate run and artifact hash mismatch are rejected.
- [ ] Delayed-success and nonzero-failure `exec` probes prove a premature CLI
      return cannot yield a pass. Stale output from a prior boot is rejected.
- [ ] Automation consent probed from every launcher that will run the
      coordinator, starting with Terminal. `doctor` reports launcher, consent
      state and raw OSStatus rather than the CLI's SSH message.
- [ ] Visible, occluded and minimized UTM window states plus host lock and
      guest session loss each classified as qualified or infrastructure failure.
- [ ] Installer and fixture transfer throughput measured. If QGA is too slow,
      the hash-verified fixture disk or ISO fallback is chosen and recorded.
- [ ] Lease acquisition, stale-owner recovery and `stop --run` from a second
      terminal tested, including a gone owner and a hung worker.

Blocking rule: if automatic sign-in cannot qualify on the isolated image, set
this package to Blocked, do not start M1, and record the evaluated alternative
Windows environment. Assisted runs do not close this package.

Evidence: none.

### M0b native UI feasibility

Status: Evidence first

Owner role: Windows UI test engineer.

Depends on: a stopped clone from M0a (the reset and sign-in gates need not be
closed for the POC).

Proposed location: `tests/windows/native-ui/`.

Closure gates:

- [ ] Microsoft WinApp CLI v0.6.0 pinned and run on the ARM64 guest. Release,
      command schema, distribution license and Electron tree visibility
      recorded. If it fails the POC, the FlaUI UIA3 helper is qualified behind
      the same adapter contract.
- [ ] Real Print dialog tree and Save/Open picker tree enumerated on the image
      and stored as versioned selector records keyed by process ownership,
      control type, automation ID and pattern. Localized names are fallback only.
- [ ] One complete print journey and one native file-picker journey driven with
      guest UIA and keyboard only, no CDP, against the installed executable
      launched without debugging flags. Output verified by the host oracle.
- [ ] Cancel path leaves no stray output, orphan window or stuck print job.
- [ ] Ambiguous selector fails safely. Locked or missing desktop reports
      infrastructure failure, and pattern-only actions are labeled separately
      from injected input.
- [ ] Same journeys repeated with the x64 build under emulation, or recorded
      as unsupported for that environment.
- [ ] Chromium GPU status and whether Electron exposes native UIA or an
      accessibility proxy recorded, without inferring it from the virtual
      display device.

Evidence: none.

### M1 regression slice

Status: Planned

Owner roles: Electron test engineer, desktop test engineer.

Depends on: M0a and M0b Qualified.

Proposed location: `scripts/windows-test/guest/`, shared test contracts, the
repository commands in plan section 10.

Closure gates:

- [ ] Package scripts `windows:test`, `windows:test:doctor`,
      `windows:test:report` and `windows:test:stop` exist with the documented
      exit codes 0 to 6.
- [ ] Host data root, config allowlist, candidate manifest and bounded report
      directory exist outside the source checkout. Credentials are in host
      secret storage.
- [ ] WIN-SAVE-01 and WIN-PRINT-01 fail against official 0.1.450 at least three
      times each, with the failure classified as product failure.
- [ ] The fixed artifact passes ten consecutive fresh-clone runs with no human
      intervention.
- [ ] A separate no-debug launch covers package identity and first-run
      behavior.
- [ ] Runner tests feed malformed, missing and stale result files, wrong
      artifact hashes, a zero-exit error response, an absent desktop and a
      crashed worker. Each is rejected.
- [ ] First failure evidence remains inspectable after the next run.
- [ ] Second run from a new terminal and a run on a later day succeed from the
      documented command alone. Removing a required dependency produces a
      useful `doctor` failure.
- [ ] Human contact-sheet review obligation reported separately from the
      automated result.

Evidence: none.

### M2 packaging and critical suite

Status: Planned

Owner roles: Electron test engineer, test maintainer, module owners.

Depends on: M1 Qualified.

Closure gates:

- [ ] NSIS per-user install by the standard-user worker, AppX install for both
      architectures, and the x64-under-ARM variant each have explicit pass or
      uncovered status.
- [ ] Remaining initial critical cases (WIN-SAVE-02, WIN-SAVE-04, WIN-SAVE-08,
      WIN-PRINT-02, WIN-PRINT-07, WIN-UI-02, WIN-TOOLS-01) implemented with
      negative controls proven.
- [ ] `tests/windows/capabilities.json` registry exists with a lint that
      rejects missing tests, duplicate IDs, empty oracles and skipped required
      cases.
- [ ] Change-area selector maps Electron, print/CSP, revision, native tools,
      installer and path changes to suites, with a smoke that runs regardless.
- [ ] No native-dialog case is satisfied by an internal API substitute.

Evidence: none.

### M3 nightly breadth

Status: Planned

Owner roles: CI maintainer, PDF/native engineer.

Depends on: M2 Qualified and two weeks of advisory observation.

Closure gates:

- [ ] P1 families implemented per the catalogue, including deterministic
      transaction faults and the environment variants in plan section 3.
- [ ] Independent host oracles with recorded versions and provenance.
- [ ] Restore and recovery tests, evidence retention caps and the disk reserve
      enforced.
- [ ] Measured p50 and p95 durations and infrastructure-failure rate published.
- [ ] Optional LaunchAgent coordinator shares the lease contract and cannot
      create a second controller.

Evidence: none.

### M4 promotion and hardware

Status: Planned

Owner roles: CI maintainer, release owner, maintainer for hardware inventory.

Depends on: M3 Qualified, ten consecutive clean critical-suite runs and two
weeks of scheduled observation across cold boot, warm repeat and image restore.

Closure gates:

- [ ] Trusted outbound dispatch implemented per plan section 9, with persisted
      consumed run and artifact IDs.
- [ ] Native x64 Windows 11 client environment allocated with a named owner,
      or the gap stays explicit in every coverage report.
- [ ] Representative physical printers, GPUs and input devices listed and the
      hardware lane's obligations tracked separately.
- [ ] Release policy updated explicitly before any lane becomes blocking, with
      an outage path when this Mac is unavailable.

Evidence: none.

## Initial critical suite registry

Every row is Planned. Negative controls must reject the named bad output
before the case can become required.

| ID | Family | Driver | Negative control | Package | State |
| --- | --- | --- | --- | --- | --- |
| WIN-SAVE-01 | Delete, save, delete, save, reopen | APP + NATIVE | Official 0.1.450 stale-revision error | M1 | Planned |
| WIN-PRINT-01 | Print all pages through Microsoft Print to PDF, repeat warm | WIN | Official 0.1.450 blank one-page PDF; labeled blank and wrong-marker PDFs | M1 | Planned |
| WIN-PRINT-02 | Delete, save, delete, save, print, reopen | APP + WIN | Wrong-page-marker PDF | M2 | Planned |
| WIN-PRINT-07 | Cancel app, native and output dialogs; overwrite refusal | WIN | Injected stray output and orphan window | M2 | Planned |
| WIN-SAVE-02 | Annotate, save, edit, save; Save As with native picker | APP + WIN | Source-modified-on-Save-As control | M2 | Planned |
| WIN-SAVE-04 | Delete-sharing denied during replacement | NATIVE + APP | Truncated or lost output control | M2 | Planned |
| WIN-SAVE-08 | Corrupt or missing revision sidecar and journals | NATIVE + APP | Recovery-loop control | M2 | Planned |
| WIN-UI-02 | Native open and save picker, keyboard-only, Unicode names | WIN | Internal open API path labeled as integration, not native | M2 | Planned |
| WIN-TOOLS-01 | Every bundled Windows executable loads from the package | NATIVE | Conflicting host PATH tool control | M2 | Planned |

## Open questions

| Question | State | Owning package | Resolution |
| --- | --- | --- | --- |
| Can the chosen native UI driver run on Windows ARM64 and see the required controls? | Evidence first | M0b | none |
| Can cold boot be unattended on the isolated image without changing personal security settings? | Evidence first | M0a | none |
| Does the supported UTM clone and stopped-bundle restore cover disk, configuration, EFI, TPM and removable media? | Evidence first | M0a | none |
| Does the guest desktop keep rendering and accepting input with UTM occluded or minimized, the host locked, or a remote session disconnected? | Evidence first | M0a | none |
| Do x64 app and native tools work under ARM emulation in this VM? | Evidence first | M0b, M2 | none |
| Where is native x64 Windows 11 client coverage? | Planned | M4 | none |
| Which selected scenarios do current helpers bypass with internal APIs? | Planned | M2 | none |
| How fast and stable can this host run suites? | Planned | M1, M3 | none |
| Which real printers, GPUs and input devices matter most? | Planned | M4 | none |
| What happens under Defender, download-origin and Store trust? | Planned | M4 | none |
| Why did the earlier stalled 0.1.450 print run miss `ready-to-show` when the successful run recorded it? | Planned | M1 (WIN-PRINT-08) | none |

## Declined proposals

These came up in the three review rounds or the verification pass and were
rejected. Reopen one only with new evidence.

| Proposal | Why declined |
| --- | --- |
| Hash the possibly running personal VM on every run | Reads a live disk the suite does not own. Allowlisted test identities and paths replace it. |
| Defender exclusions for acceptance directories | Hides customer-visible behavior. |
| Clear the whole print queue before a run | Destroys foreign jobs. Only owned jobs are canceled; an unknown job blocks the run. |
| Disable device encryption or accept an unspecified activation state | Both are provisioning obligations to record, not assumptions. |
| Black screenshot as a lock detector | Session and input desktop are checked directly. |
| `suspend --save-state` as the reset mechanism | UTM 4.7.5 rejects saved state with the NVMe disk this VM uses. |
| Disposable mode as the first isolation contract | Discards guest-held evidence and does not prove TPM, EFI or configuration rollback. |
| WinAppDriver or Appium as the baseline native driver | Unmaintained server with no demonstrated benefit over WinApp or FlaUI. |
| Playwright Electron migration | Experimental, stubs native dialogs, and adds fuse requirements without a shown benefit. |
| Reusing the packaged smoke launcher unchanged for acceptance | It passes `--no-sandbox` and `--disable-setuid-sandbox` and enables an internal file-open helper. |
| Personal-account autologon | Only an isolated lab image with nonproduction credentials may use autologon. |
| Disabling UAC or adding uiAccess for wizard automation | Secure-desktop consent stays outside the ordinary worker. |

## Plan verification record

Verification on 2026-09-04 against the worktree at the baseline SHA, before
this ledger was written.

Checks that passed unchanged:

- All 75 catalogue IDs are unique, every mentioned ID has a catalogue row,
  and the internal section anchors match the headings.
- Every relative file link resolves, and every line anchor is inside its file.
- The repair report agrees with the 881-byte blank print, the 165,964-byte
  ten-page outputs, UTM 4.7.5 build 118, `virtio-ramfb` and Windows build
  26200.8655.
- The installed UTM bundle reports version 4.7.5 build 118 and bundles QEMU
  10.0.2. The personal VM configuration allocates 6144 MB of memory.
- Release guardrails confirm that unsigned Windows releases are manual-install
  only and that updater metadata is pruned unless the artifact is the signed
  x64 updater target.
- The build-target workflow runs the native delete-sharing regression, the
  packaged core-PDF journey and the installed NSIS journey. The AppX installed
  smoke runs on `windows-11-arm`.
- The scan-cleanup service disables raster streaming on Windows, and the
  two-target recovery test skips its real-filesystem case on Windows.

Corrections applied to the plan:

- The repeated print did not run "without a `ready-to-show` event". The repair
  report records that event on the successful run and leaves the earlier
  stalled run unexplained. Section 2 now says so, and the open question above
  tracks it.
- The VM CPU figure was not in the repair report or the VM configuration,
  whose CPU count is the UTM default. Section 2 now cites the configured
  memory only and tells the image manifest to record the real processor count.
- The generated-PDF skill link pointed at the gitignored `.agents/skills/`
  directory. Section 8 now links the tracked verifier script.
- Section 5 now lists all thirteen installed CLI subcommands instead of seven,
  since later sections rely on `list`, `suspend` and `delete`.
- Section 6 records the OSStatus -1743 probe and the personal VM's generic
  display name as concrete reasons for the launcher and identity checks.
- Eight audit anchors that landed on unrelated lines now point at the
  single-instance lock, the print handler, the Windows test skip, the process
  kill, the OCR abort signal, the raster-streaming switch, the test suites'
  `describe` lines and the `before-quit` handler.
- Exit code 1 is reserved for usage errors and uncaught runner crashes.
- Double blank lines, a stray leading space and one bolded sentence removed.

The `utmctl` probes ran from a session without Automation consent and failed
with OSStatus -1743 on `version` and `list`. That is evidence for the
launcher-consent gate in M0a, not a UTM fault.

## Closure rule

To move a package to Qualified:

1. Tick each gate with the run IDs and report paths under the host data root,
   the commit SHAs that landed the work, and the `doctor` output.
2. Record any gate that was reinterpreted, with the reason.
3. Update the package status here, then update the plan's status line only when
   M1 closes.

A gate without linked evidence stays unticked. A package with any unticked
gate is not Qualified, whatever its tests report locally.
