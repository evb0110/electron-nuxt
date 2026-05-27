# PDF Viewer Full Rewrite
You are working in <repo-root>.

Goal
Rewrite the PDF viewer architecture end to end on the main branch in one coordinated implementation pass. The result should be a cohesive, maintainable PDF viewer feature with explicit ownership for runtime, rendering, annotations, tools, public API, DOM contracts, and browser-verified behavior. Keep the existing user-visible PDF viewer behavior and public component contract compatible while replacing the current transitional architecture.

Work on main
- Confirm the current branch is main before editing. If it is not main, stop and report the branch name instead of switching branches.
- Do not create branches.
- Do not open a PR.
- Do not split the rewrite into staged delivery branches or partial PR-sized changes.
- Keep going through research, implementation, tests, browser verification, and final cleanup.

Read first
- AGENTS.md
- CLAUDE.md
- docs/pdf-viewer-consistency-rewrite-prd.md
- docs/pdf-viewer-rewrite/public-api-inventory.md
- docs/pdf-viewer-rewrite/runtime-safety-map.md
- docs/css-load-bearing-classes.md
- docs/freetext-note-persistence.md
- docs/pdf-viewer-next-architecture-prompt.md

Research and decision authority
- Use the repository as the primary source of truth.
- Do additional local research with rg, architecture scripts, tests, git history, package sources, and existing docs before moving files.
- Use external research only when it materially improves decisions about PDF.js, Vue/Nuxt, browser automation, or dependency APIs. Prefer official documentation and installed package sources over blogs.
- Make architecture decisions autonomously when trade-offs are implementation-level and reversible.
- Stop only if requirements are contradictory, the current branch is not main, or a decision would be destructive outside the PDF viewer rewrite.

Hard constraints
- Preserve existing PdfViewer props, emits, template-facing behavior, and IPdfViewerExpose compatibility.
- Do not redesign visible UI.
- Do not change PDF serialization semantics or FreeText note persistence behavior.
- Do not use electron-puppeteer unless the user explicitly requests it.
- Do not loosen architecture checks to make violations disappear.
- Do not revert or clean up unrelated worktree changes.
- Do not run lint, typecheck, validate, or broad tests after every small edit. Run quality gates in batches after the rewrite is assembled.
- Keep load-bearing PDF.js/app DOM classes intact: page_container, page_canvas, textLayer/text-layer, annotationLayer/annotation-layer, annotationEditorLayer/annotation-editor-layer, and documented overlay classes.
- Follow CLAUDE.md conventions for TypeScript, Vue, scoped styles, design tokens, i18n, icon bundling, naming, and task completion checks.

Current architectural problem to solve
The first rewrite made app/components/pdf/PdfViewer.vue thin, but too much responsibility moved into app/modules/pdf-viewer-runtime/usePdfViewerController.ts. The current structure still has delegate-heavy runtime code, compatibility wrappers, inverted rendering ownership, deep cross-module imports, scattered DOM selectors, and contracts inferred from implementation details.

Top-level recommendations
1. Treat this as a feature rewrite, not a mechanical file move.
2. Prefer one cohesive feature namespace:

   app/modules/pdf-viewer/
     public.ts
     component/
     contracts/
     runtime/
     lifecycle/
     viewport/
     navigation/
     rendering/
     annotations/
     tools/
     public-api/
     dom/

3. Keep a separate module only when it is genuinely reusable outside the PDF viewer. If a separate app/modules feature remains, expose public.ts and import it only through that public entrypoint.
4. Replace delegate-heavy orchestration with explicit typed controllers that own lifecycle, rendering, annotations, tools, viewport, and public API responsibilities.
5. Make the root controller a small composition root. It should assemble domain features and expose the exact model PdfViewer.vue needs, not coordinate every detail itself.
6. Make the rendering module the authoritative page renderer. app/composables/pdf/usePdfPageRenderer.ts should not remain the real implementation.
7. Delete pass-through wrappers instead of preserving old names for comfort.
8. Centralize PDF viewer DOM selectors and lookup helpers behind named constants/functions.
9. Replace cross-boundary ReturnType/Parameters contracts with explicit exported interfaces and types.
10. Move tests and docs to the new ownership model instead of keeping compatibility paths alive.

Required implementation work
1. Inventory current ownership.
   - Map imports and consumers for app/modules/pdf-viewer-runtime, app/modules/pdf-annotations, app/modules/pdf-viewer-tools, and viewer-owned app/composables/pdf files.
   - Classify helpers as PDF-viewer-only, PDF service/serialization, or shared with DjVu/generic document viewing.
   - Identify existing tests that assert runtime, rendering, annotation, tool, public API, and DOM behavior.

2. Consolidate module boundaries.
   - Create app/modules/pdf-viewer/public.ts.
   - Move tightly coupled runtime, annotation, rendering, tool, and public API code under app/modules/pdf-viewer.
   - Keep or create separate public entrypoints only for genuinely independent modules.
   - Update production and test imports to final authoritative paths.
   - Do not keep old module paths as permanent compatibility exports.

3. Replace the runtime core.
   - Remove createRequiredDelegate/createRequiredVoidDelegate usage from the PDF viewer path.
   - Delete or fully replace usePdfViewerCore.ts and usePdfViewerCoreController.ts.
   - Runtime lifecycle must explicitly own document load, source reload, activation restore, resize lifecycle, zoom rerender queue, render-stall recovery, current-page sync, undo/redo routing, and source reload preservation.
   - Avoid giant options bags. Prefer typed context objects and domain-specific controller APIs.

4. Reduce usePdfViewerController.
   - Leave a small composition root that wires feature controllers together.
   - Suggested final pieces:
     - usePdfViewerRuntimeContext
     - usePdfViewerRuntime
     - usePdfViewerRenderingFeature
     - usePdfViewerAnnotationFeature
     - usePdfViewerToolFeature
     - usePdfViewerTemplateModel
     - usePdfViewerPublicApi
   - PdfViewer.vue should remain thin and component-shaped.
   - The final root controller should be small enough to audit quickly; target under 250 lines unless there is a clear reason.

5. Own rendering in the feature.
   - Move real page rendering out of app/composables/pdf/usePdfPageRenderer.ts.
   - Keep resilience behavior, cancellation, stale render handling, search highlight timing, annotation layer rendering, editor layer rendering, canvas cleanup, and page cache behavior unchanged.
   - Update tests to import from the new rendering module.
   - Remove temporary compatibility exports before completion.

6. Eliminate pass-through wrappers.
   - Remove app/modules/pdf-viewer-runtime/rendering/usePdfPageRenderingController.ts if it only wraps the renderer.
   - Remove or absorb usePdfImagePlacementTool.ts, usePdfRegionSnipTool.ts, and usePdfCropTool.ts if they only rename existing composables.
   - Keep a wrapper only if it now owns real behavior and has a clear reason to exist.

7. Centralize contracts.
   - Add explicit types for page ranges, viewer runtime state, rendering APIs, annotation APIs, tool APIs, source reload/preservation APIs, DOM lookup results, and public API source objects.
   - Avoid ReturnType<typeof ...> and Parameters<typeof ...> in exported module boundaries.
   - Keep implementation-derived types only for local private helpers.

8. Centralize DOM contracts.
   - Add a PDF viewer DOM helper module under the final feature namespace.
   - Replace scattered string queries for page_container, page_canvas, textLayer/text-layer, annotationLayer/annotation-layer, and annotationEditorLayer/annotation-editor-layer where practical.
   - Keep documented class names unchanged.
   - Update docs/css-load-bearing-classes.md if selector ownership or lookup contracts change.

9. Preserve shared primitives correctly.
   - Do not move DjVu/shared document helpers into a PDF-only module.
   - Pure shared helpers should live in app/utils or a clear shared module with a public entrypoint.
   - PDF services, serialization, save orchestration, and PDF.js service helpers should keep existing ownership unless the boundary is clearly wrong.

10. Update tests and docs.
   - Move or rewrite tests to assert the final authoritative modules.
   - Add focused tests for any logic whose ownership changes and any bug-prone lifecycle/rendering behavior touched by the rewrite.
   - Update docs/pdf-viewer-rewrite/public-api-inventory.md and docs/pdf-viewer-rewrite/runtime-safety-map.md.
   - Add a short architecture note if the final module layout differs from the recommended namespace.

Acceptance criteria
- app/components/pdf/PdfViewer.vue remains a thin shell.
- The PDF viewer has one coherent feature namespace, or every remaining cross-feature split has a public.ts entrypoint and imports honor it.
- No pass-through wrappers remain.
- usePdfViewerCore.ts and usePdfViewerCoreController.ts are removed from the active architecture.
- No createRequiredDelegate/createRequiredVoidDelegate remains in the PDF viewer runtime path.
- usePdfViewerController.ts is no longer the orchestration hotspot.
- app/composables/pdf/usePdfPageRenderer.ts is not the authoritative page renderer.
- Rendering behavior is unchanged for normal PDF load, zoom, page navigation, search highlights, annotation layers, cancellation, stale renders, and recovery.
- Annotation behavior is unchanged for comments, shapes, marker portals, PDF.js annotations, text markup, color commands, popup/note behavior, and FreeText persistence.
- Tool behavior is unchanged for crop, region snip, image placement, pan/text-selection state, and shape interactions.
- Public props, emits, and IPdfViewerExpose behavior are compatible with the previous implementation.
- DOM selector strings for PDF page/layer lookup are centralized.
- Cross-feature imports under app/modules pass the architecture checker without weakening it.
- Tests import from final ownership paths rather than old compatibility paths.
- Documentation reflects final module boundaries and runtime safety ownership.
- No visible UI redesign or localization/design-token regression is introduced.
- Browser verification passes and is documented with screenshots or a concise evidence log.

Verification plan
Do not run these after every small change. Run targeted checks after the architecture move is assembled, then fix failures and rerun the relevant batch.

Targeted test batch:
- pnpm exec vitest run tests/unit/app/modules/pdf-viewer-runtime tests/unit/pdf tests/integration/pdf/usePdfPageRendererResilience.test.ts tests/integration/pdf/usePdfAnnotationLayerRenderer.test.ts tests/integration/pdf/usePdfDocument.test.ts

Adjust the command to the new test paths after moving ownership.

Architecture and baseline gates:
- pnpm run check:architecture
- pnpm lint && pnpm typecheck

Because this is a major rewrite, finish with:
- pnpm validate

If pnpm validate is too slow or fails outside the touched architecture area, report the exact command, failure, and the narrower gates that passed. Do not hide failures.

Browser verification is mandatory
Use browser automation in a large final batch, not after every small edit.

Preferred browser verification path:
1. Start the web app with pnpm run dev:web, or use the existing local dev server if already running.
2. Use the Codex Browser plugin or Playwright/Chrome automation against the local app.
3. Load a real PDF fixture through the app. If no fixture exists, find or create a small local PDF fixture suitable for viewer smoke testing.
4. Capture screenshots or a structured evidence log for the checks below.

Required browser checks:
- The app starts without console errors.
- A PDF opens and renders at least the first page.
- Page navigation updates the visible page and page state.
- Zoom in/out rerenders pages without blank canvases or stale overlays.
- Search highlights render and clear correctly.
- Text selection/pan mode still behaves as expected.
- Existing annotation layer content renders.
- Creating or interacting with supported annotations/tools still works for the flows available in the browser runtime.
- Sidebar/comment or annotation-panel interactions affected by the rewrite still work.
- Source reload or document reopen preserves expected page/zoom/scroll state where the app supports it.
- Inspect DOM for expected load-bearing classes and absence of duplicate/obsolete compatibility wrapper artifacts.
- Inspect browser console logs for new errors or warnings.
- Run at least one desktop viewport and one narrower viewport if layout-affecting files were touched.

Completion report
At the end, report:
- Branch verified
- Major files moved, created, or deleted
- Final module boundaries
- Important architecture decisions and trade-offs
- Public API compatibility status
- Test and gate commands run, with results
- Browser verification steps performed, with evidence
- Any failures, skipped checks, or remaining risks
