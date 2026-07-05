# Architecture Audit — 2026-07-05

Follow-up to `architecture-audit-2026-07-03.md`. Six Codex (gpt-5.5) auditors: two at
high effort re-verifying all 56 prior findings against HEAD (10308da2d), one at high
effort reviewing the 15 remediation commits (`a4868541..HEAD`) with fresh eyes, and three
at medium/low effort covering areas the prior audit skipped (native/build pipeline,
server/landing/web deploy, uncovered renderer modules). Synthesis and adjudication by the
orchestrating session, including an independent check of the disputed save-fencing claim.

## Status of the 56 prior findings

Of 56: **2 fixed** (PDFRT-4 canvas-prepare leak, SHELL-3 write-queue bypass),
**26 partial**, **28 still open**.

| Group | Fixed | Partial | Still open |
|---|---|---|---|
| PDFRT 1–6 | 1 | 5 | 0 |
| PDFED 1–6 | 0 | 2 | 4 |
| SHELL 1–6 | 1 | 3 | 2 |
| MAIN 1–5 | 0 | 2 | 3 |
| ARCH 1–4 | 0 | 1 | 3 |
| IPC 1–7 | 0 | 5 | 2 |
| AGENT 1–7 | 0 | 4 | 3 |
| BG 1–8 | 0 | 2 | 6 |
| TEST 1–7 | 0 | 2 | 5 |

Key verifications (current line numbers):

- **PDFED-1 (C) is STILL OPEN — the one data-loss-grade hole.** Streamed saves begin
  with only `workingPath`/`totalBytes` (`serializedPdfPersistence.ts:354`); commit
  enters the mutation queue (`:436`) and checks only `originalPathSaveBaseMatches`
  (`:456`) — external-edit protection for the *target*, never "has the working copy
  advanced past the revision these bytes were serialized from". `documentRevisionStore`
  now mints tokens but no write path enforces them as CAS.
- **PDFRT-1: the fencing machinery is wired but inert.** The transaction controller
  supports `getDocumentLoadToken`/`getDocumentVersion`
  (`usePdfViewerTransactionController.ts:46,118`) but
  `usePdfViewerFeatureController.ts:413` still instantiates it without those callbacks;
  legacy render requests hard-code `documentVersion: 0`
  (`usePdfRendererVisibleRenderController.ts:292`).
- **AGENT-1 (double-submitted turns) survived** "Stabilize document save and assistant
  state": `sendInFlight` still guards only setup (`codexAssistant.ts:1000–1010`,
  cleared in `finally` at `:1196`); a concurrent send can still `claimSessionTurn`
  (`:1095`).
- **TEST-2: PR CI still proves no real Electron workflow** (`.github/workflows/ci.yml:22–52`;
  e2e nightly + `continue-on-error` at `:246–273`). E2e *isolation* improved (TEST-3
  partial) but nothing real-app is blocking.
- The overhaul direction is real, not cosmetic: shared viewport primitives under
  `app/utils/document-viewer/viewport`, DjVu on `useDjvuViewportController`, PDF
  transaction reducers delegating to shared reducers, assistant state consolidated
  around `providerThreadId`/`turnOwner`. The diff-reviewer's verdict: coherent overhaul,
  "save integrity is not yet a single-owner story everywhere."

## Root causes: where they stand

1. **Revision fencing / CAS on document writes — still the #1 gap.** Tokens exist
   (`documentRevisionStore.ts:202`, `registerDocumentRevisionEventBridge.ts`) but are
   used for invalidation/events, not write fencing. PDFED-1/3, SHELL-2, MAIN-3 remain.
2. **Single async-lifecycle owner — half-built.** Many new tokens/abort controllers,
   but ownership still split across document lifecycle, renderer registries, page
   cache, previews, annotation layers, main-process jobs; the inert controller callbacks
   are the proof.
3. **Document identity — partially unified.** Sessions carry `revisionInfo` and command
   targets carry revision tokens, but identity is still `documentRef` + `originalPath`
   + `workingCopyPath` + tab state; no `documentInstanceId`; assistant sessions still
   keyed `provider:scopeKey`.
4. **Contracts at compile time only — unchanged.** Descriptor tests reduce lazy/browser
   drift, but preload, browser impl, lazy proxy, validation sample, and test fixture
   remain five hand-maintained surfaces.
5. **Terminal-event guarantee — improved, incomplete.** Progress pump sends terminal
   payloads immediately; OCR cancel and DjVu failure/cancel still lack terminal events.
6. **Safety net — improved isolation, same gate.** Nothing real-app blocks a release.

## New findings — remediation regressions (wave 1)

- NEW-1 (H, P) Coordinated non-render PDF operations release ownership on abort while
  the underlying PDF.js promise keeps running; a new render can start on the same
  `PDFPageProxy`. `coordinatedPdfPageRender.ts:212–233`,
  `createHiddenAnnotationOperationsFilter.ts:125`.
- NEW-2 (H, P) Main returns structured `workingCopyRefreshed: false` warnings
  (`workingCopySave.ts:218`) but the renderer only checks `result.ok`
  (`createDocumentPersistence.ts:259`) — completes the PDFED-2 fix.
- NEW-3 (M, P) Command-target revision validation passes when the token is absent
  (initial/failed refresh): `createWorkspaceDocumentSessionCore.ts:201`,
  `useWorkspaceDocumentLifecycleEffects.ts:104`.
- NEW-4 (M, P) Native mutation save tolerates committing a *different* working copy
  than it mutated (`createDocumentPersistence.ts:679,718,736`).
- NEW-5 (M, P) Silent persistence writes bytes before re-checking the captured working
  copy is still active (`createDocumentPersistence.ts:214–219`).
- NEW-6 (M, P) New DjVu print path emits `percent: 100` before the print handoff
  finishes; failure/cancel produce no terminal progress event
  (`pdfExport.ts:521–533,659–678,694–718`).
- NEW-7 (L, P) Rasterized DjVu print work-dir cleanup uses a fixed 30s retention that
  can race slow native spoolers (`printHandoff.ts:627–683`).

## New findings — previously unaudited areas (wave 2)

### Server / landing / web deploy (verdict: patchable)
- SRV-1 (M, P) Analytics insert failures return HTTP 200 `{persisted:false}`; client
  drops the batch permanently (`events.post.ts:210`, `useAnalytics.ts:225`).
- SRV-2 (M, P) Client-supplied `occurredAt` unclamped (`events.post.ts:107`).
- SRV-3 (M, P) No `db:generate`/`db:migrate`/drift gate; schema maintained by
  convention only (`drizzle.config.ts:11`).
- WEB-1 (H, P) Landing vendor-sync manifest omits `contracts/runtimeGuards.ts` that
  landing actually imports; contract drift ships silently
  (`checkLandingVendorSync.ts:10`, `landing/scripts/vendor.mjs:27`).
- WEB-2 (M, P) Neither root `validate` nor landing CI runs `nuxt build` for landing.
- WEB-3 (M, P) Web deploy asset check omits web-critical non-WASM assets (DjVu.js
  worker, PDF worker, cmaps) (`check-web-deploy-assets.mjs:7`).
- WEB-4 (M, P) Desktop vs Vercel output shapes validated only in whichever mode is
  active; no parity contract (`nuxt.config.ts:20`).

### Native tools / build pipeline / updates (verdict: patchable)
- NAT-1 (M, P) WASM request parsers `Vec::with_capacity(untrusted count)` before
  bounds-checking (`pdf-page-ops/src/wasm.rs:152`, `pdf-image-combine/src/wasm.rs:107`).
- NAT-2 (M, P) No protocol/version handshake between JS spawners and Rust CLIs; stale
  binaries degrade silently to fallback (`tryCreatePdfWithNativeImageCombiner.ts:405`).
- NAT-3 (M, P) Python page-processor protocol undocumented/unversioned on result
  envelopes; stdout doubles as protocol and diagnostics (`main.py:27,87`).
- NAT-4 (H, P) Python deps are open lower bounds; bundler installs latest at package
  time — non-reproducible binaries (`requirements.txt`, `bundle-page-processor-macos.sh:181`).
- BLD-1 (H, P) Release packaging can reuse stale `.tmp/pdf-*` native binaries; afterPack
  verifies existence, not freshness (`verify-local-package.mjs:170`, `electron-builder.yml:78`).
- BLD-2 (H, P) macOS bundle scripts soft-fail (`|| true`) on unpinned Homebrew inputs;
  partial bundles can sign and ship (`bundle-pdf-tools-macos.sh:34,136`).
- BLD-3 (M, P) `WORKER_BUNDLES` manifest and `asarUnpack` list are duplicated sources
  of truth (`electronWorkerBundles.js:15`, `electron-builder.yml:13`).
- BLD-4 (M, P) Strict WASM freshness not enforced in normal desktop build gates.
- UPD-1 (M, P) `downloadedVersion` is memory-only and trusted at install; no
  revalidation of the cached artifact before `quitAndInstall` (`updates.ts:63,711`).
- UPD-2 (M, P) App-level release metadata and electron-updater YAML feed can disagree;
  no coherence check (`updates.ts:212,494`).

### Uncovered renderer modules
- RGAP-1 (H, O) DjVu native preview renders uncancellable end-to-end; `terminate()`
  flips a flag after the await (`useDjvuPreviewRuntime.ts:627`,
  `createDjvuWorkerFromPath.ts:278`).
- RGAP-3 (H, O) Native-PDF preview identical: `terminate()` is a no-op; only
  generation checks discard stale results (`createNativePdfPreviewSourceFromPath.ts:36`).
- RGAP-4 (M, P→O) `NativePdfViewer` advertises the generic viewer contract but ignores
  `viewMode`/`continuousScroll` (`NativePdfViewer.vue:72,227`); ~1000-line SFC
  duplicating preview machinery — fold into the shared viewport/preview runtime.
- RGAP-5 (M, P) Settings hydration can overwrite newer local edits; no dirty/revision
  fence (`useSettings.ts:90–145`).
- RGAP-7 (M, P) Global error-guard listeners installed permanently, no cleanup/HMR path
  (`rendererErrorGuard.client.ts:114–171`).
- RGAP-8 (M, P) Browser repo returns refs before ingestion completes; failures collapse
  to "not found" (`browserDocumentRepository.ts:121,361`).
- RGAP-9 (M, P) Browser search cancel is page-boundary cooperative; old extraction
  churns CPU behind new queries (`createBrowserSearchCapability.ts:590`).
- RGAP-2 (M, P) DjVu downscale failures fail open to full-size images under memory
  pressure. RGAP-6 (L, P) OCR language labels lack i18n fallback.
- Hotspots (accidental complexity): `useDjvuPreviewRuntime.ts` (1053),
  `NativePdfViewer.vue` (997), `browserDocumentRepository.ts` (1193),
  `createBrowserSearchCapability.ts` (1141), `useAnalytics.ts` (519, module-level
  mutable state).

## Decisions

**The five overhauls from 2026-07-03 all remain warranted.** Updated framing:

1. **Transactional persistence with revision CAS — unchanged priority #1.** The token
   store exists; the work is enforcing `expectedRevision` at every write commit
   (streamed saves, native mutations, page ops, Save As, silent persistence) and
   rejecting stale bases. NEW-3/4/5 belong to this workstream.
2. **Contract/fixture generation + one blocking Electron smoke lane — untouched, still
   the safety net prerequisite.** TEST-1/2/5, IPC-2/3, ARCH-1 unchanged.
3. **Single lifecycle owner — now a completion job, not a green-field overhaul.** The
   machinery landed; wire the inert callbacks (PDFRT-1), migrate legacy render paths,
   move page-cache eviction to render leases (PDFRT-3), fix NEW-1.
4. **Unified DocumentIdentity — partially delivered** (`revisionInfo`, command
   targets); still needs `documentInstanceId` consumed by tabs/sessions/assistant.
5. **Main-process operation coordinator — unchanged** (MAIN-1/5, IPC-5, BG-5), and
   should now also own the **abortable page-preview contract** shared by DjVu and
   native-PDF (RGAP-1/3) plus native-pdf-viewer consolidation (RGAP-4).

**Everything in the newly audited areas is patchable — no sixth overhaul.** Priority
patch order:

- **P0 (correctness, this week):** NEW-1, NEW-2, PDFED-3, AGENT-1, NEW-4, NEW-5, WEB-1.
- **P1 (release integrity):** BLD-1, BLD-2, NAT-4, UPD-1, TEST-2 (promote one smoke
  lane to blocking), BLD-3/4.
- **P2 (robustness/hygiene):** remaining M/L items (SRV-1..3, WEB-2..4, NAT-1..3,
  UPD-2, RGAP-2/5/6/7/8/9, NEW-6/7, BG and IPC patch items carried from 2026-07-03).
