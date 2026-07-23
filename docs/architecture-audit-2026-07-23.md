# Architecture Audit — 2026-07-23 (Size, Elegance, and Consolidation)

Decision update: the dormant Python page-processor was removed after the native scan-cleanup pipeline superseded it; its implementation remains recoverable from git history.

Unlike the 2026-07-03/05 audits (correctness/fragility), this audit answers the owner's
question: *is ~678k authored LOC justified, and can substantial parts be rewritten more
logically and elegantly?* Six Codex (gpt-5.6-sol @ high) area auditors + one correctness
auditor for the uncommitted working tree, plus git-history mining, fallow metrics, and
taste review/synthesis by the orchestrating session (Claude Fable). Working tree at
`c6cebbc27` plus uncommitted changes.

## Verdict

**Yes — substantial parts should be rewritten, but the target is consolidation of
ownership and ceremony, not a from-scratch rewrite.** The code is locally clean (fallow
maintainability 90/100, textual duplication 1.5%, defensive-validation density in main
only 3.5–5%) but architecturally over-fragmented: too many partial owners of the same
lifecycle, too many representations per boundary, and ceremony that multiplies every
feature. A realistic invariant-preserving program removes **~110–135k lines (16–20%)**
and — more importantly — collapses 14–22-file flows into 4–6-file flows.

| Area | Current LOC | Accidental share | Realistic target | Savings |
|---|---:|---:|---:|---:|
| app/modules/pdf-viewer | 93.5k | 16–21% | 82–86k | 7.5–11.5k |
| workspace-shell + app/utils + app/platform | 85.1k | 19–26% | 63–69k | 16–22k |
| electron/ + packages/contracts | 102.6k | 10–14% | 92–95k | 7.5–10k |
| native/ (Rust) | ~40k | 15–20% | 33–35k | 5–7k |
| tests/ | 236.5k | 24–30% | 165–180k | 56–71k |
| scripts/ | 35.2k | 32–38% | 22–24k | 11–13k |
| python/ (dormant) + its scripts support | ~5.8k | — | 0 (extract or delete) | ~5.8k |
| landing/ isolation overhead (vendor copies, lockstep checker) | ~1.8k | — | 0 | ~1.8k |

Ranges overlap; do not sum mechanically. Full per-area reports (structure maps, flow
traces, per-finding LOC estimates) are preserved in the audit transcripts.

Corrections to intuitions: tests are NOT larger than the code (236k vs 318k app+electron
= 0.74:1 — normal ratio, but low value-density); the two assistant backends are NOT
duplicated stacks (codexAssistant.ts is already the shared orchestrator); the Rust
algorithms are essential complexity.

## The measured pathologies

1. **Layer tax.** Scroll→render crosses 16 files; drawing a highlight to save crosses
   ~22; document open crosses 17. A save spans 4,138 lines across 12 files with 20+
   single-assembly "port" interfaces. Adding one trivial IPC method touches 10
   handwritten files (18 ceremony lines); a progress-bearing operation costs 280–330
   ceremony lines.
2. **Representation multiplication.** One scan-cleanup preview passes options through
   ~9 materializations / 6 schemas (reactive options → clone → bridge-safe rebuild →
   preload encode → main decode → effective options → sparse options → manifest v3 →
   Rust manifest → legacy batch model). Progress passes through 6 shapes.
3. **Parallel machinery.** Viewport and thumbnail rendering are two full schedulers
   (~7.1k). Five features (DjVu, image-export, search, OCR, scan-cleanup) each rebuild
   the missing "job" layer above the three partial job systems that exist. Annotation
   state lives in three authoritative containers synced by copying.
4. **Concept-per-file explosion.** pdf-viewer: 630 files averaging 148 lines; engine/
   has 332 files (72 LOC avg), 126 files ≤20 lines, 26 single-file directories, 6 empty
   directories. Electron: 124 files under 50 lines. app/: 253 `useX` composables; file
   names include 26 Controllers, 38 Lifecycles, 14 Leases, 11 Coordinators, 9 Chassis,
   4 Authorities.
5. **Test harness sprawl.** 41,725 lines sit before the first `describe()`; 507 local
   mock factories in 294 files; ~15 parallel platform/Electron fake worlds while the
   canonical descriptor-driven fixture is used by only 10 files. `usePdfFile.test.ts`:
   1,707 lines for a 229-line façade (7.45:1).
6. **Tooling as a second product.** scripts/ embeds four subsystems (custom-gate
   ecosystem 9.8k, release engineering 7.9k, Electron process supervisor 7.1k, PDF
   diagnostics lab 4.2k). package.json has 173 scripts (55 `check:*`); drift gates
   guard hand-committed generated files instead of generating at build. 11.7k lines of
   tests pin exact command strings/workflow topology, making tooling consolidation look
   like behavior change.
7. **Migrations that became permanent.** Legacy `documents.*` aliases are 87 of 299
   generated bindings (29%); scan-cleanup parses ManifestV3 then converts it into the
   legacy batch model it replaced; a 290-line localStorage "migration system" guards one
   schema.

## Root causes (git history + guidance analysis)

- **Growth is accelerating, not converging**: 113 source files (Jan) → 3,185 (Jul 22);
  net +235k lines in the last four weeks alone.
- **Fix-forward monoculture**: 24% of 2,128 commits are "Fix …"; ~4% are
  refactor/consolidation; 4 reverts total. Problems are patched by adding machinery.
  The July remediation added +74.5k/−15.2k in 5 days.
- **No parsimony pressure**: prior CLAUDE.md/AGENTS.md were 100% operational
  (verification lanes, packaging); zero design guidance. The one architecture rule
  ("define shapes in packages/contracts") encouraged surface growth.
- **The wrong gate**: the only size gate is a per-file 1,200-line cap — which launders
  complexity into fragmentation (splitting satisfies the gate while multiplying
  interfaces, barrels, and mocks).

## Correctness findings (current working tree + runtime)

Found alongside the size audit; fix the first two before committing the dewarp work.

- **H — Release smoke policy expects stale protocol versions.**
  `scripts/release/native-tool-smoke-policy.mjs` expects pdf-image-combine protocol 3 /
  scan-cleanup 2; binaries now report 4 / 3. `verify-packaged-native-tools.sh` will
  deterministically fail. Fix: source expectations from
  `packages/contracts/nativeToolProtocols.ts`; add a test joining the two.
- **H — Scan-cleanup v3 drops v2 compatibility without protocol negotiation.** TS
  writes only v3, Rust accepts only v3 (+opt-in v1), and the launcher skips the cached
  `--protocol-version` handshake other tools use. Any app/sidecar version skew fails
  every operation with a generic error. Fix: preflight `verifyNativeToolProtocol` for
  scan-cleanup; decide explicitly between negotiated v2 fallback and atomic
  distribution with a typed version-mismatch error.
- **M — Placement overrides use stale cached preview geometry.** `placementOverrides`
  was removed from the preview cache key but cached metadata still supplies placement
  offsets; preview snaps back to the old position while final output uses the new
  override. The old cache-key test was weakened to match. Fix: recompute offsets
  renderer-side from the current override, or restore the key component; re-add a test
  that committing an override moves an already-cached preview.
- **H (committed) — Streaming chat deltas each enqueue a full-session fsync snapshot**
  (`assistantChatPersistence.ts`): quadratic copying + unbounded queue growth during
  long streamed responses. Coalesce to newest-state, debounce, checkpoint at turn
  boundaries.
- **M (committed)** — `codexAppServerClient.ts` stdout line buffer is unbounded (cap
  it and fail the protocol process); scan-cleanup `ownerScopedJobRegistry.ts` leaks one
  `destroyed` listener + retained job per job/subscription on long-lived windows.
- **Test deltas** — v2 golden fixtures deleted without replacement negotiation
  coverage; smoke-policy tests validate the stale literals against themselves.

## The overhaul program

Owner has approved large-scale overhauls. Sequencing is dependency-driven; each stage
must keep `pnpm validate` green and preserve every invariant from the July audits
(revision CAS, documentInstanceId, lease/settle semantics, typed errors, progress
replay, fail-closed release gates).

**Stage 0 — Correctness (days).** The findings above.

**Stage 1 — Generative foundations (the multiplier).**
1. `definePlatformFeature()` runtime spec as the single source for method name,
   channel, schemas, kind, progress semantics, handler and browser binding → generate
   invoke maps, codecs, preload clients, registrar loops, descriptor entries, fixtures,
   lazy artifacts. Migrate one capability at a time with codec-parity tests. (−3.6–4.6k
   direct; shrinks every later migration.)
2. Generic main-process job registry (owner/revision fencing, renderer-death cleanup,
   signal composition, scratch scope, progress replay, terminal expiry) extending
   `mainOperationLifecycle`; migrate DjVu → image-export → OCR → search → scan-cleanup.
   (−1.2–1.8k plus feature-side savings.)
3. Test-harness consolidation *before* the big renderer refactors: adopt the
   descriptor-driven platform fixture everywhere, build shared Nuxt-stub/pointer/mount
   harnesses, and unpin structure-pinning tests (assert plans/manifests, not command
   strings). This is what makes Stages 2–4 cheap.

**Stage 2 — Renderer ownership consolidation (the big one).**
4. workspace-shell: three explicit owners — `WorkspaceDocumentController` (open/close/
   restore/identity/transaction), `WorkspaceDocumentDriver` (per-format behavior chosen
   at open; kills the 172-site PDF/DjVu/native branching), `WorkspaceSaveService` (one
   `SavePlan` discriminated union + one executor replacing the port lattice). Giant
   SFCs become composition roots. (47.9k → 35–38k.)
5. pdf-viewer: one `PdfPageRasterScheduler` for viewport+thumbnails; `AnnotationStore`
   as sole authority (PDF.js as projection); replace the feature-controller callback
   mesh with four typed sessions (document/viewport/rendering/annotation); one
   text-markup presentation controller; single save-route classifier. (93.5k → 82–86k.)
6. utils/platform: fold `document-viewer/` machines into the surface lifecycle; merge
   agentMetadataPlans into canonical metadata helpers; privatize single-consumer
   exports; browser platform to explicit web tiers. (85.1k → 63–69k with #4.)

**Stage 3 — Vertical slice cleanup.**
7. scan-cleanup: execute ManifestV3 directly (delete the legacy batch model);
   schema-derived codecs replacing the 1,055-line handwritten codec; one
   preview/detect/final runner; one public result schema + opt-in diagnostics; shared
   progress DTO. (Vertical 31–32k → 24–26k.)
8. native: shared raster IO crate (`evb-raster-io`), atomic-output + CLI envelope in
   `evb-native-support`, single `PageSpec` API in pdf-image-combine, generated protocol
   descriptors. (40k → 33–35k.)

**Stage 4 — Tooling and tests.**
9. Gates: move filename/import/size rules into ESLint, CSS rules into Stylelint; keep
   one graph checker; generate-at-build instead of drift gates; content-addressed build
   receipts replace mtime freshness. Release: one target manifest driving
   stage/afterPack/verify. Electron runner split into dev supervisor + ephemeral E2E
   fixture + diagnostics adapter. package.json 173 → 75–95 scripts; CI 1.9k → ~1.3k
   YAML via matrix + composite actions. (35.2k → 22–24k.)
10. Tests: table-drive repeated scenario families; delete mock-echo assertions; one
    layer per scenario + one e2e proof; each deleted duplicate needs a retained test
    that fails under a representative violation. (236.5k → 165–180k.)
11. Owner decisions: dormant python/ page-processor deleted (recoverable from git
    history); landing/ into the workspace (delete vendor copies, lockstep checker, nested
    workflow); legacy `documents.*` aggregate deprecation clock.

## Process rules for the overhaul (and after)

- Every refactor PR reports net LOC and file-count delta; consolidation PRs should be
  net-negative.
- Bounded Codex tasks with precise specs; fresh-session review on every structural PR;
  taste review (Opus/Fable) for public surfaces.
- Revert is a first-class outcome — a failed approach gets rolled back, not patched
  forward.
- Fix the cause, then ask "what does this fix let us delete?"
- The design rules that prevent regrowth live in `CLAUDE.md` (Design section) and
  `AGENTS.md` (Architecture section); they were added as part of this audit.

## Leave alone (consensus across auditors)

Revision CAS + typed stale/missing-revision errors; documentInstanceId and command
targets; render leases and settle-before-release; operation-lifecycle shutdown
admission; trusted-sender IPC validation (generate it, don't delete it); progress
replay; fail-closed release verification; the blocking Electron smoke lane and every
invariant-violation test; OCR scheduling/resource governance; Rust algorithm crates
(dewarp, text-line tracing, jbig2, lopdf mutation logic); chunked browser storage; the
dual native/WASM capability; explicit generated proxies (no clever runtime `Proxy`).
