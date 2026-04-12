import type { IpcMainInvokeEvent } from 'electron';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/electron-api';
import type { IRecentFile } from '@contracts/shared';
import type { TOpenFileResult } from '@electron/features/documents/contract';

export interface IDocumentsService {
    openPdfDialog: () => Promise<TOpenFileResult | null>;
    openCombineDialog: () => Promise<TOpenFileResult | null>;
    openImageDialog: () => Promise<string | null>;
    openPdfDirect: (event: IpcMainInvokeEvent, filePath: string) => Promise<TOpenFileResult | null>;
    openPdfDirectBatch: (event: IpcMainInvokeEvent, filePaths: string[], requestId?: string) => Promise<TOpenFileResult | null>;
    createWorkingCopyFromData: (
        event: IpcMainInvokeEvent,
        fileName: string,
        data: Uint8Array,
        originalPath?: string,
    ) => Promise<string>;
    createWorkingCopyFromPath: (
        event: IpcMainInvokeEvent,
        sourcePath: string,
        originalPath?: string,
    ) => Promise<string>;
    savePdfAs: (event: IpcMainInvokeEvent, workingPath: string) => Promise<string | null>;
    savePdfDialog: (event: IpcMainInvokeEvent, suggestedName: string) => Promise<string | null>;
    saveDocxAs: (event: IpcMainInvokeEvent, workingPath: string) => Promise<string | null>;
    readFile: (event: IpcMainInvokeEvent, filePath: string) => Promise<Uint8Array>;
    statFile: (event: IpcMainInvokeEvent, filePath: string) => Promise<{ size: number }>;
    readFileRange: (event: IpcMainInvokeEvent, filePath: string, offset: number, length: number) => Promise<Uint8Array>;
    readTextFile: (event: IpcMainInvokeEvent, filePath: string) => Promise<string>;
    fileExists: (event: IpcMainInvokeEvent, filePath: string) => boolean;
    analyzePdfConformance: (event: IpcMainInvokeEvent, filePath: string) => Promise<IPdfConformanceProfile>;
    validatePdfData: (event: IpcMainInvokeEvent, data: Uint8Array, fileName?: string) => Promise<IPdfValidationResult>;
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
    printPdfPath: (event: IpcMainInvokeEvent, filePath: string, fileName?: string) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
    }>;
    writeFile: (event: IpcMainInvokeEvent, filePath: string, data: Uint8Array) => Promise<boolean>;
    writeDocxFile: (event: IpcMainInvokeEvent, filePath: string, data: Uint8Array) => Promise<boolean>;
    saveFile: (event: IpcMainInvokeEvent, workingPath: string) => Promise<boolean>;
    cleanupFile: (_event: IpcMainInvokeEvent, workingPath: string) => void;
    cleanupOcrTemp: (event: IpcMainInvokeEvent, filePath: string) => Promise<void>;
    setWindowTitle: (event: IpcMainInvokeEvent, title: string) => void;
    showItemInFolder: (event: IpcMainInvokeEvent, filePath: string) => boolean;
    setMenuDocumentState: (event: IpcMainInvokeEvent, hasDocument: boolean) => void;
    setMenuTabCount: (event: IpcMainInvokeEvent, tabCount: number) => void;
    getRecentFiles: () => Promise<IRecentFile[]>;
    addRecentFile: (_event: IpcMainInvokeEvent, originalPath: string) => Promise<void>;
    removeRecentFile: (_event: IpcMainInvokeEvent, originalPath: string) => Promise<void>;
    clearRecentFiles: () => Promise<void>;
}
