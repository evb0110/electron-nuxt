# PDF Viewer Runtime Safety Map

## Load-Bearing DOM Contracts

Keep the PDF.js and app layer classes documented in
`docs/css-load-bearing-classes.md`, especially:

- `page_container`
- `textLayer` and `text-layer`
- `annotationLayer` and `annotation-layer`
- `annotationEditorLayer` and `annotation-editor-layer`
- app overlay layers for links, comment markers, and shapes

Runtime code may query these classes only as documented PDF.js/app contracts.
Viewer-owned selector constants and lookup helpers live in
`app/modules/pdf-viewer/dom/pdfViewerDom.ts`. New PDF viewer runtime and
rendering code should import those helpers instead of duplicating selector
strings.

## Golden Behavior Targets

Before or during extraction, keep targeted coverage around:

- annotation comment reload merging, local deletion, transient note identity, and marker movement
- source reload during save and reload grace windows
- zoom rerender anchoring and effective zoom emissions
- visible range, buffered rendering, and stale render cancellation
- search highlight timing after page renders and rerenders

## Runtime Ownership

The PDF viewer feature namespace is `app/modules/pdf-viewer/`.

- `public.ts` exports the component-facing contracts and controller.
- `runtime/` owns document load/reload, viewport, rendering lifecycle,
  navigation, zoom, resize, activation restore, public API assembly, save, and
  print bridges.
- `runtime/rendering/usePdfPageRenderer.ts` is the authoritative page renderer.
- `annotations/` owns viewer annotation comment/color feature models.
- `tools/` owns PDF-viewer tool state with real behavior; pass-through wrappers
  around composables are intentionally absent.
- `dom/` owns load-bearing selector constants and page lookup helpers.

The previous `usePdfViewerCore.ts`, `usePdfViewerCoreController.ts`, and
`rendering/usePdfPageRenderingController.ts` compatibility paths are removed
from the active architecture.

## Locked Semantics

Do not change FreeText note persistence or PDF serialization behavior as part of
the structural rewrite. See `docs/freetext-note-persistence.md` before editing
annotation serialization or note persistence paths.
