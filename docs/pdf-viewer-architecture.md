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
| `runtime/` | Controller composition, load/reload, viewport, navigation, zoom, rendering lifecycle, save/print bridges, and public API assembly |
| `runtime/rendering/` | Authoritative page rendering runtime and renderer controllers |
| `annotations/` | Viewer annotation comment/color feature models |
| `dom/` | Load-bearing selector constants and page lookup helpers |

Shared PDF services, serialization helpers, and generic document/workspace
features stay outside this namespace unless they are truly viewer-owned.
Reusable pure PDF geometry, serialization, conformance, TIFF, and outline logic
belongs in `packages/pdf-core` and should be consumed through the `@pdf-core`
package root. `app/utils/pdf-viewer` is for app/viewer integration helpers that
depend on Vue state, DOM conventions, PDF.js runtime shape, or viewer-specific
serialization policy.

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
