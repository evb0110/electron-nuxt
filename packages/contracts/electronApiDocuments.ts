import type { TDocumentRef } from '@contracts/documentRef';
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

export interface IPdfSaveAsOptions { optimizeLossless?: boolean; }

export interface IPdfNoteTextUpdate {
    objectNumber: number;
    generationNumber: number;
    text: string;
}

export interface IPdfNativeFreeTextNoteMarkerRect extends IMarkerRect {}

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

export interface IPdfNativePageLabelRange extends IPdfPageLabelRange {}

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

export interface IPdfNativeShapePoint extends IPoint2D {}

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

export interface IPdfNativeMarkupMarkerRect extends IMarkerRect {}

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

export interface IPdfNativeSaveResult extends IPdfNativeNoteTextSaveResult {}

export interface IPdfNativeWorkingCopyExpectation {
    byteLength: number;
    sha256: string;
}

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
        canSave: boolean;
        canRepairSave?: boolean;
    }) => Promise<void>;
    setMenuTabCount: (tabCount: number) => Promise<void>;
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
    readFileChunks: (
        path: TDocumentRef,
        options: IDocumentChunkReadOptions,
        onChunk: (chunk: Uint8Array, offset: number) => void | Promise<void>,
    ) => Promise<IDocumentChunkReadResult>;
    readTextFile: (path: TDocumentRef) => Promise<string>;
    fileExists: (path: TDocumentRef) => Promise<boolean>;
    analyzePdfConformance: (path: TDocumentRef) => Promise<IPdfConformanceProfile>;
    validatePdfData: (data: Uint8Array, fileName?: string) => Promise<IPdfValidationResult>;
    openPdfInDefaultAppData: (data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    openPdfInDefaultAppPath: (path: TDocumentRef, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    printPdfData: (data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
    }>;
    printPdfPath: (path: TDocumentRef, fileName?: string, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
    }>;
    writeFile: (path: TDocumentRef, data: Uint8Array) => Promise<boolean>;
    replaceWorkingCopyFromPath: (workingCopyPath: TDocumentRef, sourcePath: TDocumentRef) => Promise<boolean>;
    writeDocxFile: (path: TDocumentRef, data: Uint8Array) => Promise<boolean>;
    createWorkingCopyFromData: (fileName: string, data: Uint8Array, originalPath?: TDocumentRef) => Promise<TDocumentRef>;
    createWorkingCopyFromPath: (sourcePath: TDocumentRef, originalPath?: TDocumentRef) => Promise<TDocumentRef>;
    saveFile: (path: TDocumentRef) => Promise<boolean>;
    savePdfData: (path: TDocumentRef, data: Uint8Array) => Promise<IPdfValidationResult>;
    savePdfDataChunks: (
        path: TDocumentRef,
        totalBytes: number,
        chunks: TDocumentChunkSource,
    ) => Promise<IPdfValidationResult>;
    repairPdf?: (path: TDocumentRef) => Promise<IPdfValidationResult>;
    optimizePdfForInteraction?: (path: TDocumentRef) => Promise<IPdfValidationResult>;
    savePdfNoteTextUpdates?: (
        path: TDocumentRef,
        updates: IPdfNoteTextUpdate[],
        modifiedAt: string,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNoteChanges?: (
        path: TDocumentRef,
        changes: IPdfNativeNoteChanges,
        modifiedAt: string,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNativeMutations?: (
        path: TDocumentRef,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
    ) => Promise<IPdfNativeSaveResult>;
    applyPdfNativeMutationsToWorkingCopy?: (
        path: TDocumentRef,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
        expectedBase: IPdfNativeWorkingCopyExpectation,
    ) => Promise<IPdfNativeSaveResult>;
    savePdfDataAs: (workingCopyPath: TDocumentRef, data: Uint8Array, options?: IPdfSaveAsOptions) => Promise<{
        path: TDocumentRef | null;
        validation: IPdfValidationResult | null;
    }>;
    validatePdfPath: (path: TDocumentRef) => Promise<IPdfValidationResult>;
    cleanupFile: (path: TDocumentRef) => Promise<void>;
    cleanupOcrTemp: (path: TDocumentRef) => Promise<void>;
    setWindowTitle: (title: string) => Promise<void>;
    showItemInFolder: (path: TDocumentRef) => Promise<boolean>;

    recentFiles: {
        get: () => Promise<IRecentFile[]>;
        remove: (path: TDocumentRef) => Promise<void>;
        clear: () => Promise<void>;
    };

    getPathForFile: (file: File) => TDocumentRef;
    getPathsForFiles: (files: File[]) => TDocumentRef[];
}

export interface IDocumentsCapability extends
    IDocumentsFileCapability,
    IDocumentsMenuCapability {}
