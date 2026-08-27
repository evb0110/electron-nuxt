# Large-document audit ledger

Date: 2026-08-27

Audit baseline: `0e24ed9c4cd589da32defd545551088dd29e2553`

The primary checkout is dirty beyond this baseline. No audit item below is
closed solely by baseline evidence. The current save work is also uncommitted,
so a reported active patch is not a fix SHA or a passing gate.

The four Markdown reports were read in full. The telemetry JSON was read only
for the fixture object and scalar or summary fields needed for fixture evidence.
Report references below are relative to
`.devkit/analysis/exhaustive-audit-20260827/`.

## Fixture identity

| Fixture | Role or path | Bytes | Pages | SHA-256 | Provenance and admission |
| --- | --- | ---: | ---: | --- | --- |
| Local artifact | `/Users/evb/Desktop/pdf/Зализняк А.А. Грамматический словарь русского языка. Словоизменение. 1980.pdf` | 722178517 | 882 | `1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6` | Primary-checkout evidence; qpdf page count and `qpdf --check` passed; filesystem birth/modified around 2026-08-27 19:37 |
| Audited VPS 882-page artifact | `/home/ubuntu/services-infra/data/cloud/zaliznyak-722176299-882p-4f5c6a43.pdf` | 722176299 | 882 | `4f5c6a438f19a0b19faff37882be6f0bc9199fbf6ba5d0694ab25d4d32ce897b` | Supplied VPS source; `stat`, qpdf page count, SHA-256, and source `qpdf --check` passed |
| Xlarge artifact | `/home/ubuntu/services-infra/data/cloud/zaliznyak-2168527413-2646p-5609c151.pdf` | 2168527413 | 2646 | `5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea` | Supplied VPS source; source `stat`, qpdf page count, SHA-256, and `qpdf --check` passed; telemetry staged the same byte count and page count |

Fixture evidence is in `full-audit.md:124-130`, `linux-flow-audit.md:16,43-46,95-101`,
and `xlarge-followup-telemetry.json:2-12`. The xlarge scalar summary records a
67,025.1 ms Session B save phase at `xlarge-followup-telemetry.json:68-70`, a
3,350 ms maximum heartbeat gap in the report at `linux-flow-audit.md:132-143`,
and a Session B renderer heap delta of 108,776,424 bytes at
`linux-flow-audit.md:143`.

The local artifact is not equivalent to the audited VPS artifact even though
the document name matches. The local file is 722178517 bytes with SHA-256
`1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6`; the VPS
file is 722176299 bytes with SHA-256
`4f5c6a438f19a0b19faff37882be6f0bc9199fbf6ba5d0694ab25d4d32ce897b`.

## Ledger fields and deduplication

Each entry includes a stable ID, severity, classification, finding, exact
evidence, the required red regression test or probe, owner/status, fix SHA,
gates, and remaining acceptance. `parent-triage` means the parent task must
assign and sequence the work. `active-save-patch` means the item is in the
scope of the uncommitted save work and must be reconciled against that diff.

Distinct finding count: **102**.

Ambiguous deduplication decisions:

- `SAV-008` combines the full-audit original-path race with the native report's
  compare-and-swap wording because they describe one JavaScript publication
  race. `SAV-011` remains separate because `AtomicOutput` also has symlink
  replacement behavior and a separate native helper boundary.
- `SAV-009` combines the full-audit and native eager-copy findings. `SAV-019`
  combines their protocol-handshake findings. `CAP-001`, `CAP-002`, and
  `CAP-003` retain separate cap rows even where individual selection or
  annotation rows describe their user-visible symptoms.
- `TEST-014` combines the repeated fixture-hash admission gap. `TEST-021`
  through `TEST-023` remain separate because committed-event observation, a
  post-save process restart, and a second save are separate acceptance gates.
- Repeated unproven behaviors are represented once in `TEST-024` through
  `TEST-027` and again only as checklist wording where the reports require the
  same gate. Rejected hypotheses and confirmed bounded paths are listed after
  the ledger and are not counted as findings.

All rows currently have `Fix SHA: pending` and `Gates: pending`. The reports
contain no committed implementation SHA that proves a current fix.

Parent active-save-patch evidence is recorded without closing any row. The
current original-file-witness regression passes 43/43 across working-copy and
original-path matching tests. Exact local session
`e2e-run-mtc4slgp-fe40cf-large-pdf-1787871961357` completed the strict macOS
acceptance flow against the admitted local fixture. Real visible pointer and
keyboard input created and edited sticky notes. Live PDF.js annotation storage
and dirty state were asserted. Both saves observed the exact committed event
and native route. Two hard Electron restarts restored clean state and both
commits. The staged artifact, original, and working copy shared SHA-256
`ab5bdc589ec6ea2aac646d6959834a6746a5dbad0a58b29b7e50a39d8016db63`.
Bounded qpdf object checks and `qpdf --check`, the runtime IPC probe, and strict
process teardown passed. The test passed in 134.240 s, with 169.41 s total
runner time. Linux visible-Xvfb and hidden acceptance remain required before a
row receives a fix SHA or closes.

The latest exact local-fixture run reproduced `SAV-001` after the real macOS
clone path was enabled in the E2E app. Session
`e2e-run-mtbvb63n-0e8893-large-pdf-1787856031691` reached the native staged
commit in 1.018 s, then failed closed. Instrumentation recorded
`missing original file expectation` in `originalPathSaveBaseMatches` and a
native staged commit result of `{applied:false,validation:null}`. This rules
out native mutation failure for that run and confirms that the normal
unencrypted clone path omitted the original-file witness required by commit.
The source fix removes deferred original-file expectations from the three
normal mapped working-copy creation routes. Its real-store regression and the
strict macOS acceptance are green. The row remains open and has no fix SHA
because the required Linux visible and hidden acceptance has not passed yet.

## Save and working-copy correctness

| ID | Severity | Class | Finding | Evidence | Required red regression test or probe | Owner/status | Fix SHA | Gates | Remaining acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SAV-001 | High | product | Normal clone or eager working-copy paths can omit the original-path expectation, so native save reports a false source mismatch. | `full-audit.md:15` cites `originalPathSaveBaseMatches.ts:19-22`, working-copy creation and materialization, native save handlers, and a 20-iteration loop failing on iteration 4. Exact local session `e2e-run-mtbvb63n-0e8893-large-pdf-1787856031691` independently reproduced the missing expectation after native staging completed. | Repeat the focused routes across normal clone and eager working-copy creation; assert native save accepts the matching original and working-copy revision. | active-save-patch/macos-acceptance-green | pending | 43/43 focused tests passed; strict macOS session `e2e-run-mtc4slgp-fe40cf-large-pdf-1787871961357` passed two saves and two hard restarts with committed-event, hash, qpdf, runtime IPC, and teardown checks | Pass the same exact source tree and fixture through separate Linux visible-Xvfb and hidden cases. |
| SAV-002 | Critical | product | An original can be committed while sidecar or cleanup failure leaves the working copy, sidecar, or journal at a different revision. | `full-audit.md:16` cites `transitionOriginalAndWorkingCopyRevision.ts:46-92` and `documentRevisionStore.ts:318-331`; rollback does not restore sidecar or journal. | Inject a sidecar or cleanup failure after replacement; assert original bytes, working-copy bytes, sidecar, and journal all return to one revision. | active-save-patch | pending | pending | Prove rollback restores every durable record and no committed state diverges after each failure point. |
| SAV-003 | High | product | Transition copies into the working copy with `durable:false` before writing the durable sidecar, so a crash can split file bytes from the trusted revision token. | `full-audit.md:17`. | Stop the process between the non-durable copy and sidecar write; reopen and assert the file bytes and trusted revision token agree. | active-save-patch | pending | pending | Add crash-boundary coverage and prove recovery rejects or repairs an out-of-sync pair. |
| SAV-004 | High | product | Save As can commit the target, then report failure when a later step rejects the result, while the renderer keeps the old original path. | `full-audit.md:18` cites `documentSave.service.ts:150-160,251-268`, `serializedPdfPersistence.ts:647-706`, and `createDocumentPersistence.ts:1103-1113,1167-1173`. | Force the post-commit rejection; assert the returned result, renderer path, target bytes, and subsequent save all describe the same target. | active-save-patch | pending | pending | Prove Save As state changes are committed or rolled back as one externally visible transaction. |
| SAV-005 | High | product | The native mutation handler captures the original path before queue entry, so a queued request can use a path remapped by a preceding Save As. | `full-audit.md:19` cites `nativePdfMutationSaveHandlers.ts:287-295,472-480`, `workingCopySave.ts:258-270,298-307,437-450`, and `documentSave.service.ts:131-157`. | Queue a native mutation, perform Save As before it runs, then assert the mutation writes only to the remapped target and its receipt. | active-save-patch | pending | pending | Resolve path and revision at the serialized execution point and prove queued Save As ordering. |
| SAV-006 | Medium | product | Rust incremental copy-on-write cloning can inherit mode `0444`, fail to reopen read/write, and abort without its streaming fallback. | `full-audit.md:20` cites `native/evb-native-support/src/output.rs:103-142` and `native/pdf-page-ops/src/incremental.rs:169-189`. | Create a read-only clone destination and run incremental save; assert the tested streaming fallback completes or returns a typed refusal without aborting. | active-save-patch | pending | pending | Cover permission-preserving clone, reopen, fallback, and exact large-file save behavior on macOS and Linux. |
| SAV-007 | High | product | The second save in the audited exact-file interaction chose the serialized fallback and was rejected as `native-save-required`. | `full-audit.md:21`. The strict macOS acceptance now proves the actual restored sticky-note case, rather than ordinary clean FreeText hydration. | In a fresh process, save an annotation, hard-restart Electron, reopen the committed file, make a second annotation edit, and assert the second save uses the native path and commits. | active-save-patch/macos-acceptance-green | pending | strict macOS session `e2e-run-mtc4slgp-fe40cf-large-pdf-1787871961357` completed the second native save after restart, then restarted and verified both commits | Repeat the same second-save and second-restart flow on Linux visible-Xvfb and hidden modes. |
| SAV-008 | High | product | Original-path save is a check-then-rename race. An external editor or sync client can change the original after the base check and before unconditional replacement. | `full-audit.md:32`; `native-crosscut-audit.md:14-54` cites `workingCopySave.ts:181-195`, `transitionOriginalAndWorkingCopyRevision.ts:35-65`, `originalPathSaveBaseMatches.ts:95-109`, and `atomicReplace.ts:133-138`. | Pause after a successful base comparison, replace the original from a second process with same-size content, release the save, and assert the external bytes remain. | active-save-patch | pending | pending | Add an OS-level identity or compare-and-swap publication proof, including concurrent external edits. |
| SAV-009 | Medium | product | Eager `copyFile` fallback can create a mixed working-copy snapshot while the source changes, without post-copy handle, stat, or hash proof. | `full-audit.md:93`; `native-crosscut-audit.md:56-88` cites `workingCopyCreation.ts:112-153` and contrasts the safer lazy path. | Force an unsupported clone, replace the source from a second process during copy, and assert the working copy matches one complete source revision. | parent-triage | pending | pending | Add source admission and post-copy verification or a safe open-handle copy path. |
| SAV-010 | High | product | Native incremental save can parse one source state with qpdf, then copy a newer source before append. | `full-audit.md:94`. | Change the source between qpdf structural admission and the copy; assert the append aborts or re-admits the same source revision. | parent-triage | pending | pending | Tie qpdf admission, source copy, and append to one revision witness. |
| SAV-011 | High | product | `AtomicOutput` checks metadata and renames later, sharing the external-edit race; replacing a symlink also changes the link into a regular file. | `full-audit.md:98`. | Exercise external replacement between witness and rename, then exercise a symlink destination; assert external bytes survive and link semantics follow the intended contract. | parent-triage | pending | pending | Specify and test compare-and-swap semantics and symlink policy for every atomic output caller. |
| SAV-012 | Medium | product | Reflink fallback can perform a physical multi-gigabyte copy and fail with `ENOSPC` without a capacity-aware plan. | `full-audit.md:99`. | Constrain free space below the source size, force reflink fallback, and assert a bounded refusal before a partial working copy is registered. | parent-triage | pending | pending | Add capacity admission, cleanup, and an exact error contract for large fallback copies. |
| SAV-013 | Medium | process | Killing a save utility can kill its wrapper while leaving a qpdf child alive. | `full-audit.md:100`. | Start a save utility whose qpdf child blocks, kill the wrapper, and assert the child process group is gone before the operation settles. | parent-triage | pending | pending | Prove descendant cancellation and final child liveness on timeout and forced stop. |
| SAV-014 | High | product | The mutation queue has no sender-lifecycle ownership, so save optimization and validation signals can be lost between stages. | `full-audit.md:101`. | Close or replace the sender at each queue stage; assert the operation fails closed or completes with a durable receipt and no lost signal. | parent-triage | pending | pending | Define queue ownership, settlement, and sender teardown semantics and test every stage boundary. |
| SAV-015 | Medium | process | Lazy materialization has no renderer teardown hook, so staged artifact leases can survive renderer death for five minutes. | `full-audit.md:102`. | Kill the renderer during materialization, assert lease release or bounded expiry, and check no stale staged handle remains usable. | parent-triage | pending | pending | Tie lease ownership to renderer lifecycle and prove cleanup after abnormal teardown. |
| SAV-016 | Medium | process | Serialized completion can race sender cleanup and settle after the sender is gone. | `full-audit.md:103`. | End the sender at completion boundaries and assert one deterministic settlement with no late callback or unhandled rejection. | parent-triage | pending | pending | Add sender-lifecycle synchronization and completion-order coverage. |
| SAV-017 | Medium | product | Image-placement handles leak on cancel or failure. | `full-audit.md:103`. | Cancel and fail image placement at each native and renderer boundary; assert all handles are released and a retry starts cleanly. | parent-triage | pending | pending | Prove handle ownership and cleanup for cancel, error, close, and restart paths. |
| SAV-018 | Medium | process | Selected-page qpdf work, optimization, and post-save validation ignore print or export cancellation. | `full-audit.md:104`. | Abort each operation during qpdf, optimization, and validation; assert child work stops and no output is reported committed. | parent-triage | pending | pending | Thread one cancellation signal through every selected-page save and export stage. |
| SAV-019 | Low | process | Protocol-handshake cancellation rejects the caller while the `--protocol-version` child continues until timeout or natural exit. | `full-audit.md:103`; `native-crosscut-audit.md:90-116` cites `runNativeToolCommand.ts:49-56,84-109,117-152`. | Use a helper that sleeps on `--protocol-version`, abort the caller, and assert the helper PID or detached process group is gone before rejection. | parent-triage | pending | pending | Propagate signal, cancel-group, and termination options through the handshake and prove child liveness. |

## PDF page metadata and annotation persistence

| ID | Severity | Class | Finding | Evidence | Required red regression test or probe | Owner/status | Fix SHA | Gates | Remaining acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF-001 | Critical | product | Structural page operations can delete unopened outlines because the lazy bookmark state is empty when metadata is captured. | `full-audit.md:25` cites `PdfSidebar.vue:87-98,359-371`, `useBookmarkState.ts:19-42`, `usePageOperations.ts:159-175`, `pageOpsMainBindings.ts:156-169`, and `native/pdf-page-ops/src/catalog.rs:437-446`. | On a PDF with outlines, never open the bookmark panel, rotate/delete/reorder/crop/move/insert, save, reopen, and assert the outline tree is unchanged. | parent-triage | pending | pending | Preserve outlines for every listed operation and prove lazy state is not treated as empty metadata. |
| PDF-002 | Critical | product | Structural page operations on documents over 200 pages can replace custom page labels with default numbering. | `full-audit.md:26`; `cap-audit.md:62-82` gives the 201-page probe and null-to-empty remap call graph. | Run the null-label remap unit case and a 201-page labeled PDF rotate/save/reopen test; assert every label range survives. | parent-triage | pending | pending | Use the compact range model as source of truth and never emit `ranges: []` for an unmaterialized compatibility array. |
| PDF-003 | High | product | Imported `/Text` annotations with Popup notes disappear from the canonical annotation model. | `full-audit.md:27` cites `buildPdfAnnotationCommentSummary.ts:78-91,159-222` and `annotationApplication.ts:228-229`; direct probe returned `hasNote:false` and zero entities. | Import a `/Text` annotation with a Popup, assert the canonical entity has a note, save without edits, reopen, and assert the entity remains. | parent-triage | pending | pending | Preserve imported sticky-note parent and note identity through import, save, and reopen. |
| PDF-004 | High | product | Moving an imported sticky note changes text and modification time but has no native geometry update, so reopen restores the old location. | `full-audit.md:28` cites `useAnnotationMutationService.ts:226-259`, `classifyPdfSaveRoute.ts:300-309`, and `native/pdf-page-ops/src/annotations.rs:1215-1319`. | Import a sticky note, move it, save, hard-restart, reopen, and compare its page and rectangle with the moved location. | parent-triage | pending | pending | Add a canonical geometry mutation and verify location in an independent reopen check. |
| PDF-005 | High | product | Browser recent-file pruning can delete durable IndexedDB documents when its localStorage list update fails. | `full-audit.md:29` cites `browserRecentFilesStore.ts:100-125`, `localStorage.ts:20-36`, and `browserDocumentMaintenance.ts:143-166`. | Make the localStorage write fail during pruning; assert the durable IndexedDB records remain and only the intended recent-file list changes. | parent-triage | pending | pending | Make versioned durable state, not a failed localStorage write, the deletion authority. |
| PDF-006 | High | product | Native small split, text overlay, and conformance paths can destructively write the requested output, corrupting same-path or hard-linked sources on failure. | `full-audit.md:30` cites `split_pages.rs:673-779`, `text_layer.rs:1593-1632`, and `conformance.rs:48-83`. | Use same-path and hard-link outputs, force a mid-write failure, and assert the source remains byte-identical and readable. | parent-triage | pending | pending | Stage through atomic output for every path and prove failure leaves source and destination well-defined. |
| PDF-007 | High | product | Browser page operations can drop both `/Outlines` and `/PageLabels`. | `full-audit.md:31` cites `createBrowserPageOpsCapability.ts:317-517`, `browserPageOpsCore.ts:182-300`, and WASM `page_tree_ops.rs:383-465`; direct before-and-after probe confirmed loss. | Run browser delete, reorder, and insert on a PDF containing both dictionaries; assert both survive save and reopen. | parent-triage | pending | pending | Preserve browser metadata parity with the native page-operation path. |
| ANN-001 | High | product | Imported native text-markup note edits materialize the whole PDF in PDF.js because native projection omits note text. | `full-audit.md:38` cites `classifyPdfSaveRoute.ts:300-309,382-389` and `nativeMarkupMutations.ts:115-123`. | Import a native text-markup annotation with a note, edit only its note, instrument PDF.js materialization, and assert the native bounded route is used. | parent-triage | pending | pending | Project note text natively or explicitly bound the renderer path without whole-document reads. |
| ANN-002 | High | product | Imported non-point FreeText edits still use full renderer materialization. | `full-audit.md:39` cites `pdfAnnotationStorageChanges.ts:321-366`. | Import a non-point FreeText box, edit text or style, and assert no full-PDF renderer materialization occurs. | parent-triage | pending | pending | Add a native mutation route or a documented bounded fallback with exact large-file coverage. |
| ANN-003 | High | product | Imported shapes retain stale `/AP` appearance streams after geometry or style edits, so external readers may draw the old appearance. | `full-audit.md:40` cites `applyShapeAnnotations.ts:210-329` and Rust `shapes.rs:317-385`. | Import a shape, change geometry and style, save, reopen in an independent reader or qpdf object probe, and assert the appearance matches the dictionary. | parent-triage | pending | pending | Regenerate or remove stale appearances and prove visual and object-level parity. |
| ANN-004 | High | product | Placed images have no canonical reopen, update, or delete lifecycle. They are written as stamps and omitted from the imported entity model. | `full-audit.md:41` cites `applyPlacedImage.ts:15-123` and `nativePdfMutations.ts:655-669`. | Place an image, save, hard-restart, reopen, update it, delete it, and assert each state survives without orphan stamps. | parent-triage | pending | pending | Define canonical image identity and complete import, mutation, reopen, and deletion semantics. |
| CAP-001 | High | product | Native mutation arrays reject a whole request above fixed collection caps instead of batching or continuing. Caps are 256 notes or editors, 2,048 page-label ranges, 5,000 bookmarks, 4,096 shapes or markup items, and 16 images. | `full-audit.md:42`; `cap-audit.md:17-41` proves preload, platform, and main normalization enforce the caps. | For each family, invoke a save with `limit + 1` valid entries and assert explicit chunking or sparse continuation rather than pre-native rejection. | parent-triage | pending | pending | Keep per-item and byte refusals, but never fail a valid collection solely at a batch boundary. |
| SEL-001 | High | product | Selection above 100,000 pages becomes an empty legacy array for agent, exposed API, and menu consumers. | `full-audit.md:46` cites `useWorkspaceViewerShellState.ts:49-53` and `useDocumentWorkspaceAgent.ts:969-1008`. | Select more than 100,000 pages through each consumer and assert the exact compact selection remains available without an empty-array all-pages sentinel. | parent-triage | pending | pending | Preserve compact selection identity in every consumer and IPC boundary. |
| SEL-002 | High | product | Export and print dialogs can convert a partial compact selection into all pages. | `full-audit.md:47` cites `useWorkspaceExport.ts:480-513` and `usePdfPageScopeSelection.ts:45-49`. | Submit a compact partial selection too large for explicit materialization; assert export and print receive exactly that selection, not all pages. | parent-triage | pending | pending | Use range or stream transport, or show an explicit refusal. Never reinterpret partial as all. |
| SEL-003 | High | product | Thumbnail context-menu actions apply only to the clicked page instead of the compact multi-selection. | `full-audit.md:48` cites `usePdfThumbnailSelection.ts:231-241` and `pdfPageSelection.ts:62-73`. | Select a compact multi-range, invoke the thumbnail context action on one page, and assert every selected page receives the operation. | parent-triage | pending | pending | Preserve selection semantics between thumbnail, shell, and page-operation handlers. |
| SEL-004 | High | product | Manual input such as `1-1000000` allocates a million-element array before IPC validation rejects it. | `full-audit.md:49`. | Submit a million-page range under an allocation budget; assert parsing stays compact and rejects or streams before dense allocation. | parent-triage | pending | pending | Add range-aware validation and a memory-bounded input path. |
| SEL-005 | High | process | Extract batches open one PDF, tab, and dialog for every 10,000 pages. | `full-audit.md:50`. | Run extraction over a selection spanning multiple 10,000-page batches and assert bounded session count, cancellation, and cleanup. | parent-triage | pending | pending | Define one user-operation lifecycle with bounded windows and deterministic cleanup. |
| SEL-006 | High | product | Large rotate and delete jobs are not atomic, create one undo item per batch, and are retained behind a 20-entry history limit. | `full-audit.md:51`. | Force failure after an intermediate batch; assert no partial document mutation and one undo item restores the entire user operation. | parent-triage | pending | pending | Add transaction or recovery semantics and a history item that represents the full operation. |
| SEL-007 | High | product | Crop and remove-crop give only the first 1,024-page batch a revision token, so a later batch can fail after the first mutation commits. | `full-audit.md:52` cites `usePageOperations.ts:296-353` and document mutation guards. | Fail the second crop batch after the first commits; assert rollback or one final committed revision, never a partial success. | parent-triage | pending | pending | Carry revision and recovery semantics across every batch and report one operation result. |
| CAP-002 | High | product | Page-operation IPC contracts reject explicit arrays or ranges over 100,000 for delete, extract, reorder, move, rotate, crop, remove-crop, and insert-file, while most structural paths have no continuation. | `cap-audit.md:43-60` cites `pageOpsPlatformFeature.ts:39-167`, main bindings, and whole-array callers. | Decode 100,001 valid entries for delete and extract, then run a large rotate and assert bounded multiple native calls with preserved metadata and revision. | parent-triage | pending | pending | Separate selection size from native batch size and define exact continuation for every structural operation. |

## Export, print, browser fallback, and selected-page limits

| ID | Severity | Class | Finding | Evidence | Required red regression test or probe | Owner/status | Fix SHA | Gates | Remaining acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EXP-001 | High | product | Image and TIFF DPI planning parses only the last 262,144 bytes of `pdfinfo` output, so an early huge page can be missed and receive unsafe DPI. | `full-audit.md:56` cites `export.ts:515-590`, `runNativeCommand.ts:50,302-314`, and `appendTextChunkWithByteCap.ts:18-27`; a 6,000-page probe chose 300 DPI instead of safe 58 DPI. | Put a huge-dimension page first in a 6,000-page fixture and assert DPI planning sees it and chooses the safe bound. | parent-triage | pending | pending | Parse complete bounded metadata or use a page-window query with an explicit completeness guarantee. |
| EXP-002 | High | product | Multipage TIFF export retains every rendered page, combines them quadratically, and has no cancellation during descriptor planning. | `full-audit.md:57` cites `export.ts:1082-1195` and the combiner around `export.ts:215-247`. | Run a large multipage TIFF export, cancel during descriptor planning and combination, and assert bounded memory, prompt stop, and no partial success. | parent-triage | pending | pending | Stream page windows through a bounded combiner with cancellation at planning and render boundaries. |
| EXP-003 | High | product | Image export returns an unbounded array of output paths through IPC. | `full-audit.md:58`. | Export enough pages to exceed the intended output-path budget; assert a streamed or bounded result protocol rather than one unbounded IPC array. | parent-triage | pending | pending | Define output enumeration, backpressure, and cancellation for large exports. |
| EXP-004 | High | product | DjVu page-size and preview caches are dense and unbounded; selected export repeatedly scans windows, and a byte-small file over 10,000 pages can enter the browser whole-read cap. | `full-audit.md:59`. | Use a byte-small 10,001-page DjVu, run preview and selected export, and assert sparse/windowed memory and no browser whole-read fallback. | parent-triage | pending | pending | Bound caches and scan work by page windows and preserve native routing for large page counts. |
| EXP-005 | Medium | product | Path-backed print exposes facing-page and orientation settings that the implementation cannot honor. | `full-audit.md:60`. | Request each exposed facing and orientation mode on a path-backed document; assert the output honors it or the control is unavailable. | parent-triage | pending | pending | Align print controls with implemented behavior and verify the output semantics. |
| EXP-006 | High | product | A small-byte PDF with a huge page count can enter an eager pdf-lib print path and allocate dense page arrays. | `full-audit.md:61`. | Create a small-byte, high-page-count PDF and run print under a dense-allocation budget; assert the path stays windowed. | parent-triage | pending | pending | Route by page count as well as byte size and prove bounded print planning. |
| EXP-007 | High | product | Browser PDF open has a practical 16 MiB ceiling because it performs a whole read and enforces a store cap despite a range validator. | `full-audit.md:62` cites `createBrowserDocumentsFileCapability.ts:510-513` and `browserDocumentRecordStore.ts:243-248`. | Open a browser PDF just over 16 MiB with range reads available; assert it opens through ranges or returns an explicit capacity error without a whole read. | parent-triage | pending | pending | Use the range validator and retain browser compatibility limits as explicit, tested policies. |
| EXP-008 | High | product | WASM combine bypasses the shared output-size cap. | `full-audit.md:63`. | Combine inputs until the shared output cap is crossed; assert the same cap and typed refusal apply to the WASM route. | parent-triage | pending | pending | Apply one output-size policy to native, WASM, and browser combine paths. |
| EXP-009 | Medium | product | Native DjVu, shape, and desktop operations can silently fall into browser implementations when the bridge is missing. | `full-audit.md:64`. | Remove the bridge and invoke each operation; assert explicit capability routing or refusal, never silent browser substitution. | parent-triage | pending | pending | Make capability selection observable and keep operation semantics consistent across platforms. |
| CAP-003 | High | product | Explicit image-export and DjVu selections over 100,000 pages are rejected, while the workspace can turn a large partial selection into the empty all-pages sentinel. | `cap-audit.md:84-94` cites the image and DjVu contracts, `useWorkspaceExport.ts:480-495`, and the native DjVu windowed path. | Submit a partial selection over 100,000 pages to image export, DjVu export, and print; assert exact selection via ranges or an explicit refusal, never all pages. | parent-triage | pending | pending | Separate exact selection transport from the empty all-pages sentinel and retain bounded native iteration. |

## Search and OCR

| ID | Severity | Class | Finding | Evidence | Required red regression test or probe | Owner/status | Fix SHA | Gates | Remaining acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SRCH-001 | High | product | Native search accepts `PARTIAL` and `TRUNCATED` sidecars as fresh, while agent page search truncates at 30,000 characters without a completeness signal. | `full-audit.md:68` cites `nativeSearch.ts:220-447` and the agent search path. | Feed partial and truncated sidecars plus a long page to native and agent search; assert stale data is rejected and truncation is explicit. | parent-triage | pending | pending | Require complete sidecar status or expose a typed incomplete result to every consumer. |
| SRCH-002 | High | product | Search normalization can allocate near a gigabyte for one accepted 32 MiB page because streaming limits do not apply to normalized output. | `full-audit.md:69`. | Search a 32 MiB page with normalization expansion under an allocation budget; assert bounded output or typed refusal before excessive allocation. | parent-triage | pending | pending | Apply budgets to normalized text, not only input and transport buffers. |
| SRCH-003 | High | product | Browser search lacks query-cost validation, its page-text cache ignores the advertised byte budget, and a persisted unsafe page count can drive an enormous loop. | `full-audit.md:70`. | Persist an unsafe page count and issue a high-cost query; assert validation, bounded cache growth, and bounded iteration. | parent-triage | pending | pending | Validate query cost and persisted counts before worker or page-loop allocation. |
| SRCH-004 | High | product | OCR availability treats corrupt artifacts as available, and v3 migration can publish malformed artifacts. | `full-audit.md:71`. | Corrupt an OCR artifact and run availability and migration checks; assert corruption is unavailable and malformed output is never published. | parent-triage | pending | pending | Validate artifact structure before availability and before publishing migrated data. |
| SRCH-005 | High | product | OCR text windows can return a stale revision because snapshot and 64-page budgets are checked after materialization. | `full-audit.md:72`. | Change the source during OCR window materialization; assert stale revision is rejected before returning text and budgets are enforced before allocation. | parent-triage | pending | pending | Bind reads to one revision and enforce page and snapshot limits before materialization. |
| SRCH-006 | High | product | OCR cancellation is ignored in several paths, including DOCX generation, and the degraded raster guard runs after expensive rendering. | `full-audit.md:73`. | Cancel OCR and DOCX generation before and during raster work; assert no later render or output commit occurs and guard runs before allocation. | parent-triage | pending | pending | Propagate cancellation through all OCR consumers and check raster budgets before rendering. |
| SRCH-007 | Medium | product | OCR page-identity sidecars accept trailing garbage. | `full-audit.md:74`. | Append bytes after a valid page-identity sidecar and assert strict parsing rejects the artifact. | parent-triage | pending | pending | Enforce complete input consumption and a typed corruption result. |

## Scan cleanup and rendering

| ID | Severity | Class | Finding | Evidence | Required red regression test or probe | Owner/status | Fix SHA | Gates | Remaining acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SCAN-001 | High | product | Auto cleanup above 1,024 pages disables compact-source preservation and its budget. | `full-audit.md:78`. | Run auto cleanup on a document just below and above 1,024 pages; assert compact-source preservation and budget behavior remain explicit and bounded. | parent-triage | pending | pending | Preserve compact source data or fail with a documented capacity result above the threshold. |
| SCAN-002 | High | product | Sparse lossless selection races a shared mutable page-size cursor. | `full-audit.md:79`. | Run concurrent sparse lossless selections with different page-size windows; assert each result uses its own immutable cursor and dimensions. | parent-triage | pending | pending | Remove shared mutable cursor state and prove concurrent selection isolation. |
| SCAN-003 | High | product | More than 20,000 pages evicts ink-placement anchors and falls back to top-center placement. | `full-audit.md:80`. | Place ink on pages beyond 20,000, save, reopen, and assert coordinates remain anchored to the intended page region. | parent-triage | pending | pending | Keep placement identity and coordinates bounded without silently changing placement. |
| SCAN-004 | Medium | process | The xlarge representation report can be empty and point to deleted scratch JSONL. | `full-audit.md:81`. | Delete or truncate scratch JSONL during representation reporting; assert the report fails closed with a retained diagnostic, not an empty success. | parent-triage | pending | pending | Make report artifact ownership and retention explicit through success and failure. |
| SCAN-005 | High | product | Renderer metadata remains dense through 20,000 pages, and the source-DPI Promise cache is unbounded. | `full-audit.md:82`. | Open a 20,000-page document and inspect metadata and source-DPI cache growth under a memory budget; assert bounded or sparse structures. | parent-triage | pending | pending | Bound metadata and cache lifetime by windows, revisions, or explicit capacity policy. |
| SCAN-006 | High | product | Scan-cleanup IPC coerces unsafe numbers and preserves rotation as a string. | `full-audit.md:83`. | Send unsafe numeric coordinates and string rotation through IPC; assert strict rejection or typed normalized values. | parent-triage | pending | pending | Validate finite ranges and canonical numeric rotation at the IPC boundary. |
| SCAN-007 | Medium | process | A stale transient background page has no guaranteed cleanup, and annotation-layer abort controllers survive teardown. | `full-audit.md:84`. | Create and tear down transient pages during active annotation work; assert page disposal and abort-controller cancellation before the session settles. | parent-triage | pending | pending | Add teardown ownership and prove no stale page or controller survives close and restart. |
| SCAN-008 | High | product | The thumbnail spacer can exceed Chromium's scroll extent at about 138,000 pages. | `full-audit.md:85`. | Open a document near 138,000 pages, scroll to the end, and assert usable geometry without overflow or unreachable pages. | parent-triage | pending | pending | Use segmented or virtualized geometry that stays within browser scroll limits. |
| SCAN-009 | High | product | Outlines truncate silently above 10,000 entries. | `full-audit.md:86`. | Import or create more than 10,000 outline entries, save, reopen, and assert all entries remain or an explicit limit refusal appears. | parent-triage | pending | pending | Preserve or explicitly bound outline count without silent loss. |

## Security, native boundaries, and resource ownership

| ID | Severity | Class | Finding | Evidence | Required red regression test or probe | Owner/status | Fix SHA | Gates | Remaining acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-001 | High | product | App-temp read authorization checks only that a path is under the shared temp root, allowing another renderer to read, stat, range-read, or probe a learned path. | `full-audit.md:90` cites `documentFilePathResolution.ts:114-129,258-260,607-625` and `pathValidator.ts:293-295`. | Give renderer B renderer A's temp path and attempt each read, stat, range, and probe operation; assert authorization fails. | parent-triage | pending | pending | Bind temp paths to owner, lease, and identity rather than root containment alone. |
| SEC-002 | Medium | product | Raw-path aliases such as `/var` and `/private/var` can defeat working-copy cancellation and range-cache identity while cleanup runs. | `full-audit.md:91`. | Start an operation through one alias and cancel or clean through the other; assert one canonical identity controls both. | parent-triage | pending | pending | Canonicalize and compare path identity before cache, cancellation, and cleanup decisions. |
| SEC-003 | High | product | `ensureWorkingCopyDirectory` can materialize a lazy working copy and advance its revision while the background materializer does the same work. | `full-audit.md:92`. | Race explicit directory ensure against background materialization; assert one copy, one revision transition, and no duplicate publication. | parent-triage | pending | pending | Serialize materialization and directory ensure under one registration fence. |
| SEC-004 | High | product | Finite JavaScript `f64` values can overflow Rust `f32` fields to infinity or NaN and produce invalid PDF coordinates. | `full-audit.md:95`. | Send finite values near and beyond `f32` range through the mutation contract; assert typed rejection or finite clamping before native code. | parent-triage | pending | pending | Validate representability at the IPC boundary and reject non-finite native values. |
| SEC-005 | High | product | Bookmark validation recurses into nested children before enforcing depth, so a deeply nested request can overflow the stack. | `full-audit.md:96`. | Submit a nesting depth beyond 64 with enough nodes to stress recursion; assert bounded rejection without stack overflow. | parent-triage | pending | pending | Check depth iteratively or before recursion and preserve a typed depth error. |
| SEC-006 | High | product | Annotation and page-size sidecars have no aggregate cap, and ink annotations allow unbounded inner stroke arrays. | `full-audit.md:97`. | Submit many individually valid sidecars and a large stroke array under an aggregate memory budget; assert bounded refusal or streaming. | parent-triage | pending | pending | Add aggregate and nested collection budgets across sidecar families. |

## Test, CI, and acceptance process

| ID | Severity | Class | Finding | Evidence | Required red regression test or probe | Owner/status | Fix SHA | Gates | Remaining acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TEST-001 | High | test/process | Required PR and push CI never runs the exact 722,176,299-byte or 2,168,527,413-byte fixture; required lanes use sparse synthetic 431-page files. | `full-audit.md:108`; `linux-flow-audit.md:16,74-82`. | Run a normal PR or main-push topology check and assert the required lane admits the exact fixture identities or reports an explicit opt-in boundary. | parent-triage | pending | pending | Add a required exact-fixture lane with controlled staging, timeout, and resource policy. |
| TEST-002 | High | test/process | Native source changes can run Rust work without Electron save coverage, and direct source pushes can match no hosted workflow paths. | `full-audit.md:109`; `linux-flow-audit.md:199-209` confirms classifier and workflow separation. | Change a native save dependency, run the changed-area classifier, and assert an Electron save path is required before green publication. | parent-triage | pending | pending | Couple native save changes to an Electron save/reopen gate and define no-workflow behavior. |
| TEST-003 | High | test/process | The required large acceptance helper can synthesize annotation state, inject contenteditable values, and call exposed handlers without a real PDF.js annotationStorage mutation. | `full-audit.md:110`; `linux-flow-audit.md:149,161-167`. | Make the acceptance test fail when annotationStorage is not dirty and require visible controls plus real pointer or keyboard input. | parent-triage | pending | pending | Prove live PDF.js storage and fail every programmatic or fallback helper path. |
| TEST-004 | High | test/process | `saveViaWindowHandle()` hides missing or rejected `save-committed` events behind DOM-idle fallback and reopens without committed revision or hash proof. | `full-audit.md:111`; `linux-flow-audit.md:175-179` cites `viewerCore.ts:1335-1381`. | Suppress or reject the event probe while DOM becomes idle; assert the save fails rather than passing on fallback. | parent-triage | pending | pending | Require the exact committed event, target path, revision, and hash before success. |
| TEST-005 | Medium | test/process | Blocking PR smoke skips all pressure large-PDF tests; pressure tests open generated files but do not save annotations. | `full-audit.md:112`. | Inspect blocking project membership and run a pressure save; assert at least one bounded annotation-save case executes in the required lane. | parent-triage | pending | pending | Add a controlled pressure save without making synthetic-only coverage the exact-fixture substitute. |
| TEST-006 | Medium | test/process | Headless launch settings disable focus and permit non-physical input, so required Linux work does not prove keyboard, pointer, compositor, or focus behavior. | `full-audit.md:113`; `linux-flow-audit.md:191-197`. | Run the acceptance flow with OS-level pointer and keyboard input under Xvfb; assert focus and input delivery, not only DOM visibility. | parent-triage | pending | pending | Make the required interaction lane prove physical input or fail closed when focus is unavailable. |
| TEST-007 | High | test/process | Teardown swallows heartbeat, RSS, and session-stop failures; timeout races leave CDP work pending, kill errors ignored, and no final child-liveness assertion runs. | `full-audit.md:114`; `linux-flow-audit.md:181-189`. | Inject each teardown failure and a timed-out CDP task; assert the test fails, cancels work, and proves no child remains. | parent-triage | pending | pending | Aggregate teardown errors, cancel underlying work, and assert final process-tree liveness. |
| TEST-008 | Medium | test/process | Rendered-page assertions check only CSS class, canvas dimensions, and minimal viewport intersection, so blank or stale canvases can pass. | `full-audit.md:115`. | Present a blank or stale canvas with matching dimensions and assert the rendered-page probe fails. | parent-triage | pending | pending | Verify current page identity and sampled rendered pixels or an equivalent semantic render result. |
| TEST-009 | Medium | test/process | Unit save tests mock native commands, staged artifacts, working-copy store, atomic replace, and file copy; no tiny-PDF integration test exercises the native binary, qpdf, and `copyFileAtomic`. | `full-audit.md:116`. | Run a tiny real PDF through the native binary, qpdf, and `copyFileAtomic`, including failure and reopen paths. | parent-triage | pending | pending | Add a real integration gate while retaining focused unit tests for boundary cases. |
| TEST-010 | High | test/process | Quarantine uses `--passWithNoTests`, `continue-on-error`, and environment-gated skips, allowing green results with zero cases or known failures. | `full-audit.md:117`. | Run quarantine with zero discovered tests and a known failing case; assert the job fails closed. | parent-triage | pending | pending | Remove zero-execution and known-failure green paths or require explicit, checked ownership. |
| TEST-011 | High | test/process | The xlarge renderer IPC probe is optional, and semantic assertions load the whole file while checking only limited object fields, missing page identity, appearance blankness, marker rectangle, Popup parent, and visible result. | `full-audit.md:118`; `linux-flow-audit.md:169-173`. | Disable the optional probe and corrupt each omitted field; assert the acceptance test fails with independent structural and visible checks. | parent-triage | pending | pending | Require bounded IPC evidence and complete page, appearance, parent, marker, and visible-result assertions. |
| TEST-012 | High | test/process | The annotation-save SLO is 8 seconds while exact-fixture evidence records 30 to 47 seconds; other helpers allow 360-second work without cancellation. | `full-audit.md:119`. | Run the exact fixture with the stated SLO and cancellation deadline; assert timeout cancels all work and reports the actual phase. | parent-triage | pending | pending | Set a justified large-file budget and enforce cancellation at every longer helper boundary. |
| TEST-013 | Medium | test/process | The save benchmark leaks process environment into another test, `vi.clearAllMocks()` leaves implementations installed, and generic console or unhandled errors do not fail the unit suite. | `full-audit.md:120`. | Run the benchmark before and after a test with different environment and mocks, plus injected console and unhandled errors; assert isolation and failure. | parent-triage | pending | pending | Restore process state and mock implementations and make unexpected errors fail the suite. |
| TEST-014 | High | test/process | Xlarge fixture admission checks regular-file status, byte size, staged size, and qpdf page count but no SHA-256 or content identity. | `cap-audit.md:84-101`; `linux-flow-audit.md:23,86-99`; `full-audit.md:127`. | Replace the configured source with a same-size, same-page-count different PDF; assert admission rejects it by hash or immutable content identity. | parent-triage | pending | pending | Require the supplied SHA, byte size, and qpdf page count before staging or running. |
| TEST-015 | High | test/process | No saved-output `qpdf --check` is required by the xlarge flow. | `full-audit.md:127`; `linux-flow-audit.md:169-173,220`. | Corrupt a committed output after save and before reopen; assert the acceptance test runs `qpdf --check` and fails. | parent-triage | pending | pending | Check every committed and reopened output independently of PDF.js. |
| TEST-016 | Medium | test/process | The persistent `startd` path has no shell EXIT cleanup trap, so interruption can leave Xvfb and session children for the stale-session pruner. | `full-audit.md:114`; `linux-flow-audit.md:195,221`. | Interrupt a `startd` run and assert Xvfb, Electron, and session children are cleaned or retained with an explicit failure. | parent-triage | pending | pending | Install cleanup for daemon startup and prove no unowned child survives interruption. |
| TEST-017 | Medium | test/process | The verified xlarge run exceeded the renderer heartbeat limit, reaching 3,350 ms against a 3,000 ms policy. | `full-audit.md:127`; `linux-flow-audit.md:27,55,132-143,223`; telemetry scalar summary records `maxGapMs: 3350`. | Repeat the exact xlarge run and assert the measured heartbeat, save phase, and policy decision are recorded without hiding the failure. | parent-triage | pending | pending | Decide and document the large-file heartbeat budget, then meet it or change the policy with evidence. |
| TEST-018 | Medium | test/process | Linux xlarge staging with `COPYFILE_FICLONE_FORCE` returned `ENOTSUP`; the run needed a temporary preload that stripped the flag. | `full-audit.md:128`; `linux-flow-audit.md:54,101,122-132`. | Run exact-fixture staging on Linux filesystems with and without clone support; assert a supported clone or tested streaming fallback is selected without source edits. | parent-triage | pending | pending | Make clone-mode selection portable and fail closed on unsupported staging. |
| TEST-019 | High | test/process | The verified 882-page Linux annotation flow left `annotationDirty: true`, returned `saveSucceeded: false`, and omitted the new FreeText, but helper and cleanup failures prevent a clean product diagnosis. | `full-audit.md:126`; `linux-flow-audit.md:115-120,222,227`. | Reproduce with strict visible interaction, live storage proof, committed-event observation, and independent output checks; classify product failure only after harness errors are absent. | parent-triage | pending | pending | Resolve the candidate in a clean exact-fixture run and retain the failing artifact if the product still rejects the save. |
| TEST-020 | Medium | test/process | The native split-pane test hung for more than six minutes after opening a one-page document; no child residue remained after interruption. | `linux-flow-audit.md:52-53,115-120`. | Run the isolated split-pane test with a bounded timeout and process-tree probe; assert it completes or fails with a typed timeout and no residue. | parent-triage | pending | pending | Determine whether the hang is harness or product behavior and keep teardown fail-closed. |
| TEST-021 | High | test/process | The xlarge flow does not require or observe the exact `save-committed` automation event. | `linux-flow-audit.md:20,157-165`; `full-audit.md:127,130`. | Remove the event and let other save barriers complete; assert the acceptance test fails instead of passing. | parent-triage | pending | pending | Wait for the target-path event ID captured before the click and fail on missing, late, or rejected observation. |
| TEST-022 | High | test/process | The xlarge flow uses renderer `page.reload()` after save rather than a hard Electron process restart. | `linux-flow-audit.md:21,159-165`; `full-audit.md:127,130`. | Stop Session B after save, start a fresh Session C, reopen the committed path, and assert annotations and revision survive process death. | parent-triage | pending | pending | Use the real hard-restart fixture mechanism after persistence, not renderer reload. |
| TEST-023 | High | test/process | The xlarge flow performs one save only and has no second save after reopen. | `linux-flow-audit.md:22,165`; `full-audit.md:127,130`. | After hard restart and reopen, make a second visible annotation edit, save, stop, reopen again, and assert both commits. | parent-triage | pending | pending | Prove the full save, restart, reopen, second-save, and subsequent-reopen sequence. |
| TEST-024 | Medium | product | Native projection correctness on the exact Zaliznyak file remains unproven. | `linux-flow-audit.md:229-236`, especially line 231; `full-audit.md:127,130`. | Run the exact hash-admitted file through native annotation projection and independent object and visible-result checks. | parent-triage | pending | pending | Record a clean native projection result on the exact fixture, not only injected callbacks. |
| TEST-025 | High | product | Save durability across actual Electron process death and restart remains unproven. | `linux-flow-audit.md:232`; `full-audit.md:130`; xlarge telemetry only records renderer reload at `xlarge-followup-telemetry.json:72-82`. | Save, kill the Electron process, start a fresh process, reopen the committed file, and assert the persisted annotation and revision. | parent-triage | pending | pending | Demonstrate durable bytes and metadata after process death with target hash and qpdf checks. |
| TEST-026 | Medium | process | Absence of leaked PDF.js or native work after forced or timed-out save remains unproven. | `linux-flow-audit.md:236`; `full-audit.md:114,130`. | Force save timeout and process stop, then inspect child processes, leases, pending tasks, and artifact handles before declaring completion. | parent-triage | pending | pending | Fail on surviving child, task, lease, or handle and retain teardown diagnostics. |
| TEST-027 | High | test/process | The xlarge flow does not compare a pre-save and post-save structural object table, so its qpdf checks are incomplete. | `linux-flow-audit.md:171-173`; `full-audit.md:127`. | Capture bounded pre-save and post-save object identity and appearance summaries, then assert only intended objects changed. | parent-triage | pending | pending | Add independent structural comparison alongside `qpdf --check` and semantic reopen checks. |

## Large-document resource hotspots

| ID | Severity | Class | Finding | Evidence | Required red regression test or probe | Owner/status | Fix SHA | Gates | Remaining acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HOT-001 | Medium | product | Native PDF preview has a windowed override but can fall back to `Array.from({length: pageCount})`, creating a page-count-proportional compatibility array. | `cap-audit.md:98-103` cites `nativePdfPreview.ts:160-189`. | Force the compatibility fallback on a high-page-count PDF and assert memory stays within the declared budget or the operation refuses explicitly. | parent-triage | pending | pending | Replace or bound the fallback array, or document and gate its page-count ceiling. |
| HOT-002 | Medium | product | Browser all-pages image export creates a dense page target list, and browser DjVu TIFF retains decoded pages in an array despite a 64 MiB decoded-image budget. | `cap-audit.md:104` cites `createBrowserImageExportCapability.ts:469-476,564-597`. | Run all-pages browser image and DjVu export on a high-page-count input; assert target and decoded-page memory remain bounded. | parent-triage | pending | pending | Stream page targets and decoded images or refuse before dense allocation. |
| HOT-003 | Medium | product | `streamingImagePdfWriter` builds a `/Kids` array for every output page, with no continuation inside the catalog object. | `cap-audit.md:105` cites `streamingImagePdfWriter.ts:285-295`. | Export a high-page-count image PDF under an allocation budget and assert catalog construction remains bounded or fails explicitly. | parent-triage | pending | pending | Use a bounded catalog strategy compatible with the PDF format or set an explicit limit. |
| HOT-004 | Medium | product | Page layout builds dense width, height, and row-index arrays, though callers select sparse metrics above 100,000 pages. | `cap-audit.md:106` cites `buildPageLayoutMetrics.ts:421-433,605`. | Force the compatibility path near its threshold and the sparse path above it; assert no unexpected dense allocation crosses the budget. | parent-triage | pending | pending | Keep the sparse boundary tested and make dense compatibility limits explicit. |

## Large-save regression acceptance checklist

This checklist matches the next acceptance lane required by the exhaustive
report at `full-audit.md:130`.

- [ ] Fail closed unless the fixture SHA, byte size, and qpdf page count match.
- [ ] Use visible controls and real pointer and keyboard input.
- [ ] Prove live PDF.js storage.
- [ ] Wait for the exact `save-committed` path and revision.
- [ ] Verify the target hash and qpdf structure.
- [ ] Hard-restart Electron.
- [ ] Reopen the committed file.
- [ ] Save a second time.
- [ ] Fail if any helper fallback, missing probe, teardown error, or surviving child occurs.

The Linux report's lower-cost red-test order is retained as implementation
guidance: a committed-event blocking smoke, a small-fixture hard restart with
a second save and reopen, a qpdf structural check after each save, and the
opt-in exact-fixture lane with SHA admission and the same hard-restart sequence
(`linux-flow-audit.md:238-247`).

## Boundaries inspected and not counted as defects

The reports also record bounded paths and rejected hypotheses. They are not
ledger items because the reports found no silent truncation or unsafe behavior
in those paths at the audited baseline.

| Boundary | Audit conclusion | Evidence |
| --- | --- | --- |
| Native eager PDF and qpdf structure | Eager and retained-structure caps are safety limits; path-backed PDFs use qpdf above the eager threshold without a whole-document source allocation. | `cap-audit.md:169-182`; `native-crosscut-audit.md:128-134` |
| Native offsets and staged output | Checked `u64` offsets, xref streams, staged output, and mutation receipt checks passed their reported tests. The separate JavaScript publication race remains `SAV-008`. | `native-crosscut-audit.md:120-145`; `cap-audit.md:192-203` |
| Lazy materialization | Chunked copy, abort checks, source and target hashes, and the registration fence form a continuation path. The missing renderer teardown hook remains `SAV-015`. | `native-crosscut-audit.md:146-149` |
| OCR, search, scan cleanup, DjVu, image, and TIFF continuation paths | The native and sidecar paths have bounded windows, shards, batches, or explicit format limits. Their separate defects are listed above where the reports found them. | `native-crosscut-audit.md:150-163` |
| Browser platform routing | Electron routing requires the bridge, desktop runtime, or explicit Electron route; an Electron-shaped user agent alone does not select missing IPC. | `native-crosscut-audit.md:164-167` |
| Page identity, metrics, and compatibility labels | Sparse identity and metrics paths are bounded; the label compatibility null-to-empty rewrite is the separate `PDF-002` defect. | `cap-audit.md:100-106` |

## Audit gate record

- Cap audit native tests passed 16/16; page-ops tests passed 169/169, error
  classification 4/4, and multi-GiB tests 4/6. The two 10 GB tests failed with
  `ENOSPC`, not a corruption result (`cap-audit.md:184-203`).
- The cap audit's JavaScript static test could not start because `vitest` was
  absent (`cap-audit.md:205-212`).
- Linux policy tests passed 46 tests after Nuxt preparation, but the exact
  882-page run had two annotation-save failures and a split-pane hang, while
  the xlarge run was red on the heartbeat budget (`linux-flow-audit.md:50-55,
  115-143`).
- The xlarge telemetry scalar evidence records source and staged bytes of
  2,168,527,413, page count 2,646, clone mode `COPYFILE_FICLONE_FORCE`, a
  67,025.1 ms Session B save phase, and the `expected 3350 to be less than
  3000` failure (`xlarge-followup-telemetry.json:2-12,68-82`; `linux-flow-audit.md:132-143`).
- Exact local macOS session
  `e2e-run-mtbvb63n-0e8893-large-pdf-1787856031691` admitted the
  722,178,517-byte, 882-page fixture with SHA-256
  `1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6`.
  Native staging completed, but publication failed because the working-copy
  registry had no original-file expectation. Save timing to that failure was
  1.018 s. This is a red `SAV-001` probe, not acceptance.
- After registering the original-file witness on every normal mapped
  working-copy creation route and rebuilding Electron, exact local session
  `e2e-run-mtbvnvwn-5f834e-large-pdf-1787856624984` admitted the same
  722,178,517-byte fixture and completed two native saves in one process. The
  first save took 1.4008 s and the second 1.0519 s. Focused working-copy and
  original-path tests passed 43/43. This is strong latency and source-fence
  evidence, but it is not final acceptance because the current E2E still uses
  an automation helper, does not hard-restart Electron between saves, and
  inspects the full file with pdf-lib.
- A read-only Fable review ranked an xref-resolution defect in the qpdf
  structural loader as the top hypothesis. The new focused
  `qpdf_structural_loader_resolves_repeated_native_mutations` regression passed
  on a sparse 513 MiB PDF, falsifying that isolated theory. A staged-publication
  barrier then proved the staged artifact, original, and working copy were
  byte-identical and exposed the actual acceptance-driver defect: focus repair
  moved the textarea selection to the end after the driver tried to select all.
- The corrected strict macOS session
  `e2e-run-mtc4slgp-fe40cf-large-pdf-1787871961357` used only visible controls,
  pointer input, and keyboard input for annotation edits. It asserted live
  annotation storage and dirty state, observed each exact committed event,
  validated bounded annotation objects and `qpdf --check`, killed and restarted
  Electron twice, verified clean hydration and both commits, ran the runtime IPC
  probe, and left no tested child process alive. The test passed in 134.240 s,
  with 169.41 s total runner time.
- These audit results are evidence for triage and red tests. They are not
  implementation gates, fix SHAs, or closure of any row in this dirty checkout.
