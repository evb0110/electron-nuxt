# UTM Windows tests for agents

The Windows lane runs the packaged EVB Viewer inside a UTM Windows 11 VM on
this Mac and checks saved and printed PDFs with independent oracles. The
design is in
[the research plan](../research/utm-windows-autotest-plan-2026-09-04.md) and
the gate status in
[the implementation ledger](../research/utm-windows-autotest-implementation-ledger-2026-09-04.md).
Read the ledger before claiming anything about the lane's maturity: a package
is only Qualified when every gate links to evidence.

## Commands

```sh
pnpm windows:test:prepare
pnpm windows:test:doctor
pnpm windows:test
pnpm windows:test -- --suite critical --artifact /absolute/path/to/candidate.exe
pnpm windows:test -- --suite all --environment utm-win11-arm64-app-arm64
pnpm windows:test:report -- --run RUN_ID
pnpm windows:test:stop -- --run RUN_ID
```

Run `prepare` once after updating the runner to build its worker and fixtures.
It preserves VM images and configuration and refuses to run while a lease exists.
Run `doctor` first in every new terminal. It reads the host configuration,
probes UTM and its Automation consent, checks the golden image and caches,
and never starts, stops, or modifies a VM.

Exit codes are stable and the only thing CI or a script should branch on:

| Code | Meaning |
| --- | --- |
| 0 | Every required case in the selected automated scope passed |
| 1 | Usage error or an uncaught runner crash |
| 2 | Product failure (assertion, crash, corrupt or wrong output) |
| 3 | Infrastructure failure (VM, session, transport, driver, evidence) |
| 4 | Unsupported configuration or unavailable required capability |
| 5 | Canceled |
| 6 | Another run holds the VM lease; the active run ID is printed |

Exit 0 never means every catalogue obligation was tested. `report` prints the
uncovered obligations and the human contact-sheet review obligation
separately. Do not mark that review done from a machine result.

## Rules that bind agents

- The personal VM registered in UTM under the display name `Windows` is never
  a clone source, test target, delete target or force-stop target. Its UUID and
  bundle path must never enter this repository, a job file, or a log that gets
  uploaded. The runner refuses destructive operations unless the UUID is in
  the host allowlist and the bundle path is under the configured test-image
  root.
- Host configuration, images, caches and run evidence live in
  `~/Library/Application Support/EVBViewerWindowsTests/`, outside every
  checkout. Do not put them under `.devkit`, and do not prune that root as
  part of workspace hygiene.
- A host CLI exit code is transport evidence only. A run passes when the
  validated guest result matches the job's run, boot, VM, image and artifact
  identities and the evidence manifest hashes verify.
- The first result of a run is never replaced. A rerun gets a new run ID.
- Cleanup kills only processes identified by PID, start time and executable.
  Never kill Electron, QEMU, UTM or PowerShell processes by name.
- Acceptance launches keep the renderer sandbox, CSP, UAC, Defender and TLS
  validation intact. `--no-sandbox` and the other flags listed in
  `forbiddenAcceptanceLaunchFlags` are rejected.
- The registry in `tests/windows/capabilities.json` is the coverage source
  of truth. Adding a Windows behavior means adding or updating a case there;
  the policy test rejects duplicate IDs, empty oracles and required cases that
  are still planned.

## Where things live

| Path | Contents |
| --- | --- |
| `scripts/windows-test/contracts/` | Exit codes, states, job and result schemas, host and guest path layout |
| `scripts/windows-test/host/` | Lease, utmctl transport, coordinator, doctor, report, stop |
| `scripts/windows-test/images/` | Image manifest and the destructive-target identity guard |
| `scripts/windows-test/guest/` | Windows worker, launch adapter, native UI adapters, case modules, PowerShell helpers |
| `scripts/windows-test/registry/` | Capability registry loader, lint and change-area suite selector |
| `scripts/windows-test/fixtures/` | Deterministic fixture generators and manifest verification |
| `scripts/windows-test/oracles/` | Host-side PDF oracles and the human-review obligation record |
| `tests/windows/` | `capabilities.json`, fixture manifest, native UI selector records |
| `docs/windows-tests/` | Setup and repair guide, image migration policy |

Setup, repair and image maintenance are in
[setup and repair](../windows-tests/setup-and-repair.md) and
[image migration policy](../windows-tests/image-migration-policy.md).
