Implement the solution end-to-end. Do not switch branches. Leave unrelated worktree changes alone. Do not run quality gates until the implementation is complete.

Goal:
Make color changes for saved/materialized PDF text-markup annotations visible immediately before explicit file save, robustly and without drawing a fragile overlay on top of pdf.js canvas content. This must cover Underline, StrikeOut, Squiggly, and Highlight where applicable. The old color must disappear; the new color must not be painted on top of the old one.

Current bug/context:
A saved/materialized underline changed from red to green renders as green on top of red, slightly shifted. Earlier behavior only updated after file save; that regression may be back. The fragile approach is trying to repaint over pdf.js-rendered content before save. Avoid that.

Research summary to verify/refine:
- The app uses pdfjs-dist around 5.4.x.
- Saved/materialized Underline, StrikeOut, and Squiggly are effectively rendered into the pdf.js page canvas, not exposed as live editable DOM/editor objects in a way that can be cleanly recolored.
- Direct pdf.js annotationStorage/editor mutation may help for some editor-created or highlight cases, but is not a reliable unified path for saved Underline/StrikeOut/Squiggly.
- The likely robust solution is an in-memory PDF rewrite plus viewer reload before disk save: rewrite the annotation color in PDF bytes, reload the viewer from those bytes, preserve UI state, mark dirty, and persist only on explicit Save/Save As.
- Existing serialization/rewrite code to inspect:
    - app/composables/pdf/usePdfSerialization.ts
    - app/composables/pdf/pdfSerializationOperations.ts
    - app/composables/pdf/serialization/pdfSerializationMarkup.ts
    - app/composables/pdf/pdfSerializationWorkerClient.ts
- Existing reload/state code to inspect:
    - app/composables/usePdfFile.ts
    - app/modules/pdf-viewer-runtime/usePdfViewerCore.ts
    - app/composables/pdf/pdfReloadWaiter.ts
    - app/composables/pdf/usePageSaveOrchestration.ts
- Existing color command flow to inspect:
    - PdfAnnotationContextMenu.vue
    - WorkspaceAnnotationOverlays.vue
    - usePageAnnotationActions.ts
    - usePdfViewerPublicApiController.ts
    - usePdfViewerAnnotationRuntime.ts
    - usePdfAnnotationColorCommands.ts

Top-level recommendations:
1. Remove/avoid any DOM/SVG/canvas overlay solution for materialized text-markup color preview.
2. Add a first-class “text markup preview rewrite” flow:
    - update the annotation model/cache immediately,
    - build a targeted markup-only rewrite request for the changed annotation,
    - run the rewrite off-thread if the existing worker path supports it,
    - reload the viewer from patched in-memory bytes without writing to disk,
    - preserve page, scroll, zoom, selected/sidebar comment state, and dirty state.
3. Keep final save behavior aligned with preview behavior. The saved file should either persist the already-patched current bytes or rerun the same serialization logic, not a divergent renderer/code path.
4. Implement latest-wins/debounced behavior for rapid swatch changes so older rewrite/reload completions cannot overwrite newer colors.
5. Be willing to rewrite the local architecture around this if needed, but keep scope focused: no unrelated refactors, no persistent memory overhead, no duplicate renderer before/after save.
6. Be explicit about transient memory overhead. It is acceptable to temporarily hold original and patched bytes during a rewrite, but release stale blobs/arrays and avoid accumulating versions.

Acceptance criteria:
- Changing a saved/materialized Underline color visibly updates before explicit save.
- Changing a saved/materialized StrikeOut color visibly updates before explicit save.
- Changing a saved/materialized Squiggly color visibly updates before explicit save.
- Highlight behavior remains correct; if Highlights use a special path, justify it clearly.
- At high zoom, old color pixels are gone after color change; there is no overpaint, double-line, or shifted line.
- Save, close/reload, and reopen preserve the chosen color.
- Rapid color changes are latest-wins; stale async rewrites/reloads cannot restore an older color.
- Scroll position, zoom, current page, selected annotation/comment sidebar state, and comment cache survive preview reload.
- Dirty/save indicator remains correct. No disk write happens until explicit Save/Save As.
- Existing creation and color changes for newly-created/editor-owned text markup remain working.
- No `.pdf-text-markup-color-override` or similar overlay artifacts remain.
- No material memory leak/blob URL leak across repeated color changes.
- `pnpm lint && pnpm typecheck` pass after implementation.

Browser verification is mandatory:
- Use Chrome automation or Playwright against the local app. Browser-check in large batches, not after every small edit.
- Reproduce the bug first if feasible, or document the current repro state with screenshots.
- Use a real PDF containing saved/materialized red Underline and StrikeOut at minimum; include Squiggly if available or create a fixture if the app supports it.
- At high zoom, change red to green and verify visually and by screenshot/pixel inspection that red is gone rather than covered.
- Verify save/reload consistency.
- Verify rapid swatch changes and confirm the final selected color wins.
- Inspect console logs; no new warnings/errors.
- Inspect DOM for absence of color override overlay classes/artifacts.
- Include final screenshots and a concise verification report.

Deliverable:
Implement the robust solution, run the final quality gates, perform browser verification, and report:
- files changed,
- architecture chosen and why,
- memory/latency tradeoffs,
- browser verification evidence,
- remaining risks if any.