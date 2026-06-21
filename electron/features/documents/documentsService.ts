import type { IpcMainInvokeEvent } from 'electron';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type {
    IPdfNativeMutationSet,
    IPdfNativeNoteChanges,
    IPdfNativeSaveResult,
    IPdfNativeNoteTextSaveResult,
    IPdfNativeWorkingCopyExpectation,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type { TOpenFileResult } from '@electron/features/documents/contract';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
} from '@electron/features/documents/serializedPdfPersistenceContract';

export interface IDocumentsService {
    openDocumentDialog: (event: IpcMainInvokeEvent) => Promise<TOpenFileResult | null>;
    openPdfDialog: (event: IpcMainInvokeEvent) => Promise<TOpenFileResult | null>;
    openCombineDialog: (event: IpcMainInvokeEvent) => Promise<TOpenFileResult | null>;
    openFolderDialog: (event: IpcMainInvokeEvent) => Promise<TOpenFileResult | null>;
    openImageDialog: (event: IpcMainInvokeEvent) => Promise<string | null>;
    openDocumentDirect: (event: IpcMainInvokeEvent, filePath: string) => Promise<TOpenFileResult | null>;
    openPdfDirect: (event: IpcMainInvokeEvent, filePath: string) => Promise<TOpenFileResult | null>;
    openDocumentDirectBatch: (event: IpcMainInvokeEvent, filePaths: string[], requestId?: string) => Promise<TOpenFileResult | null>;
    openPdfDirectBatch: (event: IpcMainInvokeEvent, filePaths: string[], requestId?: string) => Promise<TOpenFileResult | null>;
    createWorkingCopyFromData: (
        event: IpcMainInvokeEvent,
        fileName: string,
        data: Uint8Array,
        originalPath?: string,
    ) => Promise<string>;
    createWorkingCopyFromPath: (
        event: IpcMainInvokeEvent,
        sourcePath: TOpenPath,
        originalPath?: string,
    ) => Promise<string>;
    savePdfAs: (event: IpcMainInvokeEvent, workingPath: string) => Promise<string | null>;
    savePdfDataAs: (event: IpcMainInvokeEvent, workingPath: string, data: Uint8Array) => Promise<{
        path: string | null;
        validation: IPdfValidationResult | null;
    }>;
    beginSavePdfDataAs: (
        event: IpcMainInvokeEvent,
        workingPath: string,
        totalBytes: number,
    ) => Promise<IBeginSerializedPdfSaveAsResult>;
    savePdfDialog: (event: IpcMainInvokeEvent, suggestedName: string) => Promise<string | null>;
    saveDocxAs: (event: IpcMainInvokeEvent, workingPath: string) => Promise<string | null>;
    readFile: (event: IpcMainInvokeEvent, filePath: string) => Promise<Uint8Array>;
    statFile: (event: IpcMainInvokeEvent, filePath: string) => Promise<{ size: number }>;
    readFileRange: (event: IpcMainInvokeEvent, filePath: string, offset: number, length: number) => Promise<Uint8Array>;
    readTextFile: (event: IpcMainInvokeEvent, filePath: string) => Promise<string>;
    fileExists: (event: IpcMainInvokeEvent, filePath: string) => boolean;
    analyzePdfConformance: (event: IpcMainInvokeEvent, filePath: string) => Promise<IPdfConformanceProfile>;
    validatePdfData: (event: IpcMainInvokeEvent, data: Uint8Array, fileName?: string) => Promise<IPdfValidationResult>;
    validatePdfPath: (event: IpcMainInvokeEvent, filePath: string) => Promise<IPdfValidationResult>;
    openPdfInDefaultAppData: (event: IpcMainInvokeEvent, data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    openPdfInDefaultAppPath: (event: IpcMainInvokeEvent, filePath: string, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    printPdfData: (event: IpcMainInvokeEvent, data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
    }>;
    printPdfPath: (event: IpcMainInvokeEvent, filePath: string, fileName?: string, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
    }>;
    writeFile: (event: IpcMainInvokeEvent, filePath: string, data: Uint8Array) => Promise<boolean>;
    replaceWorkingCopyFromPath: (
        event: IpcMainInvokeEvent,
        workingCopyPath: string,
        sourcePath: string,
    ) => Promise<boolean>;
    writeDocxFile: (event: IpcMainInvokeEvent, filePath: string, data: Uint8Array) => Promise<boolean>;
    saveFile: (event: IpcMainInvokeEvent, workingPath: string) => Promise<boolean>;
    repairPdf: (event: IpcMainInvokeEvent, workingPath: string) => Promise<IPdfValidationResult>;
    savePdfData: (event: IpcMainInvokeEvent, workingPath: string, data: Uint8Array) => Promise<IPdfValidationResult>;
    savePdfNoteTextUpdates: (
        event: IpcMainInvokeEvent,
        workingPath: string,
        updates: IPdfNoteTextUpdate[],
        modifiedAt: string,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNoteChanges: (
        event: IpcMainInvokeEvent,
        workingPath: string,
        changes: IPdfNativeNoteChanges,
        modifiedAt: string,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNativeMutations: (
        event: IpcMainInvokeEvent,
        workingPath: string,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
    ) => Promise<IPdfNativeSaveResult>;
    applyPdfNativeMutationsToWorkingCopy: (
        event: IpcMainInvokeEvent,
        workingPath: string,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
        expectedBase: IPdfNativeWorkingCopyExpectation,
    ) => Promise<IPdfNativeSaveResult>;
    beginSavePdfData: (
        event: IpcMainInvokeEvent,
        workingPath: string,
        totalBytes: number,
    ) => Promise<IBeginSerializedPdfPersistenceResult>;
    cleanupFile: (_event: IpcMainInvokeEvent, workingPath: string) => void;
    cleanupOcrTemp: (event: IpcMainInvokeEvent, filePath: string) => Promise<void>;
    setWindowTitle: (event: IpcMainInvokeEvent, title: string) => void;
    showItemInFolder: (event: IpcMainInvokeEvent, filePath: string) => Promise<boolean>;
    setMenuDocumentState: (
        event: IpcMainInvokeEvent,
        state: boolean | {
            hasDocument: boolean;
            canSave: boolean;
            canRepairSave?: boolean;
        },
    ) => void;
    setMenuTabCount: (event: IpcMainInvokeEvent, tabCount: number) => void;
    getRecentFiles: (event: IpcMainInvokeEvent) => Promise<IRecentFile[]>;
    removeRecentFile: (_event: IpcMainInvokeEvent, originalPath: string) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
}
