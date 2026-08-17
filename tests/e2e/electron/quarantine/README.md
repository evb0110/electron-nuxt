# Electron E2E Quarantine

Place Electron E2E tests here only while they are under observation after a new
repro, deflake, or harness change.

- The quarantine lane is nightly/manual and non-blocking.
- CI retries Electron E2E session boot/restart failures marked `[INFRA]` up
  to twice. Assertion and user-flow failures are not retried by this policy;
  the shared Electron E2E project factory applies the same infrastructure
  retry condition lane-wide.
- Do not move stable smoke tests here without an audit-backed reason.
- Review a quarantined test for graduation after 30 green scheduled runs. The
  evidence source is GitHub Actions scheduled-run history plus maintainer
  review; `graduation-policy.json` is an inventory and review target, not a
  per-test run counter.
- Keep each test's graduation target current in `graduation-policy.json`. The
  static architecture policy gate verifies that every quarantine spec is
  accounted for, while operator-only diagnostics are listed separately and do
  not count as graduation evidence.
- This directory may intentionally contain zero tests; the quarantine Vitest
  project is run with `--passWithNoTests` for that state.

The scan-cleanup AppTruth and uniformity probes remain available as
operator-only diagnostics. They require an operator-supplied PDF through their
documented environment variables and are listed under `operatorDiagnostics`;
they are intentionally excluded from the graduation inventory. The uniformity
probe seeds the scoped user-data `scan-cleanup-settings.json` with Sauvola
binarization, then compares the app conversion with a parity CLI conversion.
With its source path or page count absent, it is skipped before an Electron
session fixture is created. The AppTruth probe has the same operator-supplied
fixture requirement.
