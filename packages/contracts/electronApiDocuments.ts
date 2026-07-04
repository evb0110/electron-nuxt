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
import type {
    IPdfBox,
    IMarkerRect,
    IPoint2D,
} from '@contracts/geometry';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
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
import { isOneOf } from '@contracts/runtimeGuards';
import type { IRecentFile } from '@contracts/shared';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';

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

export interface ICreateCombinedPdfFromFilesOptions { onProgress?: (progress: IDocumentsBatchProgress) => void; }

export interface IOpenPdfResult {
    kind: 'pdf';
    workingPath: TDocumentRef;
    originalPath: TDocumentRef;
    isGenerated?: boolean;
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

export interface IPdfSerializedSaveOptions {expectedDocumentRevisionToken?: TDocumentRevisionToken | null;}

export interface IDocumentMutationRevisionOptions {expectedDocumentRevisionToken?: TDocumentRevisionToken | null;}

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

export interface IPdfNativePagePreviewOptions {targetWidthPx?: number;}

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

export interface IPdfNativePageLabelsMutation {
    totalPages: number;
    ranges: IPdfNativePageLabelRange[];
}

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
    bytes: Uint8Array;
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

export interface IImageExportProgress {
    requestId: string;
    format: TImageExportProgressFormat;
    phase: TImageExportProgressPhase;
    processed: number;
    total: number;
    percent: number;
}

export interface IImageExportCapability {
    exportPdfToImages: (workingCopyPath: TDocumentRef, pageNumbers?: number[], requestId?: string) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPaths?: TDocumentRef[];
    }>;
    exportPdfToMultiPageTiff: (workingCopyPath: TDocumentRef, pageNumbers?: number[], requestId?: string) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPath?: TDocumentRef;
        outputPaths?: TDocumentRef[];
    }>;
    onProgress: (callback: (progress: IImageExportProgress) => void) => TMenuEventUnsubscribe;
}

export interface IDocumentsMenuCapability {
    setMenuDocumentState: (state: boolean | {
        hasDocument: boolean;
        canPrint?: boolean;
        canSave: boolean;
        canRepairSave?: boolean;
        canOptimizePdf?: boolean;
    }) => Promise<void>;
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
    openDocumentDirectBatch: (paths: TDocumentRef[], requestId?: string) => Promise<TOpenFileResult | null>;
    openPdfDirectBatch: (paths: TDocumentRef[], requestId?: string) => Promise<TOpenFileResult | null>;
    savePdfAs: (workingCopyPath: TDocumentRef, options?: IPdfSaveAsOptions) => Promise<TDocumentRef | null>;
    savePdfDialog: (suggestedName: string) => Promise<string | null>;
    saveDocxAs: (workingCopyPath: TDocumentRef) => Promise<TDocumentRef | null>;
    readFile: (path: TDocumentRef) => Promise<Uint8Array>;
    statFile: (path: TDocumentRef) => Promise<{ size: number }>;
    readFileRange: (path: TDocumentRef, offset: number, length: number) => Promise<Uint8Array>;
    getPdfNativePageSizes?: (path: TDocumentRef) => Promise<IPdfNativePageSize[]>;
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
    saveFileStructured: (path: TDocumentRef) => Promise<TDocumentSaveResult>;
    resyncWorkingCopy?: (path: TDocumentRef) => Promise<TDocumentSaveResult>;
    savePdfData: (
        path: TDocumentRef,
        data: Uint8Array,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfValidationResult>;
    savePdfDataChunks: (
        path: TDocumentRef,
        totalBytes: number,
        chunks: TDocumentChunkSource,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfValidationResult>;
    repairPdf?: (path: TDocumentRef) => Promise<IPdfValidationResult>;
    optimizePdfForInteraction?: (path: TDocumentRef) => Promise<IPdfValidationResult>;
    optimizePdfAsCopy?: (
        path: TDocumentRef,
        options: IPdfOptimizeOptions,
        requestId?: string,
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
    savePdfDataAs: (
        workingCopyPath: TDocumentRef,
        data: Uint8Array,
        options?: IPdfSaveAsOptions,
        serializedSaveOptions?: IPdfSerializedSaveOptions,
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
    | 'getPdfNativePageSizes'
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
