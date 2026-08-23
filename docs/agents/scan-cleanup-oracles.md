# Scan-cleanup oracle gate

Run the affected scan-cleanup oracles after completing a change that may alter
scan cleanup, its native or build inputs, generated PDFs, placement, rendering,
or the fixtures and policies used to verify those paths:

```bash
pnpm run test:scan-cleanup:affected-oracles
```

Run the command before the first push. It compares committed work with the
configured Git upstream, falling back to `<remote>/main`, and also reads staged,
unstaged, and untracked files. A post-push run against a clean tree cannot
verify the commit that was already published. If later edits touch an affected
path, rerun it before pushing.

The command uses the repository's CI changed-area policy. It skips unrelated
work, runs the export and stroke-weight oracles for scan-cleanup inputs, and
adds the native catastrophe oracle when native or build inputs changed. Treat
an unexpected skip as a classification failure to investigate, not as passing
evidence.

Record the exact command, whether it ran or skipped, its exit status, and the
result or output path in the implementation ledger or handoff. CI remains the
enforcement backstop. Keep this command out of the pre-push hook so ordinary
pushes retain only the quick commit-attribution check.
