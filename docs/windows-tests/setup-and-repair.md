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
    clones/              working clones created per run; failed clones retained here
  caches/
    artifacts/           candidate installers by SHA-256
    fixtures/            generated fixture packs by manifest hash
    tools/               pinned guest tools (Node runtime, winapp CLI)
  runs/<RUN_ID>/         job.json, transitions.ndjson, host.log, guest-result.json,
                         evidence/, evidence-manifest.json, summary.json
  mailbox/               cancellation requests from `windows:test:stop`
```

## First-time host configuration

1. Create the data root and a `config.json` like the one below. Placeholder
   UUIDs are shown; use the UUIDs that `utmctl list` prints for the test VMs
   you created. Never add the personal VM's UUID to `allowedTestVmIds`.

   ```json
   {
     "schemaVersion": 1,
     "testImageRoot": "/Users/<you>/Library/Application Support/EVBViewerWindowsTests/images",
     "allowedTestVmIds": ["11111111-2222-4333-8444-555555555555"],
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

2. Grant Automation consent. Run `utmctl list` once from the launcher you
   will use; macOS shows the consent prompt for UTM. Repeat for every
   launcher and record each in `qualifiedLaunchers`.
3. Run `pnpm windows:test:doctor`. Fix every failed check before building the
   image.

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
3. Write `C:\EVBViewerTests\state\test-marker.json` with the image ID and a
   random marker value. The same value goes into the image manifest.
4. Install the pinned guest tools from `caches/tools/`: the Node runtime used
   to run the bundled worker and the Microsoft `winapp` CLI at the version
   pinned in `scripts/windows-test/guest/native-ui/winappCliAdapter.ts`.
5. Register the worker logon task by running
   `scripts/windows-test/guest/powershell/register-worker-logon-task.ps1`
   as administrator. The task starts the worker in the test user's
   interactive session at logon and writes the boot ID. It stores no
   credentials.
6. Decide the sign-in policy for unattended cold boots. The lane does not
   choose a personal-account autologon. If automatic sign-in for the isolated
   lab account is not configured, runs after a reset are assisted and the
   ledger's M0a gate stays open.
7. Shut the VM down. Write the image manifest into `images/baselines/` with
   the Windows build, UTM and QEMU versions, driver versions, reset policy per
   disk, and the marker. Set `goldenVmId` and `goldenImageId` in the config.
8. Run `pnpm windows:test:doctor` again. The golden VM must be stopped and
   registered.

## Candidate artifacts

Register a candidate with `--artifact /absolute/path/to/EVB-Viewer-Setup.exe`.
The runner copies it into `caches/artifacts/<sha256>/` and records the file
name, version, source SHA and app architecture in the config `candidate`
field. The default command uses that candidate. There is no "latest"; a
different build is always an explicit path.

## Running

```sh
pnpm windows:test:doctor
pnpm windows:test -- --suite critical
pnpm windows:test:report -- --run RUN_ID
```

Every run creates a fresh clone from the stopped golden image, boots it,
waits for the worker heartbeat with the current boot ID, stages the artifact
and fixtures with hash verification, writes the job, and polls the guest
outbox until the result or the deadline. The summary and evidence stay under
`runs/<RUN_ID>/` and are never rewritten.

## Repair

| Symptom | Cause | Repair |
| --- | --- | --- |
| `doctor` reports `automation-consent-missing` with OSStatus -1743 | The current launcher has no Automation permission for UTM | Open System Settings, Privacy and Security, Automation, allow the launcher to control UTM; run `utmctl list` from that launcher; add it to `qualifiedLaunchers` |
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
