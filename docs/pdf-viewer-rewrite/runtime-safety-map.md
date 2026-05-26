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

## Golden Behavior Targets

Before or during extraction, keep targeted coverage around:

- annotation comment reload merging, local deletion, transient note identity, and marker movement
- source reload during save and reload grace windows
- zoom rerender anchoring and effective zoom emissions
- visible range, buffered rendering, and stale render cancellation
- search highlight timing after page renders and rerenders

## Locked Semantics

Do not change FreeText note persistence or PDF serialization behavior as part of
the structural rewrite. See `docs/freetext-note-persistence.md` before editing
annotation serialization or note persistence paths.
