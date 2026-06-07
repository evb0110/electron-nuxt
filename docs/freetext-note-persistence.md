# FreeText Note Persistence

> Why sticky note text disappears on save/reopen, and why the fix works the way it does.

## The Core Constraint

PDF.js `PopupAnnotation` reads `/Contents` from its **parent** annotation dict, not from the Popup's own dict. For FreeText sticky notes, the parent is the FreeText annotation. This is hardcoded in PDF.js and cannot be changed without forking the library.

This creates an impossible tension:

- **FreeText needs `/Contents` cleared** — because FreeText renders `/Contents` as visible text on the canvas via its AP (appearance) stream. A sticky note marker should not show a text block on the page.
- **Popup needs `/Contents` intact** — because Popup reads it from the FreeText parent to display the note text in the popup window.

You cannot satisfy both requirements by manipulating `/Contents` alone.

## Why Previous Approaches Failed

### Clearing /Contents to ZWS (zero-width space)

Setting `/Contents` to `\u200B` prevented canvas text rendering, but also destroyed the Popup's text source. The Popup opened empty because it read ZWS from the parent.

### Writing text to the Popup dict only

Useless — PDF.js ignores the Popup's own `/Contents` and always reads from the parent. The Popup still opened empty.

### Skipping /Contents update for FreeText+Popup annotations

This preserved text on first save, but on reopen PDF.js would re-read the original (stale) `/Contents`, overwriting any edits made in the note window.

## Why the Blank AP Stream Works

The solution replaces the FreeText annotation's **AP stream** (not `/Contents`) with a blank Form XObject — a zero-area drawing that renders nothing on the canvas.

This resolves the tension because:
- `/Contents` keeps the real note text → Popup reads it correctly
- The blank AP stream overrides FreeText's visual rendering → nothing appears on the canvas
- `updateAnnotationTextByRef` can safely write text to the FreeText `/Contents` dict, since the blank AP prevents it from showing on the page

## Why the Rect Must Be Rewritten

The annotation sync layer classifies FreeText annotations as "point-like note markers" only when their normalized dimensions are tiny (≤ 0.02). PDF.js saves FreeText rects at editor size (e.g. 7×20 points), which is far too large to pass this check. Without rect rewriting, the annotation would not be recognized as a note marker on reopen, and no marker button would appear.

## Why ZWS Must Be Stripped

Legacy saves (from the broken ZWS-clearing approach) left `\u200B` or BOM `\uFEFF` in `/Contents`. Two guards strip these invisible characters:

1. **Annotation sync text selection** — To decide whether the FreeText's text is "truly empty" (should fall through to popup text) vs "has real content". Without stripping, `"\u200B"` counts as non-empty and gets chosen over the popup's real text.

2. **Stale-empty-sync guard** — To prevent a sync cycle from overwriting a note's saved text with empty text. The guard compares saved vs incoming text; without stripping, `"\u200B"` ≠ `""` would bypass the guard and discard saved content.

## Why annotationCursorMode Needs the Note Window Count

When note windows are open, the PDF.js annotation editor layer must remain active. If `annotationCursorMode` returns `false`, the editor layer deactivates, destroying the backing editors that the note windows reference. The `hasOpenAnnotationNotes` bridge ensures the cursor mode stays active as long as any note window is open.

## Why the Safety Guard Exists

pdf-lib performs a full re-serialize when saving. Annotations that PDF.js added via incremental save can sometimes be lost during this process. The 50% size check detects catastrophic data loss and falls back to the original bytes rather than saving a corrupted file.

## Save Pipeline Order

`rewriteFreeTextNoteRects` (blank AP + rect shrink) must run **before** `rewriteEmbeddedNoteTexts` (text updates). The blank AP makes it safe to write text to `/Contents` — without it, the text would render on the canvas.

## Key Files

| File | Responsibility |
|------|---------------|
| `app/composables/pdf/usePdfSerialization.ts` | Orchestrates the save pipeline order |
| `app/utils/pdf-viewer/pdf-serialization-operations/serializePdfEdits.ts` | Runs FreeText rect rewriting before embedded text updates |
| `app/utils/pdf-viewer/serialization/pdf-serialization-free-text/applyFreeTextNoteRects.ts` | Blank AP stream + rect rewrite during save |
| `app/utils/pdf-viewer/serialization/pdf-serialization-free-text/applyNewFreeTextNoteAnnotations.ts` | Replays newly-created FreeText note markers |
| `app/utils/pdf-viewer/serialization/pdf-serialization-embedded-notes/applyEmbeddedNoteTextUpdates.ts` | Applies note text updates during full serialization |
| `app/utils/pdf-viewer/pdf-serialization-comments/updateAnnotationTextByRef.ts` | Writes note text to FreeText `/Contents` for targeted updates |
| `app/composables/pdf/annotations/useAnnotationSync.ts` | ZWS stripping when selecting text source |
| `app/composables/pdf/useAnnotationNoteWindows.ts` | ZWS stripping in stale-empty-sync guard |
