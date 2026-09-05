# Windows test lane: setup and repair

This guide is the retained setup for the UTM Windows lane on a Mac. It is
versioned with the runner. A repository pull must never overwrite the
machine-specific configuration it describes, because that configuration lives
outside the checkout.

## Host requirements

| Item | Requirement | How doctor checks it |
| --- | --- | --- |
| macOS session | The coordinator runs in the logged-in GUI session, not over SSH | `SSH_CONNECTION` unset and the launchd manager is `Aqua` |
| UTM | 4.7.5 (QEMU 10.0.2) installed at `/Applications/UTM.app` | `utmctl version` parses to the supported version |
| Automation consent | The launcher that runs `utmctl` (Terminal, iTerm, a LaunchAgent) has Automation permission for UTM | `utmctl list` succeeds; OSStatus -1743 is reported as missing consent, not as an SSH problem |
| Data root | `~/Library/Application Support/EVBViewerWindowsTests/` exists with `config.json` | Config loads and validates |
| Disk | Free space above the configured reserve for one clone plus evidence | Free bytes compared with `retention.minFreeBytes` |
| Candidate | A hash-verified NSIS installer registered in the config or passed with `--artifact` | File exists and its SHA-256 matches |
| Python oracle | `python3` with Pillow for the generated-PDF verifier | Missing tooling makes the render oracle inconclusive, never passing |

Set `EVB_WINDOWS_TESTS_ROOT` only for tests or a second lab root. The default
root is the one above.

## Data root layout

```text
EVBViewerWindowsTests/
  config.json            host allowlist, golden image, candidate, retention
  host.lock              exclusive host lock (directory)
  lease.json             current VM lease: host, VM UUID, run ID, owner PID and start time
  images/
    baselines/           stopped, immutable golden images and their manifests
    evb-win-test-*.utm    working copies created per run; failed copies retained here
  caches/
    artifacts/           candidate installers by SHA-256
    fixtures/            generated fixture packs by manifest hash
    tools/               pinned guest tools (Node runtime, winapp CLI)
  runs/<RUN_ID>/         job.json, transitions.ndjson, host.log, guest-result.json,
                         evidence/, evidence-manifest.json, summary.json
  mailbox/               cancellation requests from `windows:test:stop`
```

## First-time host configuration

1. Run `pnpm windows:test:prepare`. It creates the host directories, builds
   `caches/tools/worker/guestWorker.cjs`, copies its PowerShell helpers, and
   generates seven fixtures, copies four tracked fixtures, and writes `caches/fixtures/manifest.json`. It preserves
   existing configuration and refuses to change inputs while a run lease exists.
   It also copies the installed `utmctl` to
   `caches/tools/utmctl-probe/utmctl`; the runner uses that copy so polling does
   not create a foreground UTM Dock icon.
   It does not create a VM or qualify Windows automation.

2. Create a `config.json` like the one below. Placeholder
   UUIDs are shown. Replace `goldenVmId` with the identity of the fresh lab
   image. An empty `allowedTestVmIds` is valid before the first run. The runner
   adds only the new clone identity to its in-memory policy. Never add the
   golden image or personal VM to the destructive allowlist.

   ```json
   {
     "schemaVersion": 1,
     "testImageRoot": "/Users/<you>/Library/Application Support/EVBViewerWindowsTests/images",
     "allowedTestVmIds": [],
     "goldenImageId": "win11-arm64-pro-25h2-baseline-001",
     "goldenVmId": "11111111-2222-4333-8444-555555555555",
     "personalVmIdsDenied": [],
     "candidate": null,
     "environment": "utm-win11-arm64-app-arm64",
     "qualifiedLaunchers": ["/System/Applications/Utilities/Terminal.app"],
     "retention": {
       "passDays": 7,
       "failureDays": 30,
       "maxFailedClones": 1,
       "minFreeBytes": 32212254720
     }
   }
   ```

3. Grant Automation consent. Run the read-only `pnpm windows:test:doctor` from the launcher you
   will use. If macOS denies the request, grant Automation access to UTM in
   System Settings. Do not paste raw VM listings into reports. Repeat for each
   launcher and record its application path in `qualifiedLaunchers`. Doctor detects the enclosing application from process ancestry, with
   `TERM_PROGRAM` as a Terminal or iTerm fallback. For other launchers, set
   `EVB_WINDOWS_TESTS_LAUNCHER` to the qualified application path. This records
   the launcher identity, it does not grant macOS permission. Keep
   `qualifiedLaunchers` empty until a launcher's consent is verified; doctor
   keeps such a host unqualified.

   If the launcher never appears with a UTM entry, inspect its signed entitlements
   and `NSAppleEventsUsageDescription`. A hardened-runtime launcher needs
   `com.apple.security.automation.apple-events` to send Apple Events. The installed
   T3 Code Nightly build inspected on 2026-09-05 lacks both entries. Its UTM request
   fails with -1743 without exposing a UTM toggle. This requires a corrected launcher
   build, or a user-started run from a separately authorized terminal. Permission
   granted to ChatGPT does not grant permission to T3. Do not edit the TCC database
   or re-sign a running launcher as a workaround. See
   [Apple's Apple Events entitlement documentation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events).
4. Build the separate golden image below. Doctor will continue to fail the
   image and candidate checks until those prerequisites exist. Run it again
   after completing setup.

## Golden image build

Build from Microsoft Windows 11 Pro ARM64 media into a new UTM VM. Never
clone or reuse the personal VM.

1. Install Windows with a nonproduction local account for the test user and a
   separate local administrator. Keep UAC, Defender and device encryption at
   their defaults and record the activation state.
2. As administrator, create the guest directories and ACLs:
   `C:\EVBViewerTests\inbox`, `outbox`, `state`, `staging`, `work`. SYSTEM and
   Administrators get full control; the test user gets read on `inbox` and
   `staging`, modify on `outbox`, `state` and `work`; other users get no
   access. Verify the effective rights from both accounts.
3. Write `C:\EVBViewerTests\state\test-marker.json` with exactly the keys
   `imageId` and `guestTestMarker`. Use the configured image ID and a random
   marker value. The same values go into the image manifest.
4. Install a Windows ARM64 Node 22 runtime on the lab image. Copy the prepared
   `caches/tools/worker/` directory to `C:\EVBViewerTests\worker`. The host
   preparation command does not download Windows tools. The native UI driver
   and selector records still require the M0b on-image feasibility checks.
5. Register the worker logon task by running
   `scripts/windows-test/guest/powershell/register-worker-logon-task.ps1`
   as administrator. The task starts the worker in the test user's
   interactive session at logon and writes the boot ID. It stores no
   credentials.
6. Decide the sign-in policy for unattended cold boots. The lane does not
   choose a personal-account autologon. If automatic sign-in for the isolated
   lab account is not configured, runs after a reset are assisted and the
   ledger's M0a gate stays open.
7. Remove installation media and external drive references. Keep every disk,
   EFI and TPM file inside the lab bundle, with no symbolic links. Shut the VM
   down and keep its bundle under the configured `testImageRoot`, normally
   `images/baselines/`. Write `images/baselines/<goldenImageId>.json` with the
   observed identity and configuration below. Set `goldenVmId` and
   `goldenImageId` in the host config.
8. Run `pnpm windows:test:doctor` again. The golden VM must be stopped and
   registered.

The manifest must match `scripts/windows-test/images/imageManifest.ts`. This
example is unqualified. Replace its placeholders with observed lab values;
keep qualification fields null until the ledger's cold-reset checks pass.

```json
{
  "schemaVersion": 1,
  "imageId": "win11-arm64-pro-25h2-baseline-001",
  "vmId": "11111111-2222-4333-8444-555555555555",
  "bundlePath": "/Users/<you>/Library/Application Support/EVBViewerWindowsTests/images/baselines/EVB-Lab-Golden.utm",
  "createdAt": "ACTUAL_UTC_CREATION_TIME",
  "windowsBuild": "ACTUAL_WINDOWS_BUILD",
  "osArch": "arm64",
  "utmVersion": "4.7.5",
  "qemuVersion": "10.0.2",
  "driverVersions": {"qemu-guest-agent": "ACTUAL_VERSION"},
  "disks": [{"diskId": "ACTUAL_DISK_ID", "purpose": "Windows system disk", "resetPolicy": "restore-from-baseline"}],
  "guestTestMarker": "THE_MARKER_FROM_THE_GUEST",
  "qualifiedAt": null,
  "qualification": null
}
```

After updating the runner, prepare the host files again and refresh the worker
copy in the lab image before requalifying it. `prepare` changes host files only.

## Candidate artifacts

Pass a candidate with `--artifact /absolute/path/to/EVB-Viewer-Setup.exe`.
This is a one-run override, it does not update `config.json` or copy the
installer into the cache. Place a build identity sidecar next to the installer
with the suffix `.meta.json`, for example:

```json
{"version":"0.1.450","sourceSha":"FULL_BUILD_COMMIT_SHA","appArch":"arm64"}
```

Use the actual build identity. To make a candidate the default, record its
absolute `artifactPath`, `fileName`, `version`, `sourceSha`, `appArch` and
SHA-256 as `candidate` in the host configuration. The runner checks the file
against that digest. There is no implicit latest build.

## Running

```sh
pnpm windows:test:doctor
pnpm windows:test -- --suite critical
pnpm windows:test:report -- --run RUN_ID
```

Every run copies the complete stopped lab bundle into the configured test-image
root, assigns a new UUID and network MAC addresses, imports it into UTM, and boots it.
The copy path does not use `utmctl clone`, which writes into UTM's own storage.
It then waits for the worker heartbeat with the current boot ID, stages the artifact
and fixtures with hash verification, writes the job, and polls the guest
outbox until the result or the deadline. The summary and evidence stay under
`runs/<RUN_ID>/` and are never rewritten.

## Repair

| Symptom | Cause | Repair |
| --- | --- | --- |
| `doctor` reports `automation-consent-missing` with OSStatus -1743 | The current launcher has no Automation permission for UTM | Open System Settings, Privacy and Security, Automation, allow the launcher to control UTM; run `utmctl list` from that launcher; add it to `qualifiedLaunchers` |
| A second UTM Dock icon appears while polling | The bundled CLI registers as a foreground application | Run `pnpm windows:test:prepare` and keep the prepared standalone copy at `caches/tools/utmctl-probe/utmctl`; the client selects it automatically when present |
| Exit 6 with an active run ID | Another coordinator owns the lease | Wait, or `pnpm windows:test:stop -- --run RUN_ID` from any terminal |
| Exit 6 but no coordinator process exists | Stale lease after a crash or host reboot | `pnpm windows:test:stop -- --run RUN_ID` performs stale-owner recovery under the host lock; it stops only the owned clone |
| Exit 3 "desktop not ready" | Guest is locked, in Session 0, or the logon task did not run | Sign in to the test user in the UTM window, confirm the task exists, then rerun |
| Exit 3 "image drift" | A pre-existing EVB installation, pending reboot, or unexpected OS build in the clone | Do not patch the clone; rebuild or requalify the golden image per the migration policy |
| Retained failed clone blocks the next run | `retention.maxFailedClones` reached | Inspect the clone, then delete it from the UTM UI, or raise the limit; the runner never deletes the only failure evidence automatically |
| Oracle reports `inconclusive` for rendering | `python3` or Pillow missing on the host | Install Pillow for the host `python3`; inconclusive is never a pass |
| `winapp` selector ambiguity error | Two controls match a selector on this Windows build | Update `tests/windows/native-ui/selectors.json` with the automation ID and record the verified image |

Never delete `lease.json`, `host.lock`, a run directory or a clone by hand
while a coordinator may be alive. The documented recovery path goes through
`windows:test:stop`.
