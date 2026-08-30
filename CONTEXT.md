# EVB Viewer

A desktop and browser PDF/DjVu viewer with Acrobat-style annotation editing for
a small circle of users. This glossary fixes the words the codebase and its
decisions use for documents, annotations, and the parts that read and write them.

## Documents

**Working copy**:
The private, decrypted copy of an opened file that every read, edit, and save
operates on until the user saves back to the original path.
_Avoid_: temp file, scratch copy, materialized file

**Renderer**:
The component that turns a page into pixels, a text layer, and a static display
of annotations it does not edit. It never produces PDF bytes.
_Avoid_: engine, viewer core

**Writer**:
The single component that produces PDF bytes for a save, whether by appending
an incremental update or rewriting the file.
_Avoid_: save route, materializer, saveDocument

## Annotations

**Canonical annotation store**:
The one in-app owner of every annotation's state. Every other view of an
annotation (on-page display, sidebar, written PDF objects) derives from it.
_Avoid_: annotation storage, editor state, mirror

**Annotation editor layer**:
The EVB-owned on-page UI that creates, moves, resizes, and edits annotations
against the canonical annotation store.
_Avoid_: editor bridge, editor UI manager, annotation layer

**Editable annotation type**:
An annotation kind the annotation editor layer can create and modify: text box,
highlight, note, stamp, shape.
_Avoid_: editor type, supported annotation

**Foreign annotation**:
An annotation the canonical annotation store does not own: a non-editable
type (link, widget, unknown subtype) or an editable type it cannot represent.
The renderer displays it read-only and the writer preserves it untouched.
_Avoid_: imported annotation, external annotation, legacy annotation

**Opening preview**:
The fast first paint of a document produced outside the renderer while the
renderer is still loading.
_Avoid_: native preview, skeleton
