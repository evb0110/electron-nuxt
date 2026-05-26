# PDF Viewer Public API Inventory

`PdfViewer.vue` remains the compatibility shell. Its parent-facing contract is the
existing `IPdfViewerExpose` interface exported from
`app/modules/workspace-shell/public.ts`.

## Props

The component currently accepts document source props, viewer state props, search
props, annotation tool/settings props, and workspace metadata props through
`IPdfViewerProps` in
`app/modules/pdf-viewer-runtime/contracts/pdfViewerComponent.types.ts`.

Defaults and normalization live in
`app/modules/pdf-viewer-runtime/contracts/usePdfViewerPropModel.ts`.

## Emits

The component emit surface is captured by `TPdfViewerEmit` in
`app/modules/pdf-viewer-runtime/contracts/pdfViewerComponent.types.ts`.
Internal code should route emissions through
`createPdfViewerEventAdapter` as ownership moves out of the component.

## Exposed Methods

`PdfViewer.vue` exposes an `IPdfViewerExpose` object. The exposed methods cover:

- viewer container, page navigation, scroll snapshots, page metrics, and load settle waits
- region capture and crop selection
- save, print rendering, and managed shape save preparation
- annotation creation, editing, focus, delete, undo, redo, history, subtype, and color commands
- shape load/update/delete/selection commands
- image placement commands
- render invalidation and search-result scrolling

The Stage 1 adapter intentionally does not change this surface.
