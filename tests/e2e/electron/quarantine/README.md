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
