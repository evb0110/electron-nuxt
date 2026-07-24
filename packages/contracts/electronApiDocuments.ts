import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPlatformUnsupportedResult,
    TPlatformUnsupportedReason,
} from '@contracts/platformUnsupported';
import type {
    IDocumentRevisionChangedEvent,
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IPdfBox,
    IMarkerRect,
    IPoint2D,
} from '@contracts/geometry';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
    IPdfPageLabelsMutation,
    IPdfPageLabelRange,
    TPdfPageLabelStyle,
} from '@contracts/pdfPageLabels';
import type { TPageIndex } from '@contracts/pageNumbers';
import type {
    TPdfAnnotationLineEndStyle,
    TPdfAnnotationMarkupSubtype,
    TPdfAnnotationShapePdfSubtype,
    TPdfAnnotationShapeType,
} from '@contracts/annotations';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type {
    IRecentFile,
    TPdfViewMode,
} from '@contracts/shared';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';

export type TOpenBatchProgressOperation = 'document-open' | 'page-insert';

export interface IDocumentChunkReadOptions {
    chunkBytes?: number;
    signal?: AbortSignal;
}

export interface IDocumentChunkReadResult {
    size: number;
    bytesRead: number;
    chunks: number;
}

export const IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

export interface IManagedTempFileHandle {
    path: TDocumentRef;
    size: number;
    sha256: string;
    leaseId: string;
    revision: TDocumentRevisionToken | null;
}

export function decodeManagedTempFileHandle(value: unknown): IManagedTempFileHandle | null {
    if (
        !isRecord(value)
        || typeof value.path !== 'string'
        || value.path.length === 0
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || typeof value.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.sha256)
        || typeof value.leaseId !== 'string'
        || value.leaseId.length === 0
        || (value.revision !== null && typeof value.revision !== 'string')
    ) {
        return null;
    }
    const revision = value.revision === null ? null : parseDocumentRevisionToken(value.revision);
    if (value.revision !== null && revision === null) {
        return null;
    }
    return {
        path: value.path,
        size: value.size,
        sha256: value.sha256,
        leaseId: value.leaseId,
        revision,
    };
}

export const MAX_DOCUMENT_ALLOCATION_BYTES = 512 * 1024 * 1024;

export function decodeFileStatResult(
    value: unknown,
    maxBytes = Number.MAX_SAFE_INTEGER,
): {
    size: number;
    modifiedAt?: number
} | null {
    if (
        !isRecord(value)
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || value.size > maxBytes
    ) {
        return null;
    }
    const modifiedAt = value.modifiedAt;
    if (modifiedAt !== undefined && (
        typeof modifiedAt !== 'number'
        || !Number.isSafeInteger(modifiedAt)
        || modifiedAt < 0
    )) {
        return null;
    }
    return {
        size: value.size,
        ...(modifiedAt === undefined ? {} : {modifiedAt}),
    };
}

export function assertDocumentAllocationSize(
    value: unknown,
    maxBytes = MAX_DOCUMENT_ALLOCATION_BYTES,
) {
    const decoded = decodeFileStatResult({size: value}, maxBytes);
    if (decoded === null) {
        throw new RangeError(`Document allocation size must be a non-negative safe integer no greater than ${maxBytes} bytes`);
    }
    return decoded.size;
}

export type TDocumentChunkSource = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

export interface IOpenPdfDirectBatchProgress {
    operation: TOpenBatchProgressOperation;
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export type TOpenDocumentDirectBatchProgress = IOpenPdfDirectBatchProgress;

export interface IDocumentsBatchProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export interface ICreateCombinedPdfFromFilesOptions {
    onProgress?: (progress: IDocumentsBatchProgress) => void;
    signal?: AbortSignal;
}

export interface IOpenPdfResult {
    kind: 'pdf';
    workingPath: TDocumentRef;
    originalPath: TDocumentRef;
    isGenerated?: boolean;
    /**
     * Authoritative first-page metadata discovered by the main process from
     * the admitted working copy. The workspace host can therefore publish
     * the exact opening frame in the same transaction that claims the file.
     */
    openingGeometry?: IPdfOpeningGeometry;
}

export interface IOpenDjvuResult {
    kind: 'djvu';
    workingPath: '';
    originalPath: TDocumentRef;
}

export type TOpenFileResult = IOpenPdfResult | IOpenDjvuResult;
export type TOpenFolderDialogResult =
    | {
        ok: true;
        value: TOpenFileResult | null
    }
    | IPlatformUnsupportedResult;
export type TShowItemInFolderResult =
    | {ok: true}
    | IPlatformUnsupportedResult;

export interface IPdfSaveAsOptions { optimizeLossless?: boolean; }

export const PDF_OPTIMIZE_PRESETS = [
    'lossless',
    'balancedScanned',
    'smallScanned',
    'blackAndWhite',
] as const;

export type TPdfOptimizePreset = typeof PDF_OPTIMIZE_PRESETS[number];

export function isPdfOptimizePreset(value: unknown): value is TPdfOptimizePreset {
    return isOneOf(PDF_OPTIMIZE_PRESETS, value);
}

export type TPdfOptimizeProgressPhase =
    | 'preparing'
    | 'rendering'
    | 'assembling'
    | 'optimizing'
    | 'validating'
    | 'complete';

export interface IPdfOptimizeOptions { preset: TPdfOptimizePreset; }

export interface IDocumentMutationRevisionOptions {expectedDocumentRevisionToken: TDocumentRevisionToken;}

export interface IPdfSerializedSaveOptions extends IDocumentMutationRevisionOptions {
    changedObjectRefs?: string[];
    /** Stage validated bytes into the managed working copy without publishing its original file. */
    workingCopyOnly?: true;
}

export interface IPdfSerializedCommitCallbacks {
    verifyBytesBeforeCommit?: (bytes: Uint8Array) => Promise<void>;
    verifyPathBeforeCommit?: (path: TDocumentRef, knownSize: number) => Promise<void>;
    assertBeforeCommit?: () => Promise<void> | void;
}

export interface IPdfNativeStagedCommitOptions extends IDocumentMutationRevisionOptions {changedObjectRefs?: string[];}

export interface IPdfOptimizeProgress {
    requestId: string;
    preset: TPdfOptimizePreset;
    phase: TPdfOptimizeProgressPhase;
    processed: number;
    total: number;
    percent: number;
}

export interface IPdfOptimizeResult {
    path: TDocumentRef | null;
    validation: IPdfValidationResult | null;
    preset: TPdfOptimizePreset;
    originalBytes: number | null;
    optimizedBytes: number | null;
    pageCount: number | null;
}

export interface IPdfNativePageSize {
    width: number;
    height: number;
}

export interface IPdfOpeningGeometry {
    pageNumber: 1;
    pageCount: number;
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
    size: number;
    modifiedAt: number;
}

export interface IPdfNativePagePreviewOptions {
    previewRequestId?: string;
    targetWidthPx?: number;
}

export interface IPdfNativePagePreview {
    bytes: Uint8Array;
    width: number;
    height: number;
}

export interface IPdfNoteTextUpdate {
    objectNumber: number;
    generationNumber: number;
    text: string;
}

export type IPdfNativeFreeTextNoteMarkerRect = IMarkerRect;

export interface IPdfNativeFreeTextNote {
    pageIndex: TPageIndex;
    stableKey: string;
    text: string;
    markerRect: IPdfNativeFreeTextNoteMarkerRect;
    author?: string | null;
    color?: string | null;
    createdAt?: number | null;
}

export interface IPdfNativeAnnotationDelete {
    pageIndex: TPageIndex;
    objectNumber?: number;
    generationNumber?: number;
    stableKey?: string;
    createdAt?: number | null;
}

export interface IPdfNativeNoteChanges {
    updates?: IPdfNoteTextUpdate[];
    freeTextNotes?: IPdfNativeFreeTextNote[];
    deletes?: IPdfNativeAnnotationDelete[];
}

export type TPdfNativePageLabelStyle = TPdfPageLabelStyle;

export type IPdfNativePageLabelRange = IPdfPageLabelRange;

export type IPdfNativePageLabelsMutation = IPdfPageLabelsMutation;

export interface IPdfNativeBookmarksMutation {
    totalPages: number;
    untitledLabel: string;
    items: IPdfBookmarkEntry[];
}

export type TPdfNativeShapeType = TPdfAnnotationShapeType;
export type TPdfNativeShapePdfSubtype = TPdfAnnotationShapePdfSubtype;
export type TPdfNativeShapeLineEndStyle = TPdfAnnotationLineEndStyle;

export type IPdfNativeShapePoint = IPoint2D;

export interface IPdfNativeShapeAnnotation {
    id?: string;
    type: TPdfNativeShapeType;
    pageIndex: TPageIndex;
    x: number;
    y: number;
    width: number;
    height: number;
    x2?: number | null;
    y2?: number | null;
    color: string;
    fillColor?: string | null;
    opacity: number;
    strokeWidth: number;
    points?: IPdfNativeShapePoint[];
    strokes?: IPdfNativeShapePoint[][];
    annotationId?: string | null;
    stableKey?: string | null;
    pdfSubtype?: TPdfNativeShapePdfSubtype | null;
    lineStartStyle?: TPdfNativeShapeLineEndStyle | null;
    lineEndStyle?: TPdfNativeShapeLineEndStyle | null;
    createdAt?: number | null;
    modifiedAt?: number | null;
}

export interface IPdfNativeShapesMutation {
    totalPages: number;
    rewriteShapeState: boolean;
    shapes: IPdfNativeShapeAnnotation[];
    deletedAnnotationIds: string[];
    deletedStableKeys: string[];
}

export type TPdfNativeMarkupSubtype = TPdfAnnotationMarkupSubtype;

export type IPdfNativeMarkupMarkerRect = IMarkerRect;

export interface IPdfNativeMarkupSubtypeHint {
    subtype: TPdfNativeMarkupSubtype;
    pageIndex: TPageIndex;
    markerRect: IPdfNativeMarkupMarkerRect;
    annotationId?: string | null;
    color?: string | null;
    id?: string | null;
    pageMarkupIndex?: number | null;
    source?: string | null;
}

export interface IPdfNativeMarkupMutation {
    overrides: Array<readonly [string, TPdfNativeMarkupSubtype]>;
    hints: IPdfNativeMarkupSubtypeHint[];
}

export interface IPdfNativePlacedImage extends IPdfBox {
    pageIndex: TPageIndex;
    rotationDegrees?: number | null;
    mimeType: 'image/jpeg';
    source: IManagedTempFileHandle;
}

export interface IPdfNativeMutationSet extends IPdfNativeNoteChanges {
    pageLabels?: IPdfNativePageLabelsMutation;
    bookmarks?: IPdfNativeBookmarksMutation;
    shapes?: IPdfNativeShapesMutation;
    markup?: IPdfNativeMarkupMutation;
    placedImages?: IPdfNativePlacedImage[];
}

export interface IPdfNativeNoteTextSaveResult {
    applied: boolean;
    validation: IPdfValidationResult | null;
    syncError?: string;
    /** Immutable native output. It is not visible as document state until committed. */
    stagedOutput?: ITypedStagedArtifact;
}

export type IPdfNativeSaveResult = IPdfNativeNoteTextSaveResult;

export interface IPdfNativeWorkingCopyExpectation {
    byteLength: number;
    sha256: string;
}

export type TDocumentSaveFailureReason =
    | 'user-canceled'
    | 'validation-failed'
    | 'working-copy-missing'
    | 'write-failed'
    | 'refresh-failed'
    | 'working-copy-sync-required'
    | 'unsupported'
    | 'stale'
    | 'unknown';

export interface IDocumentSaveSuccessResult {
    ok: true;
    externalWriteCommitted: boolean;
    workingCopyRefreshed: boolean;
    validation?: IPdfValidationResult | null;
    warning?: {
        reason: Extract<TDocumentSaveFailureReason, 'refresh-failed'>;
        message: string;
    };
}

export interface IDocumentSaveFailureResult {
    ok: false;
    reason: TDocumentSaveFailureReason;
    message?: string;
    externalWriteCommitted?: boolean;
    workingCopySyncRequired?: boolean;
    validation?: IPdfValidationResult | null;
}

export type TDocumentSaveResult =
    | IDocumentSaveSuccessResult
    | IDocumentSaveFailureResult;

export type TImageExportProgressFormat = 'images' | 'multipage-tiff';
export type TImageExportProgressPhase = 'rendering' | 'combining';
export type TImageExportProgressStatus = 'running' | 'success' | 'canceled' | 'failed';

export interface IImageExportProgress {
    requestId: string;
    format: TImageExportProgressFormat;
    phase: TImageExportProgressPhase;
    processed: number;
    total: number;
    percent: number;
    status?: TImageExportProgressStatus;
    error?: string;
}

export type TDocumentImageExportSourceKind = 'pdf' | 'djvu';

export interface IApplicationMenuDocumentState {
    hasDocument: boolean;
    interactive?: boolean;
    canSave: boolean;
    supportsSaveAs?: boolean;
    canSaveAs?: boolean;
    supportsRepairSave?: boolean;
    canRepairSave?: boolean;
    supportsOptimizePdf?: boolean;
    canOptimizePdf?: boolean;
    supportsPrint?: boolean;
    canPrint?: boolean;
    supportsExportDocx?: boolean;
    canExportDocx?: boolean;
    supportsRasterExport?: boolean;
    canExportRaster?: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    supportsPdfMutation?: boolean;
    canMutatePages?: boolean;
    selectedPageCount?: number;
    totalPages?: number;
    supportsContinuousScroll?: boolean;
    canContinuousScroll?: boolean;
    continuousScroll?: boolean;
    supportsViewMode?: boolean;
    viewMode?: TPdfViewMode;
    isActualSizeActive?: boolean;
    isFitWidthActive?: boolean;
    isFitHeightActive?: boolean;
    canToggleAssistant?: boolean;
    canCreatePane?: boolean;
    canCloseTab?: boolean;
    canTransferActiveTab?: boolean;
}

export interface IDocumentsMenuCapability {
    setMenuDocumentState: (state: boolean | IApplicationMenuDocumentState) => Promise<void>;
    setMenuTabCount: (tabCount: number) => Promise<void>;
    onPdfOptimizeProgress: (callback: (progress: IPdfOptimizeProgress) => void) => TMenuEventUnsubscribe;
    onMenuOpenPdf: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuInsertImageFromFile: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuPasteImageFromClipboard: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuSave: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuRepairSave: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuOptimizePdfForInteraction: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuSaveAs: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuPrint: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuPrintCurrentPage: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuExportDocx: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuExportImages: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuExportMultiPageTiff: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuZoomIn: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuZoomOut: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuActualSize: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuFitWidth: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuFitHeight: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuToggleContinuousScroll: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuViewModeSingle: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuViewModeFacing: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuViewModeFacingFirstSingle: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuToggleAssistant: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuUndo: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuRedo: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuDeletePages: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuExtractPages: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuRotateCw: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuRotateCcw: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuInsertPages: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuOpenRecentFile: (callback: (path: TDocumentRef) => void) => TMenuEventUnsubscribe;
    onMenuOpenExternalPaths: (callback: (paths: TDocumentRef[]) => void) => TMenuEventUnsubscribe;
    onMenuClearRecentFiles: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onOpenDocumentDirectBatchProgress: (callback: (progress: TOpenDocumentDirectBatchProgress) => void) => TMenuEventUnsubscribe;
    onOpenPdfDirectBatchProgress: (callback: (progress: IOpenPdfDirectBatchProgress) => void) => TMenuEventUnsubscribe;
}

export interface IDocumentsFileCapability {
    openDocumentDialog: () => Promise<TOpenFileResult | null>;
    openPdfDialog: () => Promise<TOpenFileResult | null>;
    openCombineDialog: () => Promise<TOpenFileResult | null>;
    openFolderDialog: () => Promise<TOpenFileResult | null>;
    openFolderDialogStructured?: () => Promise<TOpenFolderDialogResult>;
    openImageDialog: () => Promise<string | null>;
    openDocumentDirect: (path: TDocumentRef) => Promise<TOpenFileResult | null>;
    openPdfDirect: (path: TDocumentRef) => Promise<TOpenFileResult | null>;
    openDocumentDirectBatch: (
        paths: TDocumentRef[],
        requestId?: string,
        options?: {forceCombine?: boolean},
    ) => Promise<TOpenFileResult | null>;
    openPdfDirectBatch: (
        paths: TDocumentRef[],
        requestId?: string,
        options?: {forceCombine?: boolean},
    ) => Promise<TOpenFileResult | null>;
    cancelOpenDocumentDirectBatch?: (requestId: string) => Promise<boolean>;
    savePdfAs: (
        workingCopyPath: TDocumentRef,
        options: IPdfSaveAsOptions | undefined,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<TDocumentRef | null>;
    savePdfDialog: (suggestedName: string) => Promise<string | null>;
    saveDocxAs: (workingCopyPath: TDocumentRef) => Promise<TDocumentRef | null>;
    readFile: (path: TDocumentRef) => Promise<Uint8Array>;
    statFile: (path: TDocumentRef) => Promise<{
        size: number;
        modifiedAt?: number
    }>;
    readFileRange: (path: TDocumentRef, offset: number, length: number) => Promise<Uint8Array>;
    createManagedTempFileHandle?: (path: TDocumentRef) => Promise<IManagedTempFileHandle>;
    releaseManagedTempFileHandle?: (leaseId: string) => Promise<boolean>;
    getPdfOpeningGeometry?: (path: TDocumentRef) => Promise<IPdfOpeningGeometry>;
    getPdfNativePageSizes?: (path: TDocumentRef) => Promise<IPdfNativePageSize[]>;
    cancelPdfNativePagePreview?: (requestId: string) => Promise<{ canceled: boolean }>;
    renderPdfNativePagePreview?: (
        path: TDocumentRef,
        pageNumber: number,
        options?: IPdfNativePagePreviewOptions,
    ) => Promise<IPdfNativePagePreview>;
    readFileChunks: (
        path: TDocumentRef,
        options: IDocumentChunkReadOptions,
        onChunk: (chunk: Uint8Array, offset: number) => void | Promise<void>,
    ) => Promise<IDocumentChunkReadResult>;
    readTextFile: (path: TDocumentRef) => Promise<string>;
    fileExists: (path: TDocumentRef) => Promise<boolean>;
    getDocumentRevision: (path: TDocumentRef) => Promise<IDocumentRevisionInfo>;
    analyzePdfConformance: (path: TDocumentRef) => Promise<IPdfConformanceProfile>;
    validatePdfData: (data: Uint8Array, fileName?: string) => Promise<IPdfValidationResult>;
    openPdfInDefaultAppData: (data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
        unsupportedReason?: TPlatformUnsupportedReason;
    }>;
    openPdfInDefaultAppPath: (path: TDocumentRef, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
        unsupportedReason?: TPlatformUnsupportedReason;
    }>;
    printPdfData: (data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
        unsupportedReason?: TPlatformUnsupportedReason;
    }>;
    printPdfPath: (path: TDocumentRef, fileName?: string, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
        unsupportedReason?: TPlatformUnsupportedReason;
    }>;
    writeFile: (path: TDocumentRef, data: Uint8Array, options?: IDocumentMutationRevisionOptions) => Promise<boolean>;
    replaceWorkingCopyFromPath: (
        workingCopyPath: TDocumentRef,
        sourcePath: TDocumentRef,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<boolean>;
    writeDocxFile: (path: TDocumentRef, data: Uint8Array) => Promise<boolean>;
    createWorkingCopyFromData: (fileName: string, data: Uint8Array, originalPath?: TDocumentRef) => Promise<TDocumentRef>;
    createWorkingCopyFromPath: (sourcePath: TDocumentRef, originalPath?: TDocumentRef) => Promise<TDocumentRef>;
    saveFileStructured: (path: TDocumentRef, options?: IDocumentMutationRevisionOptions) => Promise<TDocumentSaveResult>;
    resyncWorkingCopy?: (path: TDocumentRef) => Promise<TDocumentSaveResult>;
    savePdfData: (
        path: TDocumentRef,
        data: Uint8Array,
        options?: IPdfSerializedSaveOptions,
        commitCallbacks?: IPdfSerializedCommitCallbacks,
    ) => Promise<IPdfValidationResult>;
    savePdfDataChunks: (
        path: TDocumentRef,
        totalBytes: number,
        chunks: TDocumentChunkSource,
        options?: IPdfSerializedSaveOptions,
        commitCallbacks?: IPdfSerializedCommitCallbacks,
    ) => Promise<IPdfValidationResult>;
    repairPdf?: (path: TDocumentRef, options?: IDocumentMutationRevisionOptions) => Promise<IPdfValidationResult>;
    optimizePdfForInteraction?: (path: TDocumentRef, options?: IDocumentMutationRevisionOptions) => Promise<IPdfValidationResult>;
    optimizePdfAsCopy?: (
        path: TDocumentRef,
        options: IPdfOptimizeOptions,
        requestId?: string,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfOptimizeResult>;
    savePdfNoteTextUpdates?: (
        path: TDocumentRef,
        updates: IPdfNoteTextUpdate[],
        modifiedAt: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNoteChanges?: (
        path: TDocumentRef,
        changes: IPdfNativeNoteChanges,
        modifiedAt: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNativeMutations?: (
        path: TDocumentRef,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeSaveResult>;
    applyPdfNativeMutationsToWorkingCopy?: (
        path: TDocumentRef,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
        expectedBase: IPdfNativeWorkingCopyExpectation,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfNativeSaveResult>;
    commitStagedPdfNativeMutations?: (
        path: TDocumentRef,
        stagedOutput: ITypedStagedArtifact,
        options?: IPdfNativeStagedCommitOptions,
    ) => Promise<IPdfNativeSaveResult>;
    savePdfDataAs: (
        workingCopyPath: TDocumentRef,
        data: Uint8Array,
        options?: IPdfSaveAsOptions,
        serializedSaveOptions?: IPdfSerializedSaveOptions,
        commitCallbacks?: IPdfSerializedCommitCallbacks,
    ) => Promise<{
        path: TDocumentRef | null;
        validation: IPdfValidationResult | null;
    }>;
    validatePdfPath: (path: TDocumentRef) => Promise<IPdfValidationResult>;
    cleanupFile: (path: TDocumentRef) => Promise<void>;
    cleanupOcrTemp: (path: TDocumentRef) => Promise<void>;
    setWindowTitle: (title: string) => Promise<void>;
    showItemInFolder: (path: TDocumentRef) => Promise<boolean>;
    showItemInFolderStructured?: (path: TDocumentRef) => Promise<TShowItemInFolderResult>;
    onDocumentRevisionChanged: (
        callback: (event: IDocumentRevisionChangedEvent) => void,
    ) => TMenuEventUnsubscribe;

    recentFiles: {
        get: () => Promise<IRecentFile[]>;
        remove: (path: TDocumentRef) => Promise<void>;
        clear: () => Promise<void>;
    };

    /**
     * Synchronous native path extraction for file inputs. Browser File ingestion
     * for open/drop flows must use registerFilesForOpen so ingestion failures
     * reach the caller before a document ref is opened.
     */
    getPathForFile: (file: File) => TDocumentRef;
    /**
     * Synchronous native path extraction for file inputs. Browser File ingestion
     * for open/drop flows must use registerFilesForOpen so ingestion failures
     * reach the caller before document refs are opened.
     */
    getPathsForFiles: (files: File[]) => TDocumentRef[];
    registerFilesForOpen: (files: File[]) => Promise<TDocumentRef[]>;
    createCombinedPdfFromFiles?: (
        files: File[],
        options?: ICreateCombinedPdfFromFilesOptions,
    ) => Promise<Uint8Array>;
}

export interface IDocumentsPickerCapability extends Pick<
    IDocumentsFileCapability,
    | 'openDocumentDialog'
    | 'openPdfDialog'
    | 'openCombineDialog'
    | 'openFolderDialog'
    | 'openFolderDialogStructured'
    | 'openImageDialog'
    | 'getPathForFile'
    | 'getPathsForFiles'
    | 'registerFilesForOpen'
    | 'createCombinedPdfFromFiles'
> {}

export interface IDocumentsOpenCapability extends Pick<
    IDocumentsFileCapability,
    | 'openDocumentDirect'
    | 'openPdfDirect'
    | 'openDocumentDirectBatch'
    | 'openPdfDirectBatch'
    | 'cancelOpenDocumentDirectBatch'
>, Pick<
        IDocumentsMenuCapability,
    | 'onOpenDocumentDirectBatchProgress'
    | 'onOpenPdfDirectBatchProgress'
    > {}

export interface IDocumentsWorkingCopyCapability extends Pick<
    IDocumentsFileCapability,
    | 'createWorkingCopyFromData'
    | 'createWorkingCopyFromPath'
    | 'cleanupFile'
    | 'cleanupOcrTemp'
> {}

export interface IDocumentsReadCapability extends Pick<
    IDocumentsFileCapability,
    | 'readFile'
    | 'statFile'
    | 'readFileRange'
    | 'createManagedTempFileHandle'
    | 'releaseManagedTempFileHandle'
    | 'getPdfOpeningGeometry'
    | 'getPdfNativePageSizes'
    | 'cancelPdfNativePagePreview'
    | 'renderPdfNativePagePreview'
    | 'readFileChunks'
    | 'readTextFile'
    | 'fileExists'
    | 'getDocumentRevision'
    | 'onDocumentRevisionChanged'
> {}

export interface IDocumentsPdfValidationCapability extends Pick<
    IDocumentsFileCapability,
    | 'analyzePdfConformance'
    | 'validatePdfData'
    | 'validatePdfPath'
> {}

export interface IDocumentsPdfExternalCapability extends Pick<
    IDocumentsFileCapability,
    | 'openPdfInDefaultAppData'
    | 'openPdfInDefaultAppPath'
    | 'printPdfData'
    | 'printPdfPath'
> {}

export interface IDocumentsPdfPersistenceCapability extends Pick<
    IDocumentsFileCapability,
    | 'savePdfAs'
    | 'savePdfDataAs'
    | 'savePdfDialog'
    | 'saveDocxAs'
    | 'writeFile'
    | 'replaceWorkingCopyFromPath'
    | 'writeDocxFile'
    | 'saveFileStructured'
    | 'resyncWorkingCopy'
    | 'savePdfData'
    | 'savePdfDataChunks'
    | 'repairPdf'
    | 'optimizePdfForInteraction'
    | 'optimizePdfAsCopy'
    | 'savePdfNoteTextUpdates'
    | 'savePdfNoteChanges'
    | 'savePdfNativeMutations'
    | 'applyPdfNativeMutationsToWorkingCopy'
    | 'commitStagedPdfNativeMutations'
> {}

export interface IDocumentsFileIoCapability extends
    IDocumentsReadCapability,
    IDocumentsPdfPersistenceCapability {}

export interface IDocumentsPdfCapability extends
    IDocumentsPdfValidationCapability,
    IDocumentsPdfExternalCapability {}

export interface IDocumentsRecentFilesCapability extends Pick<
    IDocumentsFileCapability,
    'recentFiles'
> {}

export interface IDocumentsWindowCapability extends Pick<
    IDocumentsFileCapability,
    | 'setWindowTitle'
    | 'showItemInFolder'
    | 'showItemInFolderStructured'
> {}

export interface IDocumentsCapability extends
    IDocumentsFileCapability,
    IDocumentsMenuCapability {}
