import type { IpcMainInvokeEvent } from 'electron';
import type { IRecentFile } from '@contracts/shared';
import type { TOpenFileResult } from '@electron/features/documents/contract';

interface IDocumentsMenuPort {
    setDocumentState: (windowId: number, hasDocument: boolean) => void;
    setTabCount: (windowId: number, tabCount: number) => void;
    updateRecentFilesMenu: () => void;
}

interface IDocumentsRecentFilesPort {
    get: () => Promise<IRecentFile[]>;
    add: (path: string) => Promise<void>;
    remove: (path: string) => Promise<void>;
    clear: () => Promise<void>;
}

interface IDocumentsDialogsPort {
    openPdfDialog: () => Promise<TOpenFileResult | null>;
    openPdfDirect: (event: IpcMainInvokeEvent, filePath: string) => Promise<TOpenFileResult | null>;
    openPdfDirectBatch: (
        event: IpcMainInvokeEvent,
        filePaths: string[],
        requestId?: string,
    ) => Promise<TOpenFileResult | null>;
    createWorkingCopyFromData: (
        event: IpcMainInvokeEvent,
        fileName: string,
        data: Uint8Array,
        originalPath?: string,
    ) => Promise<string>;
    savePdfAs: (event: IpcMainInvokeEvent, workingPath: string) => Promise<string | null>;
    savePdfDialog: (event: IpcMainInvokeEvent, suggestedName: string) => Promise<string | null>;
    saveDocxAs: (event: IpcMainInvokeEvent, workingPath: string) => Promise<string | null>;
    setWindowTitle: (event: IpcMainInvokeEvent, title: string) => void;
    showItemInFolder: (event: IpcMainInvokeEvent, filePath: string) => boolean;
}

interface IDocumentsFileOpsPort {
    read: (event: IpcMainInvokeEvent, filePath: string) => Promise<Uint8Array>;
    stat: (event: IpcMainInvokeEvent, filePath: string) => Promise<{ size: number }>;
    readRange: (event: IpcMainInvokeEvent, filePath: string, offset: number, length: number) => Promise<Uint8Array>;
    readText: (event: IpcMainInvokeEvent, filePath: string) => Promise<string>;
    exists: (event: IpcMainInvokeEvent, filePath: string) => boolean;
    write: (event: IpcMainInvokeEvent, filePath: string, data: Uint8Array) => Promise<boolean>;
    writeDocx: (event: IpcMainInvokeEvent, filePath: string, data: Uint8Array) => Promise<boolean>;
    cleanupOcrTemp: (event: IpcMainInvokeEvent, filePath: string) => Promise<void>;
}

interface IDocumentsWorkingCopyPort {
    save: (event: IpcMainInvokeEvent, workingPath: string) => Promise<boolean>;
    cleanup: (workingPath: string) => void;
}

export interface IDocumentsService {
    openPdfDialog: () => Promise<TOpenFileResult | null>;
    openPdfDirect: (event: IpcMainInvokeEvent, filePath: string) => Promise<TOpenFileResult | null>;
    openPdfDirectBatch: (event: IpcMainInvokeEvent, filePaths: string[], requestId?: string) => Promise<TOpenFileResult | null>;
    createWorkingCopyFromData: (
        event: IpcMainInvokeEvent,
        fileName: string,
        data: Uint8Array,
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
