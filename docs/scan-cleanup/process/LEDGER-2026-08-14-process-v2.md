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
- B1 report capture (manual, blocking-local): every user message
  carrying a report becomes a row here at receipt, with disposition
  (defect | instruction | question | duplicate | out-of-scope),
  BEFORE any dispatch responding to it.
- B2 ratification: reproduce-and-confirm with the user before fix
  rounds for S1-severity items; default severity S1; only a user
  reply downgrades.
- G3 closure soak: no step closure within 1h of its last landing.
- Numbers policy: no transcribed measurement is authoritative; gates
  compute and diff against committed machine-written baselines.
- Test policy: full suite, never scoped, before landing
  (`pnpm exec vitest run tests/unit`); Rust: cargo fmt --check +
  clippy + release tests + integration targets under native/*/tests/.
- Scope guard: build the scan-cleanup feature, not a civilization.
  Appendix items (hash chains, digest archives, classifiers, full
  oracle formalism, VPS residency tiers, E1b, cadence caps) need a
  new demonstrated failure to enter scope.

## Backlog (from approach Part 4 FINAL; each step = one X2 cycle)

- [ ] S1 CI truth + hygiene — ordered ops: (1) workflow PR
      (concurrency PR-only cancel, gates_ok aggregator, unit tests on
      PR path, O7 changed-area repair + tracked-dir census, native
      build prereq in blocking smoke, B3 build identity) + docs/
      scan-cleanup/ migration of approach/ledger/reviewer reports;
      (2) ruleset (require PR + gates_ok, enforce_admins, block
      force-push; merge queue if the ruleset accepts it), shipped only
      after failure-injecting the dispatch bypass (red PR +
      workflow_dispatch on the same SHA must stay blocked);
      (3) completion criteria: verify the push run on the landed SHA
      (exact-SHA attestation), freeze merges while main is red, and
      route recovery through a normal gates_ok-gated revert PR.
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

## Open items carried from prior ledger

- Task #27 word-weight amplification (Fadinger/Stylites) -> S2.
- Settle-jump / session-pinned canvas -> S2.
- Ledger class-count error (nine vs eight audit classes) — corrected
  record: code defines EIGHT violation classes.
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
