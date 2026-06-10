import type { TDocumentRef } from '@contracts/documentRef';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type { IRecentFile } from '@contracts/shared';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';

export interface IOpenPdfDirectBatchProgress {
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

export interface IPdfNoteTextUpdate {
    objectNumber: number;
    generationNumber: number;
    text: string;
}

export interface IPdfNativeFreeTextNoteMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface IPdfNativeFreeTextNote {
    pageIndex: number;
    stableKey: string;
    text: string;
    markerRect: IPdfNativeFreeTextNoteMarkerRect;
    author?: string | null;
    color?: string | null;
    createdAt?: number | null;
}

export interface IPdfNativeAnnotationDelete {
    pageIndex: number;
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

export type TPdfNativePageLabelStyle = 'D' | 'R' | 'r' | 'A' | 'a' | null;

export interface IPdfNativePageLabelRange {
    startPage: number;
    style: TPdfNativePageLabelStyle;
    prefix: string;
    startNumber: number;
}

export interface IPdfNativePageLabelsMutation {
    totalPages: number;
    ranges: IPdfNativePageLabelRange[];
}

export interface IPdfNativeBookmarksMutation {
    totalPages: number;
    untitledLabel: string;
    items: IPdfBookmarkEntry[];
}

export type TPdfNativeShapeType = 'rectangle' | 'circle' | 'line' | 'arrow' | 'polyline' | 'polygon';
export type TPdfNativeShapePdfSubtype = 'Square' | 'Circle' | 'Line' | 'PolyLine' | 'Polygon' | 'Ink';
export type TPdfNativeShapeLineEndStyle = 'none' | 'openArrow' | 'closedArrow';

export interface IPdfNativeShapePoint {
    x: number;
    y: number;
}

export interface IPdfNativeShapeAnnotation {
    id?: string;
    type: TPdfNativeShapeType;
    pageIndex: number;
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

export type TPdfNativeMarkupSubtype = 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly';

export interface IPdfNativeMarkupMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface IPdfNativeMarkupSubtypeHint {
    subtype: TPdfNativeMarkupSubtype;
    pageIndex: number;
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

export interface IPdfNativePlacedImage {
    pageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
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
    onProgress: (callback: (progress: IImageExportProgress) => void) => IMenuEventUnsubscribe;
}

export interface IDocumentsMenuCapability {
    setMenuDocumentState: (state: boolean | {
        hasDocument: boolean;
        canSave: boolean;
        canRepairSave?: boolean;
    }) => Promise<void>;
    setMenuTabCount: (tabCount: number) => Promise<void>;
    onMenuOpenPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuInsertImageFromFile: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuPasteImageFromClipboard: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSave: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRepairSave: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSaveAs: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuPrint: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuPrintCurrentPage: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportDocx: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportImages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportMultiPageTiff: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomIn: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomOut: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuActualSize: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitWidth: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitHeight: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuViewModeSingle: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuViewModeFacing: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuViewModeFacingFirstSingle: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuToggleAssistant: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuUndo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRedo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuDeletePages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExtractPages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRotateCw: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRotateCcw: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuInsertPages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuOpenRecentFile: (callback: (path: TDocumentRef) => void) => IMenuEventUnsubscribe;
    onMenuOpenExternalPaths: (callback: (paths: TDocumentRef[]) => void) => IMenuEventUnsubscribe;
    onMenuClearRecentFiles: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onOpenDocumentDirectBatchProgress: (callback: (progress: TOpenDocumentDirectBatchProgress) => void) => IMenuEventUnsubscribe;
    onOpenPdfDirectBatchProgress: (callback: (progress: IOpenPdfDirectBatchProgress) => void) => IMenuEventUnsubscribe;
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
    savePdfAs: (workingCopyPath: TDocumentRef) => Promise<TDocumentRef | null>;
    savePdfDialog: (suggestedName: string) => Promise<string | null>;
    saveDocxAs: (workingCopyPath: TDocumentRef) => Promise<TDocumentRef | null>;
    readFile: (path: TDocumentRef) => Promise<Uint8Array>;
    statFile: (path: TDocumentRef) => Promise<{ size: number }>;
    readFileRange: (path: TDocumentRef, offset: number, length: number) => Promise<Uint8Array>;
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
    savePdfDataAs: (workingCopyPath: TDocumentRef, data: Uint8Array) => Promise<{
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
}

export interface IDocumentsCapability extends
    IDocumentsFileCapability,
    IDocumentsMenuCapability {}
