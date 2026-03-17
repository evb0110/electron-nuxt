# Web Runtime Refactor Plan

## Goal

Support one shared PDF-first codebase for:

- Electron desktop
- Web browser

with thin runtime adapters and without OCR in scope.

DjVu should be treated as optional and isolated behind its own capability.

## Summary

The current codebase is already close to the right shape:

- shared UI and viewer logic live under `app/**`
- runtime selection already exists in `app/utils/platform.ts`
- a browser implementation already exists in `app/platform/browser-api.ts`
- many PDF workflows already run in pure browser code

The main issue is not missing portability. The main issue is that the current runtime contract is too broad and too path-shaped. `IElectronAPI` mixes:

- file persistence
- file pickers
- recent files
- page ops
- export
- menu events
- shell integration
- window behavior
- updates

That makes the browser implementation larger than it needs to be and forces shared code to think in desktop terms.

## Target Architecture

Shared code should depend on a runtime-neutral `PlatformApi`, not an Electron-shaped API.

Suggested top-level ports:

1. `DocumentRepository`
2. `DocumentPicker`
3. `PdfProcessing`
4. `SearchCapability`
5. `SettingsCapability`
6. `WindowCapability`
7. `ShellCapability`
8. `UpdatesCapability`
9. `DjvuCapability`

The key rule is:

- shared code must not care whether a document is a filesystem path, IndexedDB record, OPFS file, or in-memory object

Instead, shared code should use a neutral `DocumentRef`.

## Core Type Changes

### Replace path-shaped identifiers in shared code

Current shared code still uses names like:

- `workingCopyPath`
- `originalPath`
- `sourcePath`

Even in browser mode, those are already synthetic refs such as `browser://documents/...`.

Introduce:

```ts
type DocumentRef = string;
```

Initially this can still be a string alias. The value is semantic, not technical:

- desktop implementation: absolute filesystem path
- browser implementation: `browser://documents/...` ref

After that, rename shared-facing contract fields from `*Path` to `*Ref` where they are not guaranteed to be real paths.

Recommended first-pass rename targets:

- `workingCopyPath` -> `workingCopyRef`
- `originalPath` -> `originalRef`
- `sourcePath` -> `sourceRef`
- `destPath` -> `destRef`
- `outputPath` -> `outputRef`

Do not do this as a global big-bang rename. Migrate contract boundaries first, then usage sites.

## Proposed Port Split

### 1. `DocumentRepository`

Responsibility:

- read document bytes
- write document bytes
- create working copies
- persist/save
- cleanup
- recent files storage
- metadata like file size or display name

Methods migrated from current `documents` capability:

- `readFile`
- `readFileRange`
- `readTextFile`
- `statFile`
- `fileExists`
- `writeFile`
- `writeDocxFile`
- `createWorkingCopyFromData`
- `createWorkingCopyFromPath`
- `saveFile`
- `cleanupFile`
- `cleanupOcrTemp` (remove later if OCR stays out of scope)
- `recentFiles.*`
- `getPathForFile` should move out unless still needed by Electron-only drag/drop glue

Desktop implementation:

- existing Electron file ops

Browser implementation:

- existing `browserDocumentStore`

### 2. `DocumentPicker`

Responsibility:

- open input documents
- open image input
- save-as destination selection
- export destination selection

Methods migrated from current `documents` capability:

- `openPdfDialog`
- `openImageDialog`
- `openPdfDirect`
- `openPdfDirectBatch`
- `savePdfAs`
- `savePdfDialog`
- `saveDocxAs`

Desktop implementation:

- Electron dialogs and direct path opens

Browser implementation:

- `showOpenFilePicker`
- `showSaveFilePicker`
- `<input type="file">` / download fallback

### 3. `PdfProcessing`

Responsibility:

- validate PDF data
- analyze conformance
- page operations
- image export

Methods:

- `analyzePdfConformance`
- `validatePdfData`
- `exportPdfToImages`
- `exportPdfToMultiPageTiff`
- `pageOps.*`

Desktop implementation:

- existing Electron features

Browser implementation:

- existing browser `pdf-lib` / `pdfjs-dist` code

### 4. `WindowCapability`

Responsibility:

- tab transfer
- renderer ready
- close current window
- title synchronization

Methods:

- current `windowTabs.*`
- `setWindowTitle`

Desktop implementation:

- Electron window APIs

Browser implementation:

- current `BroadcastChannel`-based adapter

### 5. `ShellCapability`

Responsibility:

- external links
- reveal in folder

Methods:

- `openExternal`
- `showItemInFolder`

Browser implementation should be allowed to no-op or emulate with downloads/navigation where appropriate.

### 6. `UpdatesCapability`

Responsibility:

- app updates only

This stays runtime-specific and should remain optional in shared UI.

### 7. `DjvuCapability`

Responsibility:

- isolated optional document-family support

Do not let DjVu shape the base `DocumentRepository` or `PdfProcessing` contracts any more than necessary.

## File-by-File Refactor Map

### Contracts

#### `packages/contracts/electron-api.ts`

Problem:

- current contract is runtime-shaped around Electron and groups too many responsibilities together

Change:

- keep this file temporarily as a compatibility layer
- introduce a new file, for example `packages/contracts/platform-api.ts`
- move neutral contracts there
- re-export compatibility aliases from `electron-api.ts` during migration

Expected new contract files:

- `packages/contracts/platform-api.ts`
- `packages/contracts/document-repository.ts`
- `packages/contracts/document-picker.ts`
- `packages/contracts/pdf-processing.ts`
- `packages/contracts/window-capability.ts`
- `packages/contracts/shell-capability.ts`

Migration note:

- shared `app/**` should move to importing neutral contracts first
- Electron preload can continue satisfying a compatibility wrapper until the migration is complete

#### `packages/contracts/window-tabs.ts`

Change:

- keep, but consider renaming later to a more neutral `window-transfers.ts`
- no immediate structural change needed

### Shared runtime entry

#### `app/utils/platform.ts`

Current role:

- returns `electronAPI ?? browserPlatformApi`

Change:

- rename `getElectronAPI()` to `getPlatformAPI()`
- keep `getElectronAPI()` only as a temporary compatibility alias
- make shared code gradually stop importing Electron-named runtime accessors

#### `app/platform/browser-api.ts`

Current role:

- browser implementation of the Electron-shaped contract

Change:

- split into smaller adapter exports aligned with the new ports
- add a new composition root such as `app/platform/browser-platform-api.ts`
- leave `app/platform/browser-api.ts` as a transitional facade if needed

Suggested end state:

- `app/platform/browser/document-repository.ts`
- `app/platform/browser/document-picker.ts`
- `app/platform/browser/pdf-processing.ts`
- `app/platform/browser/search-capability.ts`
- `app/platform/browser/window-capability.ts`
- `app/platform/browser/settings-capability.ts`
- `app/platform/browser/shell-capability.ts`
- `app/platform/browser/updates-capability.ts`
- `app/platform/browser/djvu-capability.ts`

### Browser persistence and IO

#### `app/platform/browser-document-store.ts`

Current role:

- IndexedDB-backed browser document persistence

Change:

- keep most of the implementation
- rename conceptually to the repository backend for browser runtime
- add lightweight helpers:
  - `getDisplayName(ref)`
  - `getSaveTarget(ref)`
  - `cloneWorkingCopy(ref)`

This file should become the main browser implementation of `DocumentRepository`.

#### `app/platform/browser-api/documents-capability.ts`

Current role:

- huge browser adapter mixing:
  - pickers
  - storage
  - validation
  - export
  - page ops
  - title updates
  - menu no-ops

Change:

- split by responsibility

Suggested extraction:

- picker logic -> `app/platform/browser/document-picker.ts`
- PDF validation/conformance -> `app/platform/browser/pdf-validation.ts`
- image export -> `app/platform/browser/pdf-image-export.ts`
- page ops -> `app/platform/browser/pdf-page-ops.ts`
- repository wiring -> `app/platform/browser/document-repository.ts`

This is the single most valuable cleanup for the web/app convergence.

### Browser window integration

#### `app/platform/browser-window-tabs.ts`

Current role:

- browser implementation of cross-window tab transfer

Change:

- keep most logic intact
- move under a neutral runtime folder such as `app/platform/browser/window-capability.ts`
- separate pure transfer logic from UI-title sync helper if useful

### Electron preload composition

#### `electron/preload/create-electron-api.ts`

Current role:

- assembles Electron preload client into `IElectronAPI`

Change:

- keep as Electron composition root
- after neutral contract extraction, build `PlatformApi`
- optionally keep an `IElectronAPI` compatibility export during migration

This file should stay thin.

#### `electron/features/documents/preload-client.ts`

Problem:

- current preload client is too broad
- it mirrors the same oversized contract as the browser side

Change:

- split into smaller preload clients:
  - `electron/features/documents/preload-document-repository.ts`
  - `electron/features/documents/preload-document-picker.ts`
  - `electron/features/documents/preload-pdf-processing.ts`
  - `electron/features/documents/preload-menu-events.ts`

Then compose them in `create-electron-api.ts`.

### Electron main-process features

#### `electron/features/documents/main/file-ops.ts`

Change:

- becomes main implementation of `DocumentRepository` for desktop

#### `electron/features/documents/main/dialogs.ts`

Change:

- becomes main implementation of `DocumentPicker` for desktop

#### `electron/features/documents/main/pdf-conformance.ts`

Change:

- moves under desktop `PdfProcessing`

#### `electron/features/page-ops/main/qpdf.ts`

Change:

- remains desktop-only implementation detail
- shared code should depend on `PdfProcessing.pageOps`, not on qpdf semantics

#### `electron/features/image-export/main/export.ts`

Change:

- remains desktop-only implementation detail of `PdfProcessing`

### Shared composables and app code

#### `app/composables/pdf/usePageOperations.ts`

Current issue:

- still reaches for `getElectronAPI()`

Change:

- switch to `getPlatformAPI()` only
- update method names from path/ref terminology once the contract changes land

#### `app/composables/useFileOperations.ts`

Current issue:

- mixes save orchestration with path-shaped assumptions

Change:

- keep orchestration shared
- make its dependencies repository-oriented:
  - `readDocumentBytes`
  - `persistWorkingCopy`
  - `saveAsDocument`
  - `validatePdfData`

This composable should remain shared and lose knowledge of desktop file semantics.

#### `app/modules/workspace-shell/**`

Change:

- keep shared
- migrate only the runtime access points
- avoid changing UI structure unless required by contract cleanup

## Runtime-Specific Features That Should Stay Optional

These should not shape the shared core:

- app updates
- default app registration
- native shell reveal/open behavior
- native menu integration
- direct filesystem absolute-path assumptions

The shared app should render and function without them.

## DjVu Strategy

DjVu should not block the shared-core refactor.

Recommended approach:

- keep `DjvuCapability` optional
- preserve existing Electron implementation
- keep browser DjVu as stub initially
- later replace browser stub with a web-specific implementation if needed

That prevents DjVu from forcing low-level contracts to stay desktop-shaped.

## Migration Order

### Phase 1: Naming and contract cleanup

1. Introduce neutral `PlatformApi` contracts alongside current Electron-named contracts.
2. Add `DocumentRef` alias.
3. Add compatibility exports so old imports still work.
4. Replace `getElectronAPI()` imports in shared code with `getPlatformAPI()`.

### Phase 2: Split documents capability

1. Extract browser document repository.
2. Extract browser picker adapter.
3. Extract browser PDF processing adapter.
4. Split Electron preload client to mirror the same shape.

### Phase 3: Move shared code onto neutral ports

1. Update shared composables to depend on smaller ports.
2. Rename `*Path` to `*Ref` at shared boundaries.
3. Reduce menu-specific coupling in shared code.

### Phase 4: Optional cleanup

1. Rename `electron-api.ts` compatibility surface.
2. Move browser adapter files into a more neutral folder layout.
3. Trim compatibility aliases after all imports are migrated.

## Recommended First PRs

### PR 1

- add `platform-api` contracts
- add `DocumentRef`
- add compatibility aliases
- switch shared imports from `getElectronAPI()` to `getPlatformAPI()`

### PR 2

- split `app/platform/browser-api/documents-capability.ts`
- keep behavior unchanged

### PR 3

- split `electron/features/documents/preload-client.ts`
- compose smaller ports in `electron/preload/create-electron-api.ts`

### PR 4

- migrate shared composables from `*Path` assumptions to `*Ref` assumptions

### PR 5

- make updates, shell-only actions, and DjVu clearly optional in shared UI

## Success Criteria

The refactor is successful when:

- shared `app/**` code imports only neutral platform contracts
- browser and Electron both satisfy the same narrow `PlatformApi`
- page ops, search, save, annotations, workspace, and export stay shared
- Electron-only features no longer leak desktop assumptions into the shared core
- web can ship as a first-class runtime without maintaining a forked UI layer
