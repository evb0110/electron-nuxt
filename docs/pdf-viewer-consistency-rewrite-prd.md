# PDF Viewer Consistency Rewrite PRD

## Status

Draft

## Summary

The PDF viewer has grown through many staged changes and now concentrates too many responsibilities in `PdfViewer.vue` and a few large composables. This PRD defines a single mainline rewrite that makes the viewer internals more consistent while preserving the existing external component API, user workflows, annotation behavior, and save semantics.

The rewrite should be implemented in one coordinated pass on `main`. Internal stages are still useful for sequencing and verification, but the deliverable is one complete replacement of the inconsistent internals rather than a chain of review-sized migration pull requests.

## Problem

`PdfViewer.vue` currently acts as a compatibility wrapper, runtime coordinator, annotation controller, comment reconciliation layer, render lifecycle manager, interaction router, and public imperative API. Related behavior is spread across `app/components/pdf`, `app/composables/pdf`, and `app/modules/pdf-viewer-runtime` with mixed ownership.

Current pain points:

- Large files hide ownership boundaries and make regressions difficult to localize.
- Viewer state is split across many composables with delegate-heavy coupling.
- The runtime core accepts many callbacks instead of owning a cohesive model.
- Annotation comments, PDF.js editors, app-managed shapes, marker movement, and reload grace behavior are interleaved in the component.
- DOM class contracts are load-bearing and must be preserved deliberately.
- Feature additions tend to extend `PdfViewer.vue` because there is no obvious target module.
- The current structure makes it hard to reason about load, reload, zoom, render, and annotation ordering.

## Goals

- Keep the existing `PdfViewer.vue` public props, emits, and exposed methods stable throughout the rewrite.
- Reduce `PdfViewer.vue` to a thin shell that wires template components to a viewer controller.
- Introduce a cohesive PDF viewer runtime model for document, pages, viewport, layout, scale, rendering, and navigation.
- Move annotation comment reconciliation out of `PdfViewer.vue` into a dedicated model with explicit inputs and outputs.
- Split large render and interaction composables into smaller modules with single responsibilities.
- Preserve existing PDF.js DOM layer class names and runtime query contracts.
- Make future features easier to place without adding more top-level component state.
- Maintain or improve current unit and integration test coverage around migrated behavior.

## Non-Goals

- Do not redesign the visible PDF viewer UI.
- Do not change toolbar, sidebar, annotation panel, or note window UX except where required to preserve behavior.
- Do not replace PDF.js.
- Do not rewrite the Electron save, packaging, OCR, or native-tool paths unless a viewer boundary requires a narrow contract adjustment.
- Do not change PDF serialization semantics as part of the structural rewrite.
- Do not remove existing public viewer APIs until all callers are migrated and a separate deprecation plan exists.

## Users

Primary users:

- App users reading, searching, annotating, saving, printing, and manipulating PDF documents.

Internal users:

- Developers adding PDF viewer features.
- Developers debugging rendering, annotation, save, zoom, and scroll regressions.
- Test authors maintaining viewer unit and integration coverage.

## Current System Notes

Key files:

| File | Current role |
|---|---|
| `app/components/pdf/PdfViewer.vue` | Main shell, runtime wiring, annotation comment model, interaction handlers, exposed imperative API |
| `app/modules/pdf-viewer-runtime/usePdfViewerCore.ts` | Partial runtime coordinator with many injected delegates |
| `app/composables/pdf/usePdfPageRenderer.ts` | Page render pipeline and layer rendering orchestration |
| `app/composables/pdf/usePdfSinglePageScroll.ts` | Single-page scroll and navigation behavior |
| `app/composables/pdf/annotations/useAnnotationOrchestrator.ts` | Annotation feature orchestration |
| `docs/css-load-bearing-classes.md` | DOM class contracts that must survive the rewrite |
| `docs/freetext-note-persistence.md` | Save and note persistence constraints that must not regress |

Important existing constraints:

- PDF.js layer classes such as `page_container`, `textLayer`, `annotationLayer`, `annotationEditorLayer`, and app kebab-case equivalents are runtime contracts.
- FreeText note persistence depends on specific serialization behavior and should not be casually changed.
- Viewer behavior must remain stable across active and inactive tabs.
- Large PDF navigation, page buffering, skeleton display, zoom rerendering, and reload transitions are sensitive to timing.
- Annotation comment sync must preserve transient edits and marker moves across reloads.

## Proposed Architecture

### 1. Compatibility Shell

`PdfViewer.vue` remains the external component and should eventually contain:

- Template composition.
- Prop normalization.
- Event emit adapter.
- Calls to one runtime factory.
- `defineExpose` adapter that delegates to runtime services.
- Minimal local UI-only refs.

It should not own cross-cutting runtime state, annotation reconciliation, render queue behavior, or reload policy.

### 2. Viewer Runtime

Introduce a cohesive runtime module, tentatively:

```text
app/modules/pdf-viewer-runtime/
  usePdfViewerRuntime.ts
  pdfViewerRuntime.types.ts
  document/
  viewport/
  layout/
  rendering/
  navigation/
  lifecycle/
```

The runtime owns:

- Source loading and unload cleanup.
- PDF document proxy and page count.
- Page metrics and placeholder geometry.
- Current page and visible range.
- View mode, continuous scroll, spread handling.
- Effective scale and fit-width behavior.
- Zoom interaction sessions and rerender scheduling.
- Render lifecycle, page invalidation, render cancellation, and stall recovery.
- Loading, initial visual readiness, and reload transition state.

The runtime exposes a small controller:

```ts
interface IPdfViewerRuntime {
    state: IPdfViewerRuntimeState;
    viewport: IPdfViewportController;
    rendering: IPdfRenderingController;
    navigation: IPdfNavigationController;
    lifecycle: IPdfLifecycleController;
    expose: IPdfViewerPublicRuntimeApi;
    cleanup(): void;
}
```

### 3. Annotation Feature

Move annotation behavior into a feature module that depends on the runtime instead of the component:

```text
app/modules/pdf-annotations/
  usePdfAnnotationFeature.ts
  usePdfAnnotationCommentModel.ts
  usePdfAnnotationMarkerModel.ts
  usePdfAnnotationHistoryBridge.ts
  pdfAnnotationFeature.types.ts
```

The annotation feature owns:

- PDF.js editor bridge.
- App annotation history bridge.
- Comment cache and comment snapshots.
- Transient note handling.
- Reload grace merging.
- Marker movement and pending marker state.
- Link and marker portal view models.
- Context menu payload construction.
- Public annotation commands exposed through `PdfViewer.vue`.

The feature should emit semantic events through an adapter rather than directly depending on component `emit`.

### 4. Interaction Tools

Move optional viewer tools behind explicit feature controllers:

```text
app/modules/pdf-viewer-tools/
  usePdfRegionSnipTool.ts
  usePdfCropTool.ts
  usePdfImagePlacementTool.ts
  usePdfShapeTool.ts
```

Each tool receives the runtime and annotation feature dependencies it needs. Tool state should not be stored directly in `PdfViewer.vue`.

### 5. View Models for Components

Prefer passing stable view models to child components instead of long prop lists. For example:

```ts
interface IPdfViewportViewModel {
    classList: ComputedRef<Record<string, boolean>>;
    style: ComputedRef<Record<string, string>>;
    pages: ComputedRef<number[]>;
    spacers: {
        top: ComputedRef<Record<string, string>>;
        bottom: ComputedRef<Record<string, string>>;
    };
}
```

This keeps component boundaries readable while avoiding large prop/event expansion.

## Functional Requirements

### Document Loading

- Load all existing supported PDF source types.
- Emit loading, document, total page, and initial visual readiness events with current semantics.
- Preserve active and inactive tab behavior.
- Preserve source reload behavior during save.
- Preserve failure cleanup and stale render cancellation.

### Rendering

- Render canvas, text, annotation, and annotation editor layers for visible pages.
- Preserve virtualized continuous mode and single-page mode.
- Preserve page buffering behavior.
- Preserve skeleton timing and geometry.
- Preserve render stall recovery.
- Preserve high-DPI and canvas pixel limit safeguards.
- Preserve search highlight application after renders and rerenders.

### Navigation and Zoom

- Preserve scroll-to-page behavior.
- Preserve current page sync semantics.
- Preserve continuous and non-continuous scrolling.
- Preserve spread layout and standalone spread page behavior.
- Preserve fit-width, custom zoom, wheel zoom, zoom locking, and rerender anchoring.
- Preserve horizontal scroll clamping for spread and fit-width modes.

### Annotations and Comments

- Preserve PDF.js annotation editor behavior.
- Preserve annotation tool auto-reset behavior.
- Preserve text markup, note, FreeText note, popup, marker, and shape annotation flows.
- Preserve annotation comment ordering and sidebar updates.
- Preserve transient note creation and reload grace behavior.
- Preserve marker movement and pending anchor rect behavior.
- Preserve annotation history undo and redo routing.
- Preserve selected text markup color updates.
- Preserve comment focus, update, delete, and snapshot APIs.

### Shapes and Image Placement

- Preserve existing shape drawing, selection, drag, resize, context menu, serialization, and save behavior.
- Preserve managed embedded shape import and save preparation behavior.
- Preserve image placement draft, resize, finalize, cancel, and busy states.

### Region Tools

- Preserve region snip behavior, clipboard behavior, capture flash, and cancel interactions.
- Preserve crop selection behavior and crop dialog integration.

### Save and Print

- Preserve `saveDocument` exposed behavior.
- Preserve committed editor handling before save.
- Preserve managed shape save preparation and failed-save restoration.
- Preserve browser print rendering behavior.
- Do not alter FreeText note persistence semantics except behind existing tested helpers.

## Non-Functional Requirements

- `PdfViewer.vue` should trend toward less than 500 lines after migration.
- No single composable in the new runtime should exceed 700 lines without a written reason.
- New modules should expose typed contracts rather than loosely coupled callback bags.
- Runtime modules should avoid direct component emits; use event adapters.
- Runtime modules should avoid ad hoc DOM querying unless tied to documented PDF.js class contracts.
- New UI-facing text must use i18n keys.
- New styling must use design tokens.
- Existing load-bearing class names must be preserved.
- No production path should rely on `eval` workers or runtime package lookup.

## Mainline Implementation Plan

### Stage 0: Baseline and Safety Map

Deliverables:

- Add or update tests for the current behavior most likely to regress.
- Document current external `PdfViewer.vue` props, emits, and exposed methods.
- Document current child component DOM class contracts referenced by runtime code.
- Identify high-risk behaviors that need golden tests before extraction.

Acceptance criteria:

- A viewer API inventory exists.
- At least the annotation comment model, zoom rerender flow, and source reload flow have identified test coverage.
- No runtime behavior is changed.

### Stage 1: Extract Event and Public API Adapters

Deliverables:

- Create typed event adapter for `PdfViewer.vue` emits.
- Create typed public API adapter for `defineExpose`.
- Move prop normalization into a small helper.

Acceptance criteria:

- `PdfViewer.vue` still exposes the same public methods and emits the same events.
- No behavior change is intended.
- Tests for existing parent callers continue to pass.

### Stage 2: Extract Annotation Comment Model

Deliverables:

- Create `usePdfAnnotationCommentModel`.
- Move comment cache normalization, reload grace merging, transient note identity, local deletion, marker move tracking, and sidebar comment emission into the model.
- Keep `useAnnotationOrchestrator` behavior intact.

Acceptance criteria:

- `PdfViewer.vue` no longer contains annotation comment reconciliation helpers.
- Existing annotation comment tests pass.
- Add focused unit tests for reload merge, marker movement, local deletion, and transient note preservation.

### Stage 3: Consolidate Viewer Runtime State

Deliverables:

- Create `usePdfViewerRuntime`.
- Move document, current page, visible range, load state, initial visual readiness, reload transition, and lifecycle wiring into the runtime.
- Replace the delegate-heavy `usePdfViewerCore` call with a smaller controller contract.

Acceptance criteria:

- `usePdfViewerCore` is either removed or reduced to an internal implementation detail.
- Runtime owns lifecycle ordering.
- `PdfViewer.vue` no longer passes long lists of render, scroll, scale, and cleanup delegates through a single options object.

### Stage 4: Split Rendering Pipeline

Deliverables:

- Split `usePdfPageRenderer` into canvas, text layer, annotation layer, editor layer, render queue, and page cache modules.
- Preserve existing public renderer methods during the transition.

Acceptance criteria:

- Rendering behavior remains equivalent for visible pages, buffered pages, invalidated pages, and forced rerenders.
- Unit tests cover cancellation, stale render prevention, annotation layer rerender, and search highlight timing.

### Stage 5: Move Interaction Tools Behind Controllers

Deliverables:

- Move image placement, region snip, crop selection, and shape tool wiring into feature controllers.
- Replace direct component state with tool view models.

Acceptance criteria:

- `PdfViewer.vue` template wiring is shorter and mostly view-model based.
- Tool behavior is preserved.
- Shape and image placement save paths remain intact.

### Stage 6: Reduce Component and Remove Compatibility Shims

Deliverables:

- Remove obsolete delegates and transitional wrappers before the final result is considered complete.
- Rename modules for final ownership clarity.
- Update documentation and tests to reference final boundaries.

Acceptance criteria:

- `PdfViewer.vue` is a thin shell.
- Runtime and feature modules have explicit contracts.
- No dead transitional code remains in the final mainline result.

## Testing Strategy

Unit tests:

- Annotation comment merge and transient identity.
- Marker movement and pending anchor rect handling.
- Current page sync and visible range updates.
- Zoom rerender queue and anchor restoration.
- Skeleton visibility and delayed skeleton behavior.
- Render cancellation and stale render prevention.
- Page layout and spread row calculations.

Integration tests:

- Load PDF, navigate quickly, and verify current page.
- Switch active and inactive PDF tabs.
- Annotate, save, reload, and verify comments and notes.
- Move note markers, save, reload, and verify marker position.
- Search, navigate matches, zoom, and verify highlights.
- Use single-page and continuous modes.

Manual or Electron verification:

- Perform large-batch visual checks after the internally complete rewrite is assembled, and again after fixes from that verification.
- Verify annotation creation, note editing, marker movement, image placement, crop, snip, save, reload, print, and rapid navigation together.

Quality gates:

- Run `pnpm lint && pnpm typecheck` once the full rewrite is complete.
- For changes touching Electron runtime, native binaries, workers, OCR, or packaging, also follow the cross-arch checks in `AGENTS.md`.

## Mainline Delivery Plan

- Do all implementation work on `main`.
- Do not create or switch branches for this rewrite.
- Treat stages as an internal sequence within one continuous change set.
- Preserve the external `PdfViewer.vue` API throughout the rewrite so parent components keep working while internals move.
- Keep temporary compatibility wrappers only while the one-go rewrite is in progress.
- Remove transitional wrappers before completion.
- Use feature flags only if the one-go rewrite requires a temporary runtime fork to keep the app usable during implementation. Remove any temporary flag before completion unless there is an explicit product reason to keep it.
- Do not consider the rewrite complete until old modules are either removed or intentionally retained with clear ownership.

## Success Metrics

- `PdfViewer.vue` is reduced to a thin shell with stable external API.
- New feature work can be placed in a clear module without editing unrelated runtime code.
- Annotation comment regressions become easier to test and debug.
- Render lifecycle bugs can be localized to rendering modules instead of the main component.
- The number of callbacks passed into the runtime core drops significantly.
- Tests remain focused and readable after migration.

## Risks

| Risk | Mitigation |
|---|---|
| Annotation reload behavior regresses | Extract and test the comment model before changing runtime lifecycle |
| Zoom and scroll anchoring regresses | Keep existing behavior behind tests before replacing delegates |
| PDF.js DOM layer assumptions break | Preserve documented load-bearing classes and add targeted assertions |
| Mainline rewrite becomes too large to reason about | Keep internal stages strict and finish one ownership boundary before moving to the next |
| Save semantics change accidentally | Treat serialization and FreeText note persistence as locked behavior |
| Transitional wrappers linger | Make Stage 6 cleanup a release-blocking deliverable |

## Open Questions

- Should the new runtime live under `app/modules/pdf-viewer-runtime` or should feature modules move under a broader `app/modules/pdf-viewer` namespace?
- Should annotation modules remain under `app/composables/pdf/annotations` during migration, or move to `app/modules/pdf-annotations` once the boundary is clear?
- Which existing parent components rely on `PdfViewer.vue` exposed methods in ways that should become formal contracts?
- Are there user-visible PDF workflows that lack automated coverage and should be added before Stage 2?

## Initial Mainline Work Order

Start with Stage 0 and Stage 1, then continue immediately through the remaining stages without creating separate delivery branches.

Recommended first implementation slice:

- Add the typed emit adapter.
- Add the public API inventory.
- Extract prop normalization.
- Add tests or snapshots for the `PdfViewer.vue` public API shape where practical.

Recommended second implementation slice:

- Extract `usePdfAnnotationCommentModel`.
- Add focused tests for reload merge, local deletion, marker movement, and transient note preservation.

These slices are sequencing tools only. They should land as part of the same mainline rewrite effort.
