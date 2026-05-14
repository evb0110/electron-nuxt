# PDF Content Editing RFC

## Snapshot
- Date: March 1, 2026
- Status: Draft
- Scope: Add basic true PDF editing to EVB Viewer with a simple UI
- Requested capabilities:
  - Delete parts of text
  - Edit parts of text while preserving existing font/style where possible
  - Resize and move parts of page content
  - Insert external image with resize/rotate/transform

## Problem Statement
Current editing in EVB Viewer is annotation-oriented. We support highlight, free text, shape annotations, and page operations, but we do not support reliable true content-stream edits for text/object/image content.

This RFC defines an implementation architecture that fits this repo and aligns with PDF standards and common product design in Acrobat/Foxit/Nitro/PDF-XChange class editors.

## Goals
- Provide a basic, clean, low-friction editing UX.
- Preserve current architecture boundaries (`app`, `electron`, `packages/contracts`).
- Keep save reliability and working-copy safety.
- Support true content changes for supported targets.
- Keep annotation workflows intact and explicitly separated from edit workflows.

## Non-Goals (Initial Rollout)
- Full desktop-publishing reflow editor semantics.
- Guaranteed style-preserving edits for every PDF font/encoding edge case.
- Editing tagged-structure trees for accessibility parity in v1.
- Signature-preserving true rewrite in all signed documents.

## Standards and Interop Constraints
Inference from sources listed at end:
- PDF text is painting operators in content streams, not document text nodes.
- Text replacement may require:
  - operator-level patching (`Tj`, `TJ`, `Tf`, text matrices),
  - font coverage checks,
  - glyph width/position handling.
- Images can be inline image operators or XObject references; operation handling differs.
- Appearance streams matter for annotation/widget reliability.
- Signed docs and PAdES flows require strict incremental update behavior; many true rewrites invalidate signatures.
- PDF/A introduces additional conformance constraints that can reject otherwise valid edits.

## Industry UX Synthesis
- Explicit mode entry (`Edit PDF`) separate from comments/annotations.
- On-page direct manipulation first (selection box, handles, context actions).
- Side inspector for precision fields.
- Progressive disclosure:
  - Simple actions visible by default,
  - advanced controls in inspector.
- Clear capability/fallback messaging when the document or object cannot be safely edited.

## Current Codebase Anchors
- Workspace integration root:
  - `app/components/DocumentWorkspace.vue`
  - `app/modules/workspace-shell/service.ts`
- Viewer and page layering:
  - `app/components/pdf/PdfViewer.vue`
  - `app/components/pdf/PdfViewerPage.vue`
  - `app/composables/pdf/usePdfPageRenderer.ts`
  - `app/modules/pdf-viewer-runtime/service.ts`
- Current save and rewrite chain:
  - `app/composables/usePageSaveOrchestration.ts`
  - `app/composables/useFileOperations.ts`
  - `app/composables/pdf/usePdfSerialization.ts`
- Undo/redo routing:
  - `app/composables/page/workspace-view-state.ts`
  - `app/composables/usePdfHistory.ts`
- Toolbar/sidebar architecture:
  - `app/components/PdfToolbar.vue`
  - `app/components/pdf/PdfSidebar.vue`
- Electron IPC feature registration and preload contract:
  - `electron/ipc/registry.ts`
  - `electron/preload/create-electron-api.ts`
  - `packages/contracts/electron-api.ts`
- Working copy and file safety:
  - `electron/ipc/workingCopyCreation.ts`
  - `electron/ipc/workingCopySave.ts`
  - `electron/ipc/workingCopyStore.ts`
  - `electron/features/documents/main/fileOps.ts`
  - `electron/utils/path-validator.ts`
- Existing feature module pattern references:
  - `electron/features/documents/*`
  - `electron/features/page-ops/*`
  - `electron/features/search/*`

## Proposed Architecture

### 1) Interaction Model
Add top-level interaction mode:
- `view`
- `annotate`
- `edit`

Rule:
- only one mode active at a time.
- entering `edit` mode cancels annotation tool placement/state.

### 2) Edit Data Model
Renderer keeps a typed operation log + transient selection state. True byte-level mutation happens on save in Electron main process.

Why:
- Keeps UI responsive.
- Fits existing save orchestration.
- Reduces corruption risk by centralizing byte mutation in main process.

### 3) Hybrid Editing Strategy
- Overlay editing path:
  - for fast interaction, previews, and safe fallback when true edit is unsupported.
- True rewrite path:
  - for supported text replace/delete, object transform, image insert operations.
- Commit policy:
  - attempt true rewrite for supported operations.
  - mark unsupported operations with user-visible fallback/error state.

### 4) Capability Preflight
When document loads or mode switches to `edit`, compute capability matrix:
- signed/encrypted/PDF-A detection,
- per-page editability hints,
- per-target edit support.

Result drives:
- enabled tools,
- warnings,
- operation validation before commit.

## Proposed Renderer Changes

### New Files
- `app/types/pdf-content-edit.ts`
- `app/composables/pdf/content-edit/usePdfContentEditSession.ts`
- `app/composables/pdf/content-edit/usePdfContentEditCommands.ts`
- `app/composables/pdf/content-edit/usePdfContentEditSelection.ts`
- `app/composables/pdf/content-edit/usePdfContentEditHitTest.ts`
- `app/components/pdf/PdfContentEditOverlay.vue`
- `app/components/pdf/PdfContentEditInspector.vue`
- `app/composables/usePageContentEditTools.ts`
- `app/composables/usePageContentEditActions.ts`
- `app/composables/pdf/useContentEditContextMenu.ts`

### Existing Files to Extend
- `app/components/pdf/PdfViewerPage.vue`
  - add `content-edit-layer` mount point near existing layers.
- `app/components/pdf/PdfViewer.vue`
  - wire edit mode props/events and expose edit API methods.
- `app/components/DocumentWorkspace.vue`
  - pass edit mode/tool state and bind edit actions/events.
- `app/components/PdfToolbar.vue`
  - add mode switch + compact edit tool group.
- `app/components/pdf/PdfSidebar.vue`
  - extend tab union to include `edit`; add inspector panel.
- `app/composables/page/workspace-orchestration.types.ts`
  - extend exposed viewer contract with edit methods.
- `app/composables/page/workspace-view-state.ts`
  - unify undo context selection with edit command stack.
- `app/composables/usePdfHistory.ts`
  - route undo/redo to edit stack when edit mode/context active.

## Proposed Electron/Main Process Changes

### New Feature Module
Create `electron/features/content-edit/`:
- `contract.ts`
- `ports.ts`
- `service.ts`
- `ipc-adapter.ts`
- `preload-client.ts`

Register in:
- `electron/ipc/registry.ts`
- `electron/preload/create-electron-api.ts`
- `packages/contracts/electron-api.ts`

### Editing Engine (Main Process)
Create `electron/content-edit/`:
- `engine.ts` (entrypoint orchestration)
- `resolver.ts` (resolve anchors to concrete objects/operators)
- `applier.ts` (apply operation mutations)
- `capabilities.ts` (document + target capability analysis)
- `errors.ts` (typed failure codes)

All commit operations run against working copy path and existing path validation.

## TypeScript Interface Drafts

### A) Renderer Domain Types (`app/types/pdf-content-edit.ts`)
```ts
export type TContentEditMode = 'view' | 'annotate' | 'edit';

export type TContentEditTool =
    | 'select'
    | 'text-replace'
    | 'text-delete'
    | 'object-transform'
    | 'image-insert';

export interface IContentEditMatrix {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

export interface IContentEditAnchor {
    pageIndex: number;
    pageFingerprint: string;
    bbox: [number, number, number, number];
    textSnippet?: string;
    objectKind: 'text' | 'path' | 'image';
}

export interface IContentEditResolution {
    streamRef: string;
    objectRef?: string;
    opStart: number;
    opEnd: number;
    fontRef?: string;
    confidence: number;
}

export type TContentEditOperation =
    | {
        id: string;
        kind: 'text.replace';
        anchor: IContentEditAnchor;
        resolution?: IContentEditResolution;
        replacementText: string;
        preserveStyle: true;
    }
    | {
        id: string;
        kind: 'text.delete';
        anchor: IContentEditAnchor;
        resolution?: IContentEditResolution;
    }
    | {
        id: string;
        kind: 'object.transform';
        anchor: IContentEditAnchor;
        resolution?: IContentEditResolution;
        matrix: IContentEditMatrix;
    }
    | {
        id: string;
        kind: 'image.insert';
        pageIndex: number;
        assetId: string;
        matrix: IContentEditMatrix;
    };

export interface IContentEditAsset {
    id: string;
    mime: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
    bytes: Uint8Array;
    sha256: string;
}

export interface IContentEditSession {
    documentFingerprint: string;
    operations: TContentEditOperation[];
    assets: Record<string, IContentEditAsset>;
    dirty: boolean;
}

export interface IContentEditCapability {
    canEdit: boolean;
    isSigned: boolean;
    isEncrypted: boolean;
    isPdfA: boolean;
    supportsTextReplace: boolean;
    supportsTextDelete: boolean;
    supportsObjectTransform: boolean;
    supportsImageInsert: boolean;
    warnings: string[];
}
```

### B) Viewer Expose Draft Extension (`workspace-orchestration.types.ts`)
```ts
// Extend existing interface
interface IPdfViewerExpose {
    // existing methods...
    setContentEditMode: (mode: TContentEditMode) => void;
    setContentEditTool: (tool: TContentEditTool) => void;
    getContentEditSession: () => IContentEditSession;
    loadContentEditSession: (session: IContentEditSession) => void;
    clearContentEditSession: () => void;
    undoContentEdit: () => void;
    redoContentEdit: () => void;
    getContentEditCanUndo: () => boolean;
    getContentEditCanRedo: () => boolean;
}
```

### C) Electron API Contract Draft (`packages/contracts/electron-api.ts`)
```ts
export interface IContentEditCommitRequest {
    workingCopyPath: string;
    session: IContentEditSession;
    options?: {
        preferIncrementalSave?: boolean;
        strictPdfA?: boolean;
        failOnSignedDocument?: boolean;
    };
}

export interface IContentEditCommitResult {
    success: boolean;
    updatedData?: Uint8Array;
    warnings?: string[];
    operationsApplied?: string[];
    operationsSkipped?: Array<{
        id: string;
        code: string;
        reason: string;
    }>;
}

export interface IContentEditCapabilityRequest {
    workingCopyPath: string;
}

export interface IContentEditAPI {
    analyzeCapabilities: (request: IContentEditCapabilityRequest) => Promise<IContentEditCapability>;
    resolveAnchors: (request: {
        workingCopyPath: string;
        operations: TContentEditOperation[];
    }) => Promise<{
        success: boolean;
        operations: TContentEditOperation[];
    }>;
    commit: (request: IContentEditCommitRequest) => Promise<IContentEditCommitResult>;
}

export interface IContentEditCapabilitySurface {
    contentEdit: IContentEditAPI;
}
```

### D) Feature Contract Draft (`electron/features/content-edit/contract.ts`)
```ts
export const CONTENT_EDIT_CHANNELS = {
    analyzeCapabilities: 'content-edit:analyze-capabilities',
    resolveAnchors: 'content-edit:resolve-anchors',
    commit: 'content-edit:commit',
} as const;
```

## Save Pipeline Integration Draft

### Current chain (simplified)
1. `saveDocument()` from PDF.js
2. rewrite annotation subtype/style metadata
3. serialize shapes
4. rewrite note texts + page labels + bookmarks
5. save working copy

### Proposed chain
1. `saveDocument()` from PDF.js
2. existing annotation/shape/note/page-label/bookmark rewrites
3. `rewriteContentEdits(data, contentEditSession)` (new)
4. persist with existing working-copy flow

### `useFileOperations` draft delta
```ts
const shouldSerialize = (
    annotationDirty.value
    || hasAnnotationChanges()
    || pageLabelsDirty.value
    || bookmarksDirty.value
    || !!pendingTexts
    || contentEditDirty.value // new
);

if (shouldSerialize) {
    let data = await rewriteMarkupSubtypes(rawData);
    data = await serializeShapeAnnotations(data);
    data = await rewriteFreeTextNoteRects(data);
    if (pendingTexts) {
        data = await rewriteEmbeddedNoteTexts(data, pendingTexts);
    }
    data = await rewritePageLabels(data);
    data = await rewriteBookmarks(data);
    data = await rewriteContentEdits(data); // new stage
    await saveFile(data);
}
```

## UX Integration Draft

### Toolbar
- Add an explicit mode toggle:
  - View
  - Annotate
  - Edit
- In edit mode show minimal tool group:
  - Select
  - Text
  - Move/Resize
  - Image

### Sidebar
- Add `edit` tab with:
  - selection metadata
  - numeric transform fields
  - text replacement input (when target is text)
  - image asset controls

### Context Menu Priority
1. Edit target context menu
2. Annotation context menu
3. Page context menu

## Capability and Fallback Policy
- If signed/encrypted restrictions block true rewrite:
  - disable destructive tools or require explicit override.
- If style-preserving text replacement cannot be guaranteed:
  - show warning and offer:
    - cancel
    - fallback font substitution
    - annotate instead (non-destructive)
- If target resolution confidence is below threshold:
  - do not commit operation.

## Implementation Phases

### Phase 1: Foundations (no true write)
- Add mode/tool/session model in renderer.
- Add content edit overlay and selection.
- Add capability analysis IPC.
- Add dirty-state plumbing and UI states.

Acceptance:
- Edit mode can be entered/exited cleanly.
- Selection + handles + inspector work.
- Save path unchanged.

### Phase 2: Image insert + transform commit
- Implement `image.insert` and `object.transform` commit in main process.
- Wire `rewriteContentEdits`.

Acceptance:
- Inserted image persists after save/reload.
- Move/resize/rotate persists for supported objects.

### Phase 3: Text replace/delete commit
- Add text anchor resolver and operator patching for supported cases.
- Add style-preserve matching + fallback codes.

Acceptance:
- Supported text targets can be replaced/deleted and survive reopen.
- Unsupported targets return typed operation errors, no corruption.

### Phase 4: Undo/menu/shortcut unification
- Integrate edit undo/redo context with existing workspace logic.
- Add menu bindings and shortcuts.

Acceptance:
- Undo/redo dispatch is deterministic by context.

### Phase 5: Hardening
- Large-file and malformed-PDF testing.
- Signed/PDF-A behavior validation and explicit warnings.
- Regression suites for save/reload fidelity.

Acceptance:
- No known corruption regressions in test corpus.

## Testing Strategy
- Unit:
  - operation model validation
  - capability matrix derivation
  - resolver/applier pure logic
- Integration:
  - `useFileOperations` with content edit stage
  - IPC contract round trips
- E2E:
  - open -> edit -> save -> reopen assertions
  - mixed workflows (annotation + edit + page ops)
- Corpus:
  - font-heavy PDFs
  - scanned PDFs + OCR output
  - signed docs
  - PDF/A samples

## Risks and Mitigations
- Risk: text edits break layout due to font/encoding mismatch.
  - Mitigation: strict capability checks, fallback path, operation-level skip reasons.
- Risk: object resolution drift after intermediate rewrites.
  - Mitigation: anchor + resolve near commit time on final bytes.
- Risk: race conditions with page ops/save/reload.
  - Mitigation: reuse per-working-copy mutation queue pattern in main process.
- Risk: user confusion between annotation and true edit tools.
  - Mitigation: explicit mode split + simple default toolset.

## Open Questions
- Should signed documents default to read-only edit mode unless user opts in?
- Should unsupported text replacement automatically convert to annotation fallback or stay hard-fail?
- Do we expose per-operation diagnostics to users, or keep diagnostics internal and show simple messages?

## External References
- ISO 32000-2: https://pdfa.org/resource/iso-32000-2/
- PDF specification archive: https://pdfa.org/resource/pdf-specification-archive/
- Arlington PDF model: https://github.com/pdf-association/arlington-pdf-model
- PDF content streams (reference mirror): https://www.verypdf.com/document/pdf-format-reference/txtidx0150.htm
- PDF images (reference mirror): https://www.verypdf.com/document/pdf-format-reference/txtidx0351.htm
- Appearance streams (reference mirror): https://www.verypdf.com/document/pdf-format-reference/txtidx0611.htm
- qpdf JSON model: https://qpdf.readthedocs.io/en/11.6/json.html
- MuPDF write options: https://mupdf.readthedocs.io/en/latest/reference/common/pdf-write-options.html
- ETSI EN 319 142-2 (PAdES): https://www.etsi.org/deliver/etsi_en/319100_319199/31914202/01.02.01_60/en_31914202v010201p.pdf
- DSS signature/DocMDP guidance: https://ec.europa.eu/digital-building-blocks/DSS/webapp-demo/doc/dss-documentation.html
- ISO 19005 (PDF/A): https://pdfa.org/resource/iso-19005-pdfa/
- veraPDF profiles: https://github.com/veraPDF/veraPDF-validation-profiles
- Adobe text edit docs: https://helpx.adobe.com/acrobat/using/edit-text-pdfs.html
- Adobe image/object edit docs: https://helpx.adobe.com/acrobat/using/edit-images-pdfs.html
- PDFium edit API header: https://github.com/chromium/pdfium/blob/chromium/3498/public/fpdf_edit.h
