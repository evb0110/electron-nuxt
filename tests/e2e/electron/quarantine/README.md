# Electron E2E Quarantine

Place Electron E2E tests here only while they are under observation after a new
repro, deflake, or harness change.

- The quarantine lane is nightly/manual and non-blocking.
- CI retries quarantined tests twice.
- Do not move stable smoke tests here without an audit-backed reason.
- Graduate a quarantined test back to the smoke or extended lane after 30 green
  scheduled runs.
- This directory may intentionally contain zero tests; the quarantine Vitest
  project is run with `--passWithNoTests` for that state.

The scan-cleanup uniformity probe is environment-gated. The orchestrator must
provide `EVB_SCAN_CLEANUP_UNIFORMITY_SOURCE_PDF` and
`EVB_SCAN_CLEANUP_UNIFORMITY_PAGE_COUNT`; it seeds the scoped user-data
`scan-cleanup-settings.json` with Sauvola binarization, then compares the app
conversion with a parity CLI conversion. With either variable absent, the
test is skipped before an Electron session fixture is created.
