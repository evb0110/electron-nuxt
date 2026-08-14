# Execution Ledger — scan-cleanup process v2 (opened 2026-08-14)

Governing document: DEV-VALIDATION-APPROACH-2026-08-14.md (FINAL after
four adversarial review rounds). Supersedes LEDGER-2026-08-11-auto-rescue.md
(closed with a pointer here; the closed ledger remains
machine-local under .devkit). This ledger is canonical at
docs/scan-cleanup/process/ (tracked, CodeRabbit-visible) as of S1's
PR; the round 1-4 reviewer reports live in ./reviews/.

## Standing rules (binding for every step)

- Execution model X1: orchestrator decides (diagnosis, design,
  acceptance criteria, adjudication); sol implements at low/medium/
  high effort scaled to complexity; unlimited parallel sols;
  parallelizable repo-clean experiments may offload via vps-agent.
- Step flow X2: substantial step -> ONE adversarial review
  (opus-medium + sol-high, once) -> ONE fix round -> PR -> sol-high
  babysits CodeRabbit (fail-open) -> joint adjudication, reply to
  every handled thread before resolving -> merge -> next step.
- PRE-MERGE THREAD SWEEP (added after the S1 miss, R6): every push to
  a PR branch can trigger an incremental CodeRabbit review that adds
  NEW threads minutes later. Therefore merging requires, in order:
  (1) CodeRabbit's review of the LAST pushed commit is complete;
  (2) a fresh enumeration of ALL review threads (GraphQL
  reviewThreads) shows zero unresolved threads and no thread whose
  trailing comment is an unanswered reviewer finding. The CodeRabbit
  STATUS CHECK being green is never sufficient — it reports review
  completion, not thread disposition.
- B1 report capture (manual, blocking-local): every user message
  carrying a report becomes a row here at receipt, with disposition
  (defect | instruction | question | duplicate | out-of-scope),
  BEFORE any dispatch responding to it.
- B2 ratification (amended R7): reproduce and DELIVER the artifact
  before fix rounds; do not wait for user confirmation — proceed, and
  treat a later user reply as binding adjudication after the fact.
  Default severity S1; only a user reply downgrades.
- G3 closure soak: no step closure within 1h of its last landing.
- Numbers policy: no transcribed measurement is authoritative; gates
  compute and diff against committed machine-written baselines.
- Test policy: full suite, never scoped, before landing
  (`pnpm exec vitest run tests/unit`); Rust: cargo fmt --check +
  clippy + release tests + integration targets under native/*/tests/.
- EYEBALL PACK (added at user request, R7): every step closes with a
  2-minute user-reviewable artifact set — before/after images or a
  short recording of the exact user-visible behavior the step claims
  to change — delivered in chat and referenced in the PR. Closure
  claims without an eyeball pack are invalid. NON-BLOCKING (user
  instruction, R7): delivery of the pack is required, the user's
  review of it is not — work proceeds immediately after delivery;
  a later user objection reopens the step as a defect row.
- PARALLEL TRACKS (R7): steps with disjoint file surfaces may run
  concurrently (separate worktrees/dispatches); MERGES stay
  serialized in ledger order. User-visible feature work (S2) always
  outranks governance work; S3-S6 investment is re-checked against
  the user's app-level confirmation after S2 lands.
- Scope guard: build the scan-cleanup feature, not a civilization.
  Appendix items (hash chains, digest archives, classifiers, full
  oracle formalism, VPS residency tiers, E1b, cadence caps) need a
  new demonstrated failure to enter scope.
- NO BLOCKING QUESTIONS (user instruction, R7): never wait on a user
  answer. When a decision point arises (even config/product trade-offs
  like the S1 ruleset), decide with best judgment, record decision +
  cheap reversal path in the ledger, deliver evidence, keep moving; a
  later user reply overrides retroactively. The S1 op-2 question cost
  hours of idle waiting — that failure mode is banned.
- VPS OFFLOAD (user instruction, R7): use the vps-agent skill (sol
  low-high) whenever a parallelizable, repo-clean, non-macOS-bound
  workload (corpus sweeps, S3 re-adjudication measurements on tracked
  fixtures, benchmarks) can run remotely faster than locally; no stale
  remote processes left behind.

## Backlog (from approach Part 4 FINAL; each step = one X2 cycle)

- [x] S1 CI truth + hygiene — DONE 2026-08-14 (see R3-R5). Op 1
      landed as PR #6 (rebase-merged 066f24206 + 47f4dcb77): workflow
      truth fixes, O7 repair + tracked-dir census, native prereq in
      blocking smoke, B3 build identity, docs/ migration. Op 2
      (ruleset) CANCELLED BY USER DECISION (R5): no GitHub settings
      changes; direct pushes to main remain possible; PRs are the
      working convention (CodeRabbit review), enforced by this
      ledger's X2 policy, not mechanically. The dispatch-bypass
      failure injection is moot without a ruleset; the gates_ok
      event guard stays as defense in depth. Completion criteria met:
      push run 31758031743 on landed SHA 47f4dcb77 concluded success
      (gates_ok + native lane + first-ever push-path unit tests).
      Red-main freeze + gates_ok-gated revert PR remain standing
      policy for every future landing.
      Deferred out of S1 (own gated change, recorded from CodeRabbit
      review of PR #6): align the required native lane with the local
      gate contract — release-mode workspace tests incl. integration
      targets, and moving build:strict off the required PR path per
      G1(e) — folded into S4's wiring step.
- [ ] S2 Feature fixes forward: settle-jump / session-pinned canvas
      (transition semantics first); word-weight amplification
      measurement redo (task #27).
- [ ] S3 Ground-truth re-adjudication (measurement-based labels for
      nonzero catastrophe entries + the minimumIou 0.0 fixture) —
      strictly before any baseline regeneration.
- [ ] S4 Wire what exists: regenerated ratchet baseline (post-S3) into
      test:rust; audit + preview-harness scripts wired; regress-net
      job deleted; O6 computed tripwire; timing block.
- [ ] S5 e2e: triage the 14/14 nightly red streak first, then graduate
      specs measured green in destination config; retire 30-green bar
      for machine-derived counters.
- [ ] S6 E1a invariant assertions I1-I3 (post-S3).

## Rows

R1 2026-08-14 (instruction, this session): user protocol — four
   review rounds completed; "when everything is ready to proceed, do
   proceed but create a new ledger and follow it"; per-step X2 flow;
   steps substantial, not small; sol recommendations with a grain of
   salt; goal is the scan-cleanup feature. Disposition: instruction —
   this ledger and its standing rules are the implementation.
R2 2026-08-14: approach doc finalized (round-4 combined minimal delta
   applied: figures policy, scope-guard enforcement, backlog reorder,
   G2 single-meaning gates_ok, B1 no-classifier, O6 computed,
   O7 dir-census, two-op S1). Round-4 sol report archived
   at ./reviews/round4-sol-xhigh.md; opus round-4 findings are disposed
   in the approach document's Part 5.

R3 2026-08-14 (S1 X2 review, one round): opus-medium + sol-high on the
   S1 diff. Verified blockers fixed in the single fix round:
   (a) concurrency pending-slot replacement still cancelled push runs
   -> per-run groups for non-PR events; (b) gates_ok published a green
   check on workflow_dispatch/schedule for the same head SHA (required
   -check bypass) -> event-guarded job; (c) census read the filesystem
   and failed with 16 false positives on the primary checkout -> git
   ls-files basis, which surfaced genuinely unmapped tracked dirs
   (drizzle/, patches/, build/, .github/actions/) now mapped;
   (d) provenance gitSha shelled out to git AT RUNTIME in the shipped
   worker (foreign-repo SHA claims, macOS CLT dialog) and extended the
   stamp without a schema bump (old builds would hard-reject new
   documents) -> REVERTED; stamp gitSha deferred to S4 with schema
   versioning (v2 + v1-on-read) as an explicit design task.
   Also: advisory nuxt job removed from gates_ok needs (continue-on-
   error makes its result decorative); needs-list pinned by test;
   smoke timeout 60; dirty-tree guard on embedded SHA; env-isolated
   appVersion tests; updateHealthMarker normalized. Declined with
   reasons: scan-cleanup e2e spec now (S5 graduates the real specs;
   electronSmoke routing buys the native-build prereq, not behavioral
   coverage — PR body states this); rewriting archived report links
   (verbatim archive policy in reviews/README.md); top-level FILE
   census (outside O7's dir scope, noted).
   OP-2 GATE: before the ruleset ships, failure-inject the dispatch
   bypass (red PR + workflow_dispatch on the same SHA must stay
   blocked).
R4 2026-08-14 (S1 landing): PR #6 merged (066f24206 + 47f4dcb77);
   CodeRabbit review: 10 inline findings — 8 accepted and fixed in
   80d17a6bf->47f4dcb77 (cache-step SHA pin, update-health
   normalization + regression, SHA boundary tests, fail-closed
   topology recognizer, B3/O5/O7/B1 doc corrections, S1 completion
   criteria), 1 declined with evidence (appendix items are recorded,
   not scheduled), 1 deferred as its own gated change (required
   native lane alignment -> S4). All threads replied before
   resolution. Post-landing attestation: push run 31758031743 fully
   green on the landed SHA.
R5 2026-08-14 (instruction, user): "you shouldn't change anything on
   github. we can push to main, but for now we want to use prs to
   take advantage of coderabbit." Disposition: instruction — S1 op 2
   (ruleset/enforce_admins/merge queue) cancelled; PR flow stays a
   ledger-enforced convention; no repository settings will be
   modified. G1(c)/(d) in the approach are superseded by this row.
R6 2026-08-14 (defect report, user): CodeRabbit thread r3780029144 on
   PR #6 (backtick the O7 glob paths so ** is not eaten as Markdown
   bold) was never replied to. Root cause: the fix-commit push at
   00:03 triggered an INCREMENTAL CodeRabbit review that posted the
   new finding at 00:07 - after the reply/resolve sweep at 00:04-00:05
   - and the pre-merge check only consulted the CodeRabbit status
   check, which reports review completion, not thread disposition.
   Swept all PRs: this was the only unaddressed thread anywhere.
   Handled: globs backticked in both doc locations (O7 body + S1
   backlog line), thread replied and resolved, and the PRE-MERGE
   THREAD SWEEP standing rule added so an incremental review can
   never be missed again. Disposition: defect (process execution),
   fixed.

## Open items carried from prior ledger

- Task #27 word-weight amplification (Fadinger/Stylites) -> S2.
- Settle-jump / session-pinned canvas -> S2.
- Ledger class-count error (nine vs eight audit classes) — corrected
  record: code defines EIGHT violation classes.
