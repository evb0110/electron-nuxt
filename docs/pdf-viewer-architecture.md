# PDF Viewer Architecture

This note describes the current PDF viewer module boundaries and the contracts
that are intentionally load-bearing.

## Public Surface

`app/modules/pdf-viewer/components/PdfViewer.vue` is the component shell. It
imports its runtime controller from `app/modules/pdf-viewer/runtime/` and keeps
the parent-facing contract stable through:

- `IPdfViewerProps`
- `TPdfViewerEmit`
- `IPdfViewerExpose`

The exposed API covers viewer navigation and metrics, load-settle waits, region
capture, crop, save and print preparation, annotation commands, shape commands,
image placement, render invalidation, and search-result scrolling.

## Module Ownership

The PDF viewer feature namespace is `app/modules/pdf-viewer/`.

| Path | Ownership |
| --- | --- |
| `public.ts` | Cross-module exports and DOM helper exports |
| `engine/` | Viewer-owned DOM, annotation, serialization, render, and save helpers that used to live in the shared utility layer |
| `runtime/` | Controller composition, load/reload, viewport, navigation, zoom, rendering lifecycle, save/print bridges, and public API assembly |
| `runtime/rendering/` | Authoritative page rendering runtime and renderer controllers |
| `annotations/` | Viewer annotation comment/color feature models |
| `dom/` | Load-bearing selector constants and page lookup helpers |

Shared PDF services, serialization helpers, and generic document/workspace
features stay outside this namespace unless they are truly viewer-owned.
Reusable pure PDF geometry, serialization, conformance, TIFF, and outline logic
belongs in `packages/pdf-core` and should be consumed through the `@pdf-core`
package root. Shared non-PDF viewport helpers belong under
`app/utils/document-viewer`; viewer-specific integration helpers that depend on
Vue state, DOM conventions, PDF.js runtime shape, or serialization policy belong
under `app/modules/pdf-viewer/engine`.

## DOM Contracts

PDF.js and app layer classes are runtime contracts. Keep these classes stable
and use `app/modules/pdf-viewer/dom/pdf-viewer-dom/` for new viewer-owned
lookups:

- `page_container`
- `page_container--rendered`
- `page_canvas`
- `textLayer` and `text-layer`
- `annotationLayer` and `annotation-layer`
- `annotationEditorLayer` and `annotation-editor-layer`
- documented overlay/debug classes in `docs/css-load-bearing-classes.md`

`PdfViewerPage.vue` intentionally emits both PDF.js camelCase layer classes and
app kebab-case classes.

## Current-page resolution per renderer stack

Each renderer stack answers "which page is the user looking at?" with its own
measure. The three answers agree in the middle of a page and can differ by one
at a spread boundary. This is recorded, not unified. Unifying them would change
observable page reporting in all three stacks at once, so it should only happen
if boundary flicker is actually reported (navigation/zoom audit item q).

| Stack | Measure | Tie-break | No candidate |
| --- | --- | --- | --- |
| PDF.js (`getViewportVisibilityFromDom.ts`, consumed by `usePdfScroll.ts` `resolveMostVisiblePage`) | Largest visible **area**: vertical intersection multiplied by horizontal intersection, so a horizontally scrolled-off page loses to a narrower fully visible one | Strict `>`, so the **earlier** page keeps the title | Falls back to the previous page, marked non-authoritative |
| Generic page source (`useDocumentPageSourceRuntime.ts` `syncCurrentPageFromViewport` → `resolveNearestDocumentPageToViewportCenter`) | Page whose **center** is nearest the viewport center, found by binary search; visible area is never measured | Strict `<` on the distance comparison, so the **previous** (lower) page wins an exact tie | Returns null and the current page is left alone |
| Native PDF preview (`NativePdfViewer.vue` `getVisiblePageNumber` → `resolveDocumentContinuousScrollWindow`) | Greatest visible **vertical height** only; horizontal overflow is ignored | Strict `>`, so the **earlier** page keeps the title | Falls back to the currently active page |

Consequences worth knowing before touching any of them:

- A zoomed-in PDF.js page scrolled sideways can hand the current page to a
  neighbour, while the native preview and page-source stacks cannot, because
  neither looks at the horizontal axis.
- Only the page-source stack can report a page that is barely visible: the
  nearest-center rule ignores how much of the page is on screen.
- All three are projections. The workspace navigation fence
  (`createWorkspacePageNavigationFence.ts`) still decides whether an observed
  page is accepted, so a disagreement during programmatic navigation is
  rejected rather than shown. `consumePageUpdate` is that decision: it judges
  the page, commits an accepted one to `currentPage`, releases the target, and
  returns the arming navigation source, all in one call, so no caller can read
  a released fence beside an uncommitted page or credit a superseded page to
  the surface that armed the abandoned target.

## Safety Targets

Keep focused coverage around:

- annotation comment reload merging, local deletion, transient note identity,
  and marker movement
- source reload during save and reload grace windows
- zoom rerender anchoring and effective zoom emissions
- visible range, buffered rendering, and stale render cancellation
- search highlight timing after page renders and rerenders

Do not change FreeText note persistence or PDF serialization behavior casually.
Read `docs/freetext-note-persistence.md` before editing annotation
serialization or note-window code.
