import type { TDocumentRef } from '@contracts/document';
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

export interface IImageExportCapability {
    exportPdfToImages: (workingCopyPath: TDocumentRef, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPaths?: TDocumentRef[];
    }>;
    exportPdfToMultiPageTiff: (workingCopyPath: TDocumentRef, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPath?: TDocumentRef;
    }>;
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
    onOpenPdfDirectBatchProgress: (callback: (progress: IOpenPdfDirectBatchProgress) => void) => IMenuEventUnsubscribe;
}

export interface IDocumentsFileCapability {
    openPdfDialog: () => Promise<TOpenFileResult | null>;
    openCombineDialog: () => Promise<TOpenFileResult | null>;
    openFolderDialog: () => Promise<TOpenFileResult | null>;
    openImageDialog: () => Promise<string | null>;
    openPdfDirect: (path: TDocumentRef) => Promise<TOpenFileResult | null>;
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
