import type {
    BrowserWindow,
    WebContents,
} from 'electron';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type {
    IDocumentMutationRevisionOptions,
    IPdfNativeMutationSet,
    IPdfNativeNoteChanges,
    IPdfNativeSaveResult,
    IPdfNativeNoteTextSaveResult,
    IPdfNativeWorkingCopyExpectation,
    IPdfNativePagePreview,
    IPdfNativePagePreviewOptions,
    IPdfNativePageSize,
    IPdfNoteTextUpdate,
    IPdfOptimizeOptions,
    IPdfOptimizeResult,
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type { TOpenFileResult } from '@electron/features/documents/contract';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import type { TOpenPathOwner } from '@electron/features/documents/main/openPathOwner';

export interface IDocumentsWebContentsContext {
    sender: WebContents;
    senderId: number;
}

export interface IDocumentsDialogContext extends IDocumentsWebContentsContext { parentWindow: BrowserWindow | null; }

export interface IDocumentsSenderIdContext {
    sender?: WebContents;
    senderId?: number;
}

export interface IDocumentsWindowContext {
    senderId?: number;
    window: BrowserWindow | null;
}

export interface IDocumentsOpenPathContext { owner?: TOpenPathOwner; }

export interface IDocumentsService {
    openDocumentDialog: (context: IDocumentsDialogContext) => Promise<TOpenFileResult | null>;
    openPdfDialog: (context: IDocumentsDialogContext) => Promise<TOpenFileResult | null>;
    openCombineDialog: (context: IDocumentsDialogContext) => Promise<TOpenFileResult | null>;
    openFolderDialog: (context: IDocumentsDialogContext) => Promise<TOpenFileResult | null>;
    openImageDialog: (context: IDocumentsDialogContext) => Promise<string | null>;
    openDocumentDirect: (context: IDocumentsWebContentsContext, filePath: string) => Promise<TOpenFileResult | null>;
    openPdfDirect: (context: IDocumentsWebContentsContext, filePath: string) => Promise<TOpenFileResult | null>;
    openDocumentDirectBatch: (context: IDocumentsWebContentsContext, filePaths: string[], requestId?: string) => Promise<TOpenFileResult | null>;
    openPdfDirectBatch: (context: IDocumentsWebContentsContext, filePaths: string[], requestId?: string) => Promise<TOpenFileResult | null>;
    createWorkingCopyFromData: (
        context: IDocumentsSenderIdContext,
        fileName: string,
        data: Uint8Array,
        originalPath?: string,
    ) => Promise<string>;
    createWorkingCopyFromPath: (
        context: IDocumentsSenderIdContext,
        sourcePath: TOpenPath,
        originalPath?: string,
    ) => Promise<string>;
    savePdfAs: (
        context: IDocumentsDialogContext,
        workingPath: string,
        options: IPdfSaveAsOptions | undefined,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<string | null>;
    savePdfDataAs: (
        context: IDocumentsDialogContext,
        workingPath: string,
        data: Uint8Array,
        options?: IPdfSaveAsOptions,
        serializedSaveOptions?: IPdfSerializedSaveOptions,
    ) => Promise<{
        path: string | null;
        validation: IPdfValidationResult | null;
    }>;
    beginSavePdfDataAs: (
        context: IDocumentsDialogContext,
        workingPath: string,
        totalBytes: number,
        options?: IPdfSaveAsOptions,
        serializedSaveOptions?: IPdfSerializedSaveOptions,
    ) => Promise<IBeginSerializedPdfSaveAsResult>;
    savePdfDialog: (context: IDocumentsDialogContext, suggestedName: string) => Promise<string | null>;
    saveDocxAs: (context: IDocumentsDialogContext, workingPath: string) => Promise<string | null>;
    readFile: (context: IDocumentsSenderIdContext, filePath: string) => Promise<Uint8Array>;
    statFile: (context: IDocumentsSenderIdContext, filePath: string) => Promise<{ size: number }>;
    readFileRange: (context: IDocumentsSenderIdContext, filePath: string, offset: number, length: number) => Promise<Uint8Array>;
    getPdfNativePageSizes: (
        context: IDocumentsSenderIdContext,
        filePath: string,
    ) => Promise<IPdfNativePageSize[]>;
    cancelPdfNativePagePreview: (
        context: IDocumentsSenderIdContext,
        requestId: string,
    ) => Promise<{ canceled: boolean }>;
    renderPdfNativePagePreview: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        pageNumber: number,
        options?: IPdfNativePagePreviewOptions,
    ) => Promise<IPdfNativePagePreview>;
    readTextFile: (context: IDocumentsSenderIdContext, filePath: string) => Promise<string>;
    fileExists: (context: IDocumentsSenderIdContext, filePath: string) => boolean;
    getDocumentRevision: (context: IDocumentsSenderIdContext, filePath: string) => Promise<IDocumentRevisionInfo>;
    analyzePdfConformance: (context: IDocumentsSenderIdContext, filePath: string) => Promise<IPdfConformanceProfile>;
    validatePdfData: (data: Uint8Array, fileName?: string) => Promise<IPdfValidationResult>;
    validatePdfPath: (context: IDocumentsSenderIdContext, filePath: string) => Promise<IPdfValidationResult>;
    openPdfInDefaultAppData: (data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    openPdfInDefaultAppPath: (context: IDocumentsSenderIdContext, filePath: string, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    printPdfData: (context: IDocumentsWindowContext, data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
    }>;
    printPdfPath: (context: IDocumentsWindowContext, filePath: string, fileName?: string, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
    }>;
    writeFile: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        data: Uint8Array,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<boolean>;
    resyncWorkingCopy: (context: IDocumentsSenderIdContext, workingPath: string) => Promise<TDocumentSaveResult>;
    replaceWorkingCopyFromPath: (
        context: IDocumentsSenderIdContext,
        workingCopyPath: string,
        sourcePath: string,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<boolean>;
    writeDocxFile: (context: IDocumentsSenderIdContext, filePath: string, data: Uint8Array) => Promise<boolean>;
    saveFileStructured: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<TDocumentSaveResult>;
    repairPdf: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfValidationResult>;
    optimizePdfForInteraction: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfValidationResult>;
    optimizePdfAsCopy: (
        context: IDocumentsDialogContext,
        workingPath: string,
        options: IPdfOptimizeOptions,
        requestId?: string,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfOptimizeResult>;
    savePdfData: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        data: Uint8Array,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfValidationResult>;
    savePdfNoteTextUpdates: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        updates: IPdfNoteTextUpdate[],
        modifiedAt: string,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNoteChanges: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        changes: IPdfNativeNoteChanges,
        modifiedAt: string,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNativeMutations: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfNativeSaveResult>;
    applyPdfNativeMutationsToWorkingCopy: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
        expectedBase: IPdfNativeWorkingCopyExpectation,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfNativeSaveResult>;
    beginSavePdfData: (
        context: IDocumentsWebContentsContext,
        workingPath: string,
        totalBytes: number,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IBeginSerializedPdfPersistenceResult>;
    cleanupFile: (context: IDocumentsSenderIdContext, workingPath: string) => void;
    cleanupOcrTemp: (context: IDocumentsSenderIdContext, filePath: string) => Promise<void>;
    setWindowTitle: (context: IDocumentsWindowContext, title: string) => void;
    showItemInFolder: (context: IDocumentsOpenPathContext, filePath: string) => Promise<boolean>;
    setMenuDocumentState: (
        context: IDocumentsWindowContext,
        state: boolean | {
            hasDocument: boolean;
            canPrint?: boolean;
            canSave: boolean;
            canRepairSave?: boolean;
        },
    ) => void;
    setMenuTabCount: (context: IDocumentsWindowContext, tabCount: number) => void;
    getRecentFiles: (context: IDocumentsWebContentsContext) => Promise<IRecentFile[]>;
    removeRecentFile: (originalPath: string) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
}
