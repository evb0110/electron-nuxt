# PDF Annotation Reverse-Mapping Research

## Snapshot
- Date: March 29, 2026
- Scope: Reopen saved PDF drawing annotations as editable/removable objects again
- Goal: support both EVB-authored drawings and compatible third-party PDF annotations without flattening them into one-way page content

## Problem

Today EVB has two different drawing paths:

1. PDF.js-native annotation editors:
   - `FreeText`
   - `Ink`
   - `Highlight`
   - `Stamp`

2. EVB custom overlay shapes:
   - `rectangle`
   - `circle`
   - `line`
   - `arrow`

Both paths save into the PDF, but only the first path has any upstream support for turning saved annotations back into editable editors.

The second path is effectively write-only:
- internal shapes live only in renderer memory
- save serializes them into standard PDF annotations
- reopen reads them as plain PDF annotations/comments
- nothing loads them back into `useAnnotationShapes`

## Current EVB Architecture

### Save path

- `app/composables/useFileOperations.ts`
  - save calls `saveDocument()` first, then runs serialization over the resulting bytes
- `app/composables/pdf/usePdfSerialization.ts`
  - builds a payload containing `shapes`, comment rewrites, page labels, bookmarks, placed images
- `app/composables/pdf/pdfSerializationOperations.ts`
  - appends EVB shape overlays as standard PDF annotations:
    - `rectangle` -> `/Square`
    - `circle` -> `/Circle`
    - `line` / `arrow` -> `/Line`

### Reopen path

- `app/composables/pdf/usePdfDocument.ts`
  - loads the document with PDF.js
- `app/composables/pdf/usePdfAnnotationLayerRenderer.ts`
  - renders the PDF.js annotation layer using `page.getAnnotations()`
- `app/composables/pdf/annotations/useAnnotationSync.ts`
  - scans `page.getAnnotations()`
  - converts them into `IAnnotationCommentSummary`
  - stores them as `source: 'pdf'`

### Shape state

- `app/composables/pdf/useAnnotationShapes.ts`
  - owns EVB overlay shape state
  - contains `loadShapes(loaded)` but there are no callers in the repo
- `app/components/pdf/PdfViewer.vue`
  - exposes `getAllShapes()` for save
  - custom shapes participate in undo/redo via PDF.js command stack
  - there is no import step from embedded PDF annotations back into `shapeComposable`

## Upstream PDF.js Findings

EVB currently ships `pdfjs-dist` `^5.4.624`.

The bundled PDF.js source already has a split between:

- annotations that are merely rendered in the annotation layer
- annotations that are considered "editable" and can be deserialized into live editors

### Existing annotations that PDF.js can rehydrate into editors

From `node_modules/pdfjs-dist/build/pdf.worker.mjs` and `node_modules/pdfjs-dist/build/pdf.mjs`:

- `FreeText`
  - worker marks it editable
  - editor has `FreeTextEditor.deserialize(...)`
- `Ink`
  - worker marks it editable
  - editor has `InkEditor.deserialize(...)`
- `Highlight`
  - worker marks it editable
  - editor has `HighlightEditor.deserialize(...)`
- `Stamp`
  - worker marks it editable
  - editor has `StampEditor.deserialize(...)`

When `AnnotationEditorLayer.enable()` runs, PDF.js iterates editable annotations from the annotation layer and deserializes them into live editors.

### Existing annotations that PDF.js does not appear to rehydrate

The worker parses and renders these types, but does not mark them editable:

- `Line`
- `Square`
- `Circle`
- `Polyline`
- `Polygon`

That means upstream PDF.js will render them, but it will not create live editors for them on reopen.

## Practical Consequence For EVB

### What we can probably leverage from upstream immediately

- saved `Ink`, `FreeText`, `Highlight`, `Stamp` should be treated as first-class existing annotations, not flattened content
- identity is preserved via `annotationElementId`
- PDF.js already knows how to rewrite those existing annotations in place

### What EVB must build itself

- reverse mapping for geometric drawing annotations saved as:
  - `/Line`
  - `/Square`
  - `/Circle`
  - `/Polyline`
  - `/Polygon`

Those must be imported into EVB's own shape model because upstream PDF.js does not provide existing-annotation editors for them.

## Gaps In The Current Repo

### 1. Shapes are append-only on save

`pdfSerializationOperations.ts` only appends shape annotations. There is no concept of:
- "this shape came from existing annotation X"
- updating annotation X in place
- deleting annotation X when a mapped shape is removed

### 2. Shape model lacks embedded identity

`IShapeAnnotation` currently stores geometry and style only. It has no fields for:
- `annotationId`
- source kind
- original PDF subtype
- popup ref / note ref
- polyline/polygon vertices

### 3. Reopen path only populates comment summaries

`useAnnotationSync.ts` turns embedded annotations into comment summaries, but not editable shape objects.

### 4. Deletion is stronger than editing today

EVB already has a usable embedded-delete fallback for PDF-sourced annotations in:
- `app/modules/workspace-shell/composables/usePageAnnotationActions.ts`

So "remove" is materially closer than "edit".

## Recommended Implementation Strategy

## Phase 0: clarify ownership split

Do not force one mechanism for every annotation type.

Use the best owner per subtype:

- PDF.js-native owner:
  - `FreeText`
  - `Ink`
  - `Highlight`
  - `Stamp`

- EVB custom owner:
  - `Line`
  - `Square`
  - `Circle`
  - `Polyline`
  - `Polygon`
  - `Arrow` as EVB presentation on top of `/Line` + `LE`

This avoids rebuilding an ink editor we already get from PDF.js.

## Phase 1: add embedded geometric shape import

Create a parser/composable dedicated to reverse mapping non-native geometric annotations.

Suggested new module:
- `app/composables/pdf/usePdfEmbeddedShapeImport.ts`

Responsibilities:
- iterate `page.getAnnotations()`
- extract supported geometric subtypes
- normalize PDF coordinates into EVB page-normalized coordinates
- produce enriched `IShapeAnnotation` objects
- preserve original identity and subtype metadata

Suggested call site:
- `app/components/pdf/PdfViewer.vue`
  - watch document changes
  - import embedded geometric shapes after the PDF document becomes available
  - feed them into `shapeComposable.loadShapes(...)`

Important rule:
- only import non-PDF.js-native geometric annotations here
- do not duplicate `Ink`, `FreeText`, `Highlight`, `Stamp`, because PDF.js already owns those

## Phase 2: extend shape model to preserve PDF identity

Extend `IShapeAnnotation` with fields like:

- `source: 'local' | 'embedded'`
- `annotationId?: string | null`
- `pdfSubtype?: 'Line' | 'Square' | 'Circle' | 'Polyline' | 'Polygon'`
- `popupRef?: string | null`
- `vertices?: number[]`

This is required so edits can target the original annotation instead of always appending a fresh one.

## Phase 3: update/delete existing embedded geometric annotations in place

Add a new worker-side rewrite path that can:

- resolve an existing annotation by ref/id
- rewrite geometry/style fields for supported subtypes
- remove the original annotation when the mapped shape is deleted

Suggested home:
- extend `app/composables/pdf/pdfSerializationOperations.ts`
- or split geometric annotation mutations into a dedicated helper

Required operations:
- update `/Rect`, `/L`, `/IC`, `/C`, `/CA`, `/Border`, `/LE`
- update `/Vertices` for polygon/polyline
- delete the original annotation ref rather than leaving stale copies behind

## Phase 4: unify selection/edit UX

For embedded EVB-owned shapes:
- selection should pick the imported shape overlay, not the underlying passive annotation layer element
- edits should operate on the shape model
- save should write back to the same embedded annotation id

For PDF.js-owned editable annotations:
- rely on the existing editor layer and annotation ids
- improve UX only if needed, but do not fork ownership unless there is a hard blocker

## Phase 5: suppress duplicate display

Imported geometric shapes will otherwise appear twice:
- once in EVB overlay
- once in the annotation layer

We need a display suppression strategy for embedded geometric annotations while editing.

Likely options:
- hide matched annotation-layer DOM nodes by `data-annotation-id`
- or filter them from EVB overlays when not in edit mode

The first option gives more consistent "single object" behavior.

## Suggested Repo Insertion Points

### Parsing/import
- `app/components/pdf/PdfViewer.vue`
- new `app/composables/pdf/usePdfEmbeddedShapeImport.ts`
- possibly reuse geometry helpers from `app/composables/pdf/annotationGeometry.ts`

### State/model
- `app/types/annotations.ts`
- `app/composables/pdf/useAnnotationShapes.ts`

### Save/update/delete
- `app/composables/pdf/usePdfSerialization.ts`
- `app/composables/pdf/pdfSerializationOperations.ts`
- `app/composables/pdf/pdfSerializationRefs.ts`

### UX / hit-testing
- `app/components/pdf/PdfViewer.vue`
- `app/components/pdf/PdfShapeOverlay.vue`
- `app/modules/workspace-shell/composables/usePageAnnotationActions.ts`

## Testing Gaps

Current E2E coverage is heavily centered on `FreeText` lifecycle and persistence.

Missing coverage:
- save + reopen + re-edit `Ink`
- save + reopen + edit + delete `Line`
- save + reopen + edit + delete `Square`
- save + reopen + edit + delete `Circle`
- import and edit third-party `/Polygon` or `/Polyline`
- duplicate suppression between imported shapes and annotation layer

## Recommended First Slice

The lowest-risk first delivery is:

1. import `/Line`, `/Square`, `/Circle` into `shapeComposable`
2. preserve `annotationId` on imported shapes
3. support delete of imported shapes by deleting the original embedded annotation
4. support basic move/resize/style rewrite in place for those three subtypes

Why this slice first:
- EVB already has UI for those shapes
- their PDF geometry is simple
- they cover both EVB-authored saves and many third-party files
- they avoid rebuilding native PDF.js ink editing

## Non-Goals For The First Slice

- full arbitrary appearance-stream inference
- true content-stream editing of flattened page graphics
- a custom EVB replacement for PDF.js `InkEditor`
- perfect normalization of every exotic third-party annotation producer

## Bottom Line

This feature is feasible, but it should be split into two ownership models:

- let PDF.js continue owning existing editable annotations it already understands
- add an EVB reverse-mapping pipeline for geometric annotations that PDF.js renders but does not rehydrate

That hybrid path matches the current codebase and avoids reimplementing the wrong pieces.
