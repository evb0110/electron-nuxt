# PDF annotations audit implementation ledger

Date: 2026-08-23

Source audit: `docs/pdf-annotations-feature-audit-2026-08-22.md`.

## Verification baseline

- Audit baseline: `26c7b8d6b641f81c501d66dcf239a3ff90d31bcd`. During
  verification `main` advanced to `8438d6686` (navigation ledger, CI runbook
  commit); a path-scoped diff over `app/modules/pdf-viewer` and
  `app/modules/workspace-shell` between the two is empty, so citations hold at
  both revisions.
- Method: six independent read-only verification passes (undo-redo,
  highlight/FreeText, sidebar and H1 trace, store/sync/persistence,
  shapes/serialization, and the audit's open interleaving and orphan-editor
  questions), each instructed to refute claims first and to trace reachability
  through production callers and existing tests. A synthesis pass by the
  session owner set the dispositions below. No files were modified and no
  tests were run during verification.
- Two verification transcripts abbreviated directory names in citations; this
  ledger uses canonical repo paths throughout (for example
  `annotations/bridge/pdfjs-runtime/useAnnotationSync.ts`, not
  `composables/annotations/...`). Paths are relative to
  `app/modules/pdf-viewer/` unless a longer prefix is shown.

## Status and priority vocabulary

| Term | Meaning |
| --- | --- |
| Confirmed | The cited condition exists in a reachable production path. |
| Partial | Part of the claim is true, but scope, mechanism, or impact is overstated. |
| Refuted | The current code prevents or contradicts the reported behavior. |
| P1 | A bounded corrective patch should be scheduled. |
| P2 | Add hardening or parity coverage before changing the area. |
| P3 | Cleanup only. Fold it into nearby work in the same area. |
| No action | Preserve the current behavior or evidence. |

No item is a verified P0. Seven items are P1: H2, M9, H1 (focus half), M6,
L8, M1, and Q1 (the print save-lease bypass, upgraded from the audit's
unverified risk list). The audit's two "High" headliners survive, but one of them (H1) at
half its claimed scope, and two of its Med-High items (M2, M3) fall to Low
because the mechanisms it feared are already guarded.

## Corrections to the audit

The audit's architecture description and most citations verified as written.
The following claims did not survive verification and should not be relied on.

Refuted:

1. **M5, empty selection boxes.** The local guard would accept `[]`
   (`annotations/bridge/pdfjs-runtime/useAnnotationHighlight.ts:324-365`), but
   the pinned pdf.js 5.7.284 never produces one: `getSelectionBoxes` returns
   `null` for collapsed, zero-area, or out-of-layer selections
   (`node_modules/pdfjs-dist/build/pdf.mjs:4189-4254`), and the cached-selection
   path rejects collapsed or out-of-text-layer ranges before restoration
   (`useAnnotationTextSelectionCache.ts:47-98`). No orphan entity is mintable
   through production input.
2. **M11, cross-page selections truncated to the start page.** They are
   rejected whole, not halved: pdf.js refuses a range whose common ancestor is
   outside the start text layer and returns `null`
   (`pdf.mjs:4194-4199,4251-4254`). What remains is only a silent no-op with
   debug-level logging (`useAnnotationHighlight.ts:617-629`).
3. **H1's delete half.** Sidebar shape deletion works. It routes through
   `createPageAnnotationDeleteActions.ts:131-142` into the mutation service,
   which resolves the shape canonically and tombstones it before the broken
   inner shape action's `false` return is ignored
   (`runtime/annotations/useAnnotationMutationService.ts:123-138`). Only shape
   focus is dead. There is also no arbitrary-shape hazard: production id
   misses resolve to `null`, not `undefined`
   (`annotations/domain/externalIdentityIndex.ts:71-82`).
4. **M3's mechanism.** `reconcileEditorPresence` does not require a prior
   external binding; it tombstones any missing, unsaved, non-deleted entity
   (`annotations/domain/annotationStore.ts:554-578`, especially `:567-576`)
   and runs after history replays
   (`runtime/sessions/createPdfAnnotationSession.ts:705-725`). Failed-binding
   orphans are transient, not permanent.
5. **M2's severity.** Normal page operations are shielded: structural ops go
   through a document reload that registers a `source: 'file'` ledger command
   (`app/modules/workspace-shell/composables/document-session/createDocumentHistory.ts:583-592`),
   and the new-document watcher clears annotation history on proxy swap
   (`runtime/sessions/createPdfAnnotationSession.ts:320-332`). The stale-undo
   window exists only for direct store callers during the asynchronous reload.
6. **M8's reachability.** pdf.js always assigns an annotation id, either the
   PDF reference or a generated `annot_...` value
   (`node_modules/pdfjs-dist/build/pdf.worker.mjs:51947-51972`), so the
   positional fallback is reachable only through mocks, alternate adapters, or
   upstream changes.
7. **L2's production impact.** Normal opens retain a working-copy path, which
   the store identity prefers
   (`runtime/sessions/createPdfAnnotationSession.ts:292-295`), and proxy
   replacement recreates the annotation application, so entities do not
   survive a collision in normal workspace flows.
8. **One M9 citation.** `createDocumentPersistence.ts:531-534` does set
   `state.error`; several persistence failures also surface through
   `WorkspaceDocumentAlerts.vue:4-10`. The reporting gap is real but narrower
   than cited (see M9 below).
9. **L1's exposure.** With a workspace sink attached (normal production), the
   raw `undoAnnotation`/`redoAnnotation` exposes read empty local stacks and
   no-op (`runtime/annotations/usePdfAppAnnotationHistory.ts:65-70,308-327`).
   No in-repo caller invokes them.
10. **L6's granularity.** The 220 ms debounce coalesces fast typing
    (`app/modules/workspace-shell/composables/useAnnotationNoteWindows.ts:339-363`);
    history gets one entry per quiet-period commit, not per keystroke. The
    eviction pressure on the 128-deep ledger remains for slow typing.

Audit open questions closed by verification:

- **Embedded-shape cache revision tokens.** Every page mutation bumps the
  token. Electron delete, reorder, insert, insert-file, rotate, crop, and
  remove-crop route through `transitionPageMutation`
  (`electron/features/page-ops/main/pageOpsMainBindings.ts:143-180,677-688`);
  browser mutations finish through `writePageMutationResult`
  (`app/platform/browser-api/createBrowserPageOpsCapability.ts:258-271`).
  Extract writes a new destination and workspace split is pane handling, not a
  page mutation. Refuted as a missing bump; a narrower in-flight fencing note
  is V3 below.
- **Deferred-delete undoability.** Confirmed undoable. The unwrapped
  `deleteCanonicalAnnotation` call still registers a before/after history
  entry through the store's own commit
  (`annotations/domain/annotationStore.ts:426-430,844-880`), pushed
  immediately when no transaction is active
  (`runtime/annotations/usePdfAppAnnotationHistory.ts:123-129`). What it lacks
  is atomicity with the pdf.js/DOM effects (V6 below).
- **Overlapping save transactions (Q1)** and **orphan editor after undoing a
  create (Q2)**: see "Resolved open questions" below.

Found during verification, not in the audit:

- **V1.** Per-page parse failures are worse than the audit's footnote: the
  failed page is counted as completed
  (`annotations/bridge/pdfjs-runtime/useAnnotationSync.ts:526-539`), the
  partial snapshot carries no failure field and is cached (`:553-559`,
  `:647-678`), and debug logging sits below the default threshold
  (`app/utils/browserLogger.ts:35,253-276`). Cache reuse preserves the
  omission beyond "the next sync".
- **V2.** The status bar has no failure state (idle, saving, dirty, clean
  only: `usePageStatusBar.ts:234-275`), so a failed save of an
  already-clean-looking document can present as clean.
- **V3.** In-flight embedded-shape imports are fenced by import token and
  path, not document revision
  (`runtime/annotations/useManagedEmbeddedPdfShapes.ts:414-418,631-638`).
  Completed cache entries are revision-safe; an in-flight old scan is not.
- **V4.** L8 is reachable through a first-class setting: root font size
  follows `--app-ui-scale` with presets 0.9/1.1/1.25
  (`app/assets/css/main.css:1085-1087`, `app/composables/useUiScale.ts:21-25`,
  `SettingsGeneralPanel.vue:55-67`). Row stride becomes ~100.8/123.2/140 px
  against a fixed 112 px virtual height.
- **V5.** The direct parser used at save finalize has no size assertion; the
  96 MiB guard lives only in the worker client
  (`engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient.ts:96-105`).
- **V6.** Deferred delete's tombstone, DOM removal, cache removal, and page
  invalidation are separate operations with no spanning transaction; visual
  effect failures are logged without rollback
  (`createPageAnnotationDeleteActions.ts:66-85`,
  `useAnnotationMutationVisualEffects.ts:110-125`).

## Disposition summary

| ID | Audit rating | Verified status | Corrected rating | Priority | Decision |
| --- | --- | --- | --- | --- | --- |
| H1 | High | Partial: focus dead, delete works | Medium | P1 | Match sidebar shape rows on `annotationId`; regression test first. |
| H2 | High | Confirmed | High | P1 | Propagate real creation success to callers; surface failures. |
| M1 | Med-High | Partial | Medium | P1 | Rebase outstanding history snapshots at `acknowledgeSave`; failing test first. |
| M2 | Med-High | Partial: shielded in production | Low | P3 | Pin the shield (page op clears annotation history) with a test; no code change. |
| M3 | Medium | Partial: orphans transient | Low | P3 | Add direct test: `reconcileEditorPresence` tombstones unbound transients. |
| M4 | Medium | Partial | Medium | P2 | Off-page round-trip fixture first, then stop rewriting unedited rects. |
| M5 | Medium | Refuted | None | No action | pdf.js never yields `[]`; optional one-line guard if touching the file. |
| M6 | Medium | Confirmed | Medium | P1 | Filter sink-mode forget by annotation ids instead of source-wide reset. |
| M7 | Medium | Confirmed | Medium | P2 | Truncation flag + warning + completeness metadata on snapshots. |
| M8 | Medium | Partial: not reachable via pdf.js | Low | No action | Record reachability; revisit only if a non-pdf.js source appears. |
| M9 | Medium | Partial | Medium | P1 | Report `not-saved` outcomes through the same surfacing as thrown saves. |
| M10 | Medium | Partial: conditional, unguarded | Medium | P2 | Route save priming through the worker client; enforce the size guard. |
| M11 | Low-Med | Refuted as truncation | Low | P3 | Fold a user-visible rejection signal into the H2/M9 surfacing work. |
| L1 | Low | Partial: near no-op in workspace mode | Low | P3 | Delete or gate the raw undo/redo exposes. |
| L2 | Low | Partial: impact refuted | Low | P3 | Key store identity by Blob instance (WeakMap) like the snapshot side. |
| L3 | Low | Partial | Low | P3 | Reschedule the debounced persist when `saving` clears. |
| L4 | Low | Confirmed | Low | P3 | Surface note-window delete misses like the instrumented sibling path. |
| L5 | Low | Partial | Low | P3 | Set `estimatedBytes` on canonical snapshot commands when touching history. |
| L6 | Low | Partial | Low | P3 | Coalesce successive note-text commands per annotation, or accept. |
| L7 | Low | Confirmed | Low | P3 | Delete stale `/IC` when updating Line dicts; keep `/LE` behavior. |
| L8 | Low | Confirmed, reachability understated | Medium | P1 | Derive virtual row stride from the effective root font size. |
| V1 | — | Confirmed | Medium | P2 | Bundle inventory-completeness status with M7. |
| V2 | — | Confirmed | Medium | P1 | Fold a failure state into the M9 surfacing slice. |
| V3 | — | Confirmed, narrow | Low | P3 | Add document-revision check to the in-flight import fence. |
| V4 | — | Confirmed | — | — | Evidence for L8's P1; no separate item. |
| V5 | — | Confirmed | Low | P2 | Part of the M10 slice. |
| V6 | — | Confirmed | Low | P3 | Add an e2e asserting undo of a deferred delete restores editor/DOM state. |
| Q1 | Risk (unverified) | Proven: print bypasses the save lease | Medium | P1 | Route dirty print through the document operation lease; add a race test. |
| Q2 | Risk (unverified) | Proven for live sessions | Medium | P2 | Run the MutationObserver experiment; fix editor removal on undo-of-create if confirmed. |

## P1 items

### H2, creation success is reported unconditionally

`useAnnotationHighlight.ts:356-367` hard-codes `createdAnnotation = true`
after submitting the canonical intent; mode-switch and editor failures are
caught, logged at debug level, and still return success (`:565-601`).
`createTextMarkupFromText` exposes the value as `created` (`:763-768`), and it
is consumed by the workspace automation expose
(`app/modules/workspace-shell/expose/createWorkspaceExpose.ts:460-465`) and
the document agent (`agent/useDocumentWorkspaceAgent.ts:763-777`). A point
comment also treats `true` as success and skips its fallback
(`useAnnotationHighlight.ts:940-949`).

Acceptance checks:

1. The function returns the actual outcome: intent submitted, editor bound, or
   failed with a reason.
2. Automation and agent callers receive the failure.
3. Unit tests cover mode-switch throw, retry exhaustion, and null editor
   results; all currently pass against the hard-coded flag and must fail
   against it after the change.

### M9 and V2, not-saved outcomes bypass reporting

`useWorkspaceSaveService.ts:931-955` returns `false` for `status:
'not-saved'` without setting an error or showing a toast; the toast lives only
in the exception handler (`:1080-1111`). Reachable producers include failed
open-note persistence (`:1030-1042`), validation rejection (`:292-317`), and
optional capability failures
(`createDocumentPersistence.ts:609-611,659-661`). The status bar has no
failure state (`usePageStatusBar.ts:234-275`), so a failed clean-looking save
presents as clean.

Acceptance checks:

1. Every `not-saved` return sets state or user-visible feedback equivalent to
   the thrown-save path.
2. A service-level test asserts the surfacing for at least validation
   rejection and note-persistence failure.
3. The M11 silent rejection (cross-page selection) reuses whatever surfacing
   primitive this slice introduces, or documents why not.

### H1, sidebar shape focus matches a field that is never set

`tools/usePdfShapeTool.ts:110-121` matches shapes against
`comment.appAnnotationId`; shape summaries never carry it
(`engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary.ts:30-49`),
and no enrichment site exists (decisive repo-wide trace; the only
sidebar-capable enrichment, `annotationApplication.ts:370-418`, has no call
site). Row click opens the sidebar and sets the active key, then returns
before focusing (`usePdfAnnotationCommentActions.ts:54-57`).

Acceptance checks:

1. A regression test drives a shape summary through
   `findShapeForAnnotationComment` and fails before the fix.
2. Fix by matching on `annotationId` (or by setting `appAnnotationId` in the
   summary factory); pick one and delete the dead alternative.
3. Fold L4 in: the note-window `deleteAnnotationById` miss logs or surfaces
   like `createPageAnnotationDeleteActions.ts:88-97`.

### M6, sink-mode forget wipes unrelated annotation history

Local mode filters forgotten commands by id; sink mode resets the entire
`annotation` source (`runtime/annotations/usePdfAppAnnotationHistory.ts:131-145`,
`app/modules/workspace-shell/composables/useWorkspaceCommandLedger.ts:62-99`).
The sink is attached in normal production
(`useWorkspaceOrchestration.ts:228-249`), and forget runs on deleted-shape
cleanup, shape replacement, and unmatched-import cleanup
(`annotations/domain/annotationStore.ts:417-424,936-945,972-994`).

Acceptance checks:

1. Ledger gains id-scoped removal within a source; sink-mode forget uses it.
2. A test registers two annotation commands, forgets one id, and asserts the
   other remains undoable (the current suite cannot detect this).

### L8, fixed 112 px virtual stride under UI scaling

`PdfAnnotationCommentsList.vue:216-223` fixes `itemHeight: 112`; rows are
rem-based (`:515-531`, `app/assets/css/main.css:260-262`) and root font size
follows the UI scale presets 0.9/1.1/1.25 (V4). At non-default scale the list
overlaps or gaps.

Acceptance checks:

1. Row stride derives from the effective root font size (or the row height
   moves to pixels; pick one and state why).
2. A test covers at least one non-default scale.

### M1, history snapshots go stale across save acknowledgement

`acknowledgeSave` adds `persistedRevision`, binds `pdfRef`, and rebases the
semantic baseline without touching history
(`annotations/domain/annotationStore.ts:721-751`); commands hold absolute
before/after clones and replay them wholesale (`:844-880,901-928`). Redo of a
pre-save create restores `persistedRevision: -1` without `pdfRef`, flipping
the entity dirty. The audit's duplicate-on-next-save consequence is
conditional: save verification also matches canonical id, `pdfName`,
`pdfjsUid`, `elementId`, and sticky-note semantic fallback
(`annotationApplication.ts:642-709`), but some delete serialization does key
off `pdfRef` (`engine/pdf-serialization-operations/serializePdfEdits.ts:16-55`).

Acceptance checks:

1. A failing unit test first: edit, save, undo, redo, then assert
   `persistedRevision` and `pdfRef` survive redo.
2. Preferred fix is rebasing identity fields into outstanding snapshots at
   `acknowledgeSave` (the audit's rebase option); wholesale replay stays.
3. The M2 shield gets pinned in the same slice: a test asserting a structural
   page op clears annotation history via the proxy-swap watcher.
4. An e2e extends `annotationLifecycle` to assert identity fields, not just
   counts and dirty bits.

### Q1, dirty print runs a save transaction outside the document lease

Evidence and mechanism in "Resolved open questions" below.

Acceptance checks:

1. The dirty-print path acquires the same document operation lease as saves,
   split capture, page mutations, and shutdown flush before calling
   `runSaveTransaction`.
2. A test holds two transaction commits open and asserts the second waits (or
   fails) instead of both passing `assertAnnotationSaveCurrent()` across one
   acknowledgement.

## P2 items

### Q2, orphan editor and entity resurrection after undoing a create

Evidence, mechanism, and the exact closing experiment in "Resolved open
questions" below. Diagnose first; the fix (editor removal in the canonical
undo pair, or DOM-removal effects on hard delete) lands in the same slice if
the orphan reproduces. This interacts with the M1 history slice; sequence Q2
after M1's tests exist.

### M4, import clamping rewrites off-page geometry

Clamping happens twice on import
(`engine/annotation-geometry/toMarkerRectFromPdfRect.ts:124-129`,
`normalizeMarkerRect.ts:16-30`) and the clamped rect is written back when
shape state is dirty (`useWorkspaceSaveService.ts:458-467`,
`applyShapeAnnotations.ts:206-221`). Left/top crossings shift the rectangle
rather than intersecting it. Ink and polyline points are not clamped, so
behavior is type-dependent. Requires editing any shape in the document, then
saving, to damage an untouched off-page shape.

Order: fixture first (an embedded Square straddling the trim box through
open, unrelated shape edit, save, reopen), then either stop clamping imported
geometry or only serialize rects whose marker geometry actually changed.

### M7 and V1, inventory completeness is silent

Global caps break silently and the truncated snapshot is cached beyond
revision changes (`useAnnotationSync.ts:125-129,500-511,553-559,590-661`);
failed pages count as completed (`:526-539`). Add a completeness field to the
snapshot, warn on truncation or page failure, and surface it wherever the
sidebar shows loading state. Tests: a capped scan and a failing page both
produce the flag and the warning.

### M10 and V5, save-finalize parses on the UI thread without a size guard

`useManagedEmbeddedPdfShapes.ts:700-714` imports the direct parser at save
priming; runs only for serialized saves with dirty shape state or native saves
with shape mutations (`useWorkspaceSaveService.ts:550-560,739-748`), so it is
conditional, but the direct call has no 96 MiB assertion and the 64 MiB
working-copy guard does not cover automation or native paths. Route priming
through the worker client and inherit its guard; test that priming uses the
worker.

## P3 batch

Fold these into work that already touches their area; none justifies a
standalone change:

- M2 pin test and M3 reconciliation test (with the M1 slice).
- M11 rejection signal (with the H2/M9 surfacing slice).
- L1: delete the raw `undoAnnotation`/`redoAnnotation` exposes
  (`createPdfAnnotationSession.ts:1015-1021`,
  `usePdfViewerPublicApiController.ts:251-255`); they are a no-op with a sink
  attached and have no in-repo caller. Prefer deletion per the design charter.
- L2: WeakMap-keyed store identity for pathless blobs, mirroring
  `createPdfAnnotationSession.ts:119-141`.
- L3: reschedule the note persist when `metadata.saving` clears
  (`useAnnotationNoteWindows.ts:379-388,417-422`).
- L4 (with H1). L5, L6 (with any history work). L7 (with any serialization
  work): delete `/IC` in `applyLineAnnotationStyle`
  (`applyShapeAnnotations.ts:156-163`), mirroring the PolyLine cleanup
  (`:165-181`).
- V3: include the document revision in `isStaleEmbeddedShapeImport`
  (`useManagedEmbeddedPdfShapes.ts:414-418`).
- V6: e2e asserting undo of a deferred delete restores editor and DOM state,
  not only the canonical entity.

## Resolved open questions

### Q1, overlapping save transactions: proven, print bypasses the lease

Normal saves, split capture, page mutations, and shutdown flush all serialize
through the document-wide FIFO lease
(`app/modules/workspace-shell/document-sessions/workspaceDocumentController.ts:403-430`;
save entry at `useWorkspaceSaveService.ts:1001-1026`; split at
`useWorkspaceSplitPayload.ts:111-155`; page ops at
`runtime/composables/pdf/usePageOperations.ts:262-275`; shutdown via
`usePageSaveOrchestration.ts:347-349`). Dirty print calls
`pdfViewerRef.runSaveTransaction` directly with no lease
(`useWorkspaceOrchestration.ts:722-741,817-835`), and `runSaveTransaction`
itself has no single-flight guard and awaits several interleaving points
(`runtime/save/usePdfViewerSaveTransaction.ts:451-520,631-665`).

The CAS race the audit feared is real: the frontier baseline hashes only
`{id, revision, deleted, pageIndex}`
(`engine/annotations/domain/annotationEntity.ts:164-171`), and
`acknowledgeSave` leaves `revision` unchanged, so a second frontier can pass
after the first acknowledgement (`annotationStore.ts:721-751,781-815`).
Mitigations: print returns bytes without `commitAnnotationSave`, and backend
writes carry document-revision checks and are serialized per document
reference. Whether the race can produce duplicate durable bytes is still
open; the guard hole itself is proven. Disposition: P1, route dirty print
through the same lease.

### Q2, orphan editor after undoing a create: proven for live sessions

Toolbar-highlight creates install their pdf.js undo pair with
`skipAppHistory: true` (`app/services/pdfjs/annotationEditorAdapter.ts:415-452`),
so canonical undo (`before: null` applied at
`annotationStore.ts:882-927`) hard-deletes the entity without any editor
removal: `finishReplay` reconciliation mutates entities only
(`createPdfAnnotationSession.ts:705-727`, `annotationStore.ts:546-578`),
presentation-cleared strips styles not elements, and the hidden-id set only
covers tombstoned entities, which a hard delete is not. Worse, the deferred
comment resync can rescan the orphan editor and recreate the deleted entity
(`annotations/bridge/pdfjs-runtime/useAnnotationSync.ts:725-736,801-803`,
`annotationApplication.ts:109-132`), so an undone create can come back.

The existing e2e does assert the count drops
(`tests/e2e/electron/annotationLifecycle.e2e.test.ts:1499-1518`), but its
helper counts `.highlightEditor` and `.highlightAnnotation` together across
visible hosts (`helpers/viewerAnnotations.ts:203-233`), so it cannot say
which node disappeared, and the traced canonical path contains no removal
call. Closing experiment (specified during verification): wrap the undo in a
test-only MutationObserver recording removed editor nodes, manager identity,
and counts at the synchronous undo, two animation frames, and the deferred
sync task. Disposition: P2, diagnose first; if the orphan reproduces, the fix
is to register editor removal in the canonical undo pair (or run the existing
DOM-removal effects on hard delete), which also kills the resurrection path.

## Suggested implementation order

1. **Surfacing slice** (#91): H2 + M9 + V2, with M11's signal riding along.
   One shared failure-surfacing primitive covers the audit's "silent failure
   is a pattern" synthesis without inventing per-site toasts.
2. **Sidebar shape slice** (#92): H1 focus fix + L4, regression tests first.
3. **Save integrity slice** (#93): Q1's print lease. Small, isolated, and it
   closes the only proven overlap path before any history work changes
   timing.
4. **History integrity slice** (#97, #98): M6, then M1 with the M2/M3 pin
   tests and the L1/L5/L6 fold, then the Q2 diagnostic and conditional fix
   (#100, blocked by #98). M1 is the deepest change; its failing tests define
   the contract before the rebase lands.
5. **Layout slice** (#99): L8.
6. **P2 hardening**: M4 fixture then fix (#101, with L7); M7+V1 completeness
   (#102); M10+V5 worker routing (#103, with V3).
7. **P3 batch**: homeless leftovers L2 + L3 in #104; the rest ride their host
   slices above.

A finding closes when the corrective change and its regression test land and
this ledger's row is updated with the commit. Verification transcripts for
this ledger live outside the repo (`/tmp/codex-skill/annot-*-last.md`,
session artifacts); the evidence that matters is re-derivable from the
citations above.
