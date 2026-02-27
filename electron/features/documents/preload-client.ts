import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@contracts/electron-api';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipc-assertions';
import {
    DOCUMENTS_CHANNELS,
    DOCUMENTS_EVENT_CHANNELS,
} from '@electron/features/documents/contract';
import { IMAGE_EXPORT_CHANNELS } from '@electron/features/image-export/index';
import { PAGE_OPS_CHANNELS } from '@electron/features/page-ops/index';

const MAX_IPC_FILE_NAME_LENGTH = 255;
const MAX_IPC_WRITE_BYTES = 512 * 1024 * 1024;

function onNoArgEvent(ipcRenderer: IpcRenderer, channel: string, callback: IMenuEventCallback): IMenuEventUnsubscribe {
    const handler = (_event: IpcRendererEvent) => callback();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

function onSingleArgEvent<T>(
    ipcRenderer: IpcRenderer,
    channel: string,
    callback: (arg: T) => void,
): IMenuEventUnsubscribe {
    const handler = (_event: IpcRendererEvent, arg: T) => callback(arg);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

function assertWriteData(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength === 0) {
        throw new Error(`${fieldName} must not be empty`);
    }
    if (value.byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`${fieldName} exceeds maximum size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }
    return value;
}

function assertWorkingCopyFileName(value: unknown, fieldName: string) {
    const normalized = assertNonEmptyString(value, fieldName, MAX_IPC_FILE_NAME_LENGTH);
    if (normalized.includes('/') || normalized.includes('\\')) {
        throw new Error(`${fieldName} must be a file name, not a path`);
    }
    if (normalized === '.' || normalized === '..') {
        throw new Error(`${fieldName} is invalid`);
    }
    return normalized;
}

export function createDocumentsPreloadClient(ipcRenderer: IpcRenderer) {
    return {
        openPdfDialog: () => ipcRenderer.invoke(DOCUMENTS_CHANNELS.openPdfDialog),
        openPdfDirect: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.openPdfDirect, path),
        openPdfDirectBatch: (paths: string[], requestId?: string) =>
            ipcRenderer.invoke(DOCUMENTS_CHANNELS.openPdfDirectBatch, paths, requestId),
        savePdfAs: (workingPath: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.savePdfAs, workingPath),
        savePdfDialog: (suggestedName: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.savePdfDialog, suggestedName),
        saveDocxAs: (workingPath: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.saveDocxAs, workingPath),
        exportPdfToImages: (workingPath: string, pageNumbers?: number[]) =>
            ipcRenderer.invoke(IMAGE_EXPORT_CHANNELS.exportImages, workingPath, pageNumbers),
        exportPdfToMultiPageTiff: (workingPath: string, pageNumbers?: number[]) =>
            ipcRenderer.invoke(IMAGE_EXPORT_CHANNELS.exportMultiPageTiff, workingPath, pageNumbers),
        readFile: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.fileRead, path),
        statFile: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.fileStat, path),
        readFileRange: (path: string, offset: number, length: number) =>
            ipcRenderer.invoke(DOCUMENTS_CHANNELS.fileReadRange, path, offset, length),
        readTextFile: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.fileReadText, path),
        fileExists: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.fileExists, path),
        writeFile: (path: string, data: Uint8Array) =>
            ipcRenderer.invoke(
                DOCUMENTS_CHANNELS.fileWrite,
                assertAbsolutePath(path, 'writeFile.path'),
                assertWriteData(data, 'writeFile.data'),
            ),
        writeDocxFile: (path: string, data: Uint8Array) =>
            ipcRenderer.invoke(
                DOCUMENTS_CHANNELS.fileWriteDocx,
                assertAbsolutePath(path, 'writeDocxFile.path'),
                assertWriteData(data, 'writeDocxFile.data'),
            ),
        createWorkingCopyFromData: (fileName: string, data: Uint8Array, originalPath?: string) =>
            ipcRenderer.invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromData,
                assertWorkingCopyFileName(fileName, 'createWorkingCopyFromData.fileName'),
                assertWriteData(data, 'createWorkingCopyFromData.data'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromData.originalPath'),
            ),
        createWorkingCopyFromPath: (sourcePath: string, originalPath?: string) =>
            ipcRenderer.invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
                assertAbsolutePath(sourcePath, 'createWorkingCopyFromPath.sourcePath'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromPath.originalPath'),
            ),
        saveFile: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.fileSave, path),
        cleanupFile: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.fileCleanup, path),
        cleanupOcrTemp: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.fileCleanupOcrTemp, path),
        setWindowTitle: (title: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.windowSetTitle, title),
        showItemInFolder: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.shellShowItemInFolder, path),
        setMenuDocumentState: (hasDocument: boolean) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.menuSetDocumentState, hasDocument),
        setMenuTabCount: (tabCount: number) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.menuSetTabCount, tabCount),
        recentFiles: {
            get: () => ipcRenderer.invoke(DOCUMENTS_CHANNELS.recentFilesGet),
            add: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.recentFilesAdd, path),
            remove: (path: string) => ipcRenderer.invoke(DOCUMENTS_CHANNELS.recentFilesRemove, path),
            clear: () => ipcRenderer.invoke(DOCUMENTS_CHANNELS.recentFilesClear),
        },
        onMenuOpenPdf: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, DOCUMENTS_EVENT_CHANNELS.menuOpenPdf, callback),
        onMenuSave: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, DOCUMENTS_EVENT_CHANNELS.menuSave, callback),
        onMenuSaveAs: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, DOCUMENTS_EVENT_CHANNELS.menuSaveAs, callback),
        onMenuExportDocx: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, DOCUMENTS_EVENT_CHANNELS.menuExportDocx, callback),
        onMenuExportImages: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:exportImages', callback),
        onMenuExportMultiPageTiff: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:exportMultiPageTiff', callback),
        onMenuZoomIn: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:zoomIn', callback),
        onMenuZoomOut: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:zoomOut', callback),
        onMenuActualSize: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:actualSize', callback),
        onMenuFitWidth: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:fitWidth', callback),
        onMenuFitHeight: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:fitHeight', callback),
        onMenuViewModeSingle: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:viewModeSingle', callback),
        onMenuViewModeFacing: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:viewModeFacing', callback),
        onMenuViewModeFacingFirstSingle: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:viewModeFacingFirstSingle', callback),
        onMenuUndo: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:undo', callback),
        onMenuRedo: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:redo', callback),
        onMenuDeletePages: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:deletePages', callback),
        onMenuExtractPages: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:extractPages', callback),
        onMenuRotateCw: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:rotateCw', callback),
        onMenuRotateCcw: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:rotateCcw', callback),
        onMenuInsertPages: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, 'menu:insertPages', callback),
        onMenuOpenRecentFile: (callback: (filePath: string) => void): IMenuEventUnsubscribe =>
            onSingleArgEvent(ipcRenderer, DOCUMENTS_EVENT_CHANNELS.menuOpenRecentFile, callback),
        onMenuOpenExternalPaths: (callback: (paths: string[]) => void): IMenuEventUnsubscribe =>
            onSingleArgEvent(ipcRenderer, DOCUMENTS_EVENT_CHANNELS.menuOpenExternalPaths, callback),
        onMenuClearRecentFiles: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
            onNoArgEvent(ipcRenderer, DOCUMENTS_EVENT_CHANNELS.menuClearRecentFiles, callback),
        onOpenPdfDirectBatchProgress: (callback: (progress: {
            requestId: string;
            processed: number;
            total: number;
            percent: number;
            elapsedMs: number;
            estimatedRemainingMs: number | null;
        }) => void): IMenuEventUnsubscribe => onSingleArgEvent(
            ipcRenderer,
            DOCUMENTS_EVENT_CHANNELS.openPdfDirectBatchProgress,
            callback,
        ),
        pageOps: {
            delete: (workingCopyPath: string, pages: number[], totalPages: number) =>
                ipcRenderer.invoke(PAGE_OPS_CHANNELS.delete, workingCopyPath, pages, totalPages),
            extract: (workingCopyPath: string, pages: number[]) =>
                ipcRenderer.invoke(PAGE_OPS_CHANNELS.extract, workingCopyPath, pages),
            reorder: (workingCopyPath: string, newOrder: number[]) =>
                ipcRenderer.invoke(PAGE_OPS_CHANNELS.reorder, workingCopyPath, newOrder),
            insert: (workingCopyPath: string, totalPages: number, afterPage: number) =>
                ipcRenderer.invoke(PAGE_OPS_CHANNELS.insert, workingCopyPath, totalPages, afterPage),
            insertFile: (workingCopyPath: string, totalPages: number, afterPage: number, sourcePaths: string[]) =>
                ipcRenderer.invoke(PAGE_OPS_CHANNELS.insertFile, workingCopyPath, totalPages, afterPage, sourcePaths),
            rotate: (workingCopyPath: string, pages: number[], angle: number) =>
                ipcRenderer.invoke(PAGE_OPS_CHANNELS.rotate, workingCopyPath, pages, angle),
        },
    };
}
