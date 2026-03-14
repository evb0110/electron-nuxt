import type { IpcMainInvokeEvent } from 'electron';
import type { IIpcMainRegistrar } from '@contracts/ipc-main';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import {createDocumentsService} from '@electron/features/documents/service';
import type { IDocumentsService } from '@electron/features/documents/ports';

export function registerDocumentsIpcAdapter(
    registrar: IIpcMainRegistrar,
    service: IDocumentsService = createDocumentsService(),
) {
    registrar.handle(DOCUMENTS_CHANNELS.openPdfDialog, () => service.openPdfDialog());
    registrar.handle(DOCUMENTS_CHANNELS.openImageDialog, () => service.openImageDialog());
    registrar.handle(DOCUMENTS_CHANNELS.openPdfDirect, (event: IpcMainInvokeEvent, filePath: string) =>
        service.openPdfDirect(event, filePath),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.openPdfDirectBatch,
        (event: IpcMainInvokeEvent, filePaths: string[], requestId?: string) =>
            service.openPdfDirectBatch(event, filePaths, requestId),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.createWorkingCopyFromData,
        (event: IpcMainInvokeEvent, fileName: string, data: Uint8Array, originalPath?: string) =>
            service.createWorkingCopyFromData(event, fileName, data, originalPath),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
        (event: IpcMainInvokeEvent, sourcePath: string, originalPath?: string) =>
            service.createWorkingCopyFromPath(event, sourcePath, originalPath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.savePdfAs, (event: IpcMainInvokeEvent, workingPath: string) =>
        service.savePdfAs(event, workingPath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.savePdfDialog, (event: IpcMainInvokeEvent, suggestedName: string) =>
        service.savePdfDialog(event, suggestedName),
    );
    registrar.handle(DOCUMENTS_CHANNELS.saveDocxAs, (event: IpcMainInvokeEvent, workingPath: string) =>
        service.saveDocxAs(event, workingPath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.fileRead, (event: IpcMainInvokeEvent, filePath: string) =>
        service.readFile(event, filePath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.fileStat, (event: IpcMainInvokeEvent, filePath: string) =>
        service.statFile(event, filePath),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.fileReadRange,
        (event: IpcMainInvokeEvent, filePath: string, offset: number, length: number) =>
            service.readFileRange(event, filePath, offset, length),
    );
    registrar.handle(DOCUMENTS_CHANNELS.fileReadText, (event: IpcMainInvokeEvent, filePath: string) =>
        service.readTextFile(event, filePath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.fileExists, (event: IpcMainInvokeEvent, filePath: string) =>
        service.fileExists(event, filePath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.fileWrite, (event: IpcMainInvokeEvent, filePath: string, data: Uint8Array) =>
        service.writeFile(event, filePath, data),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.fileWriteDocx,
        (event: IpcMainInvokeEvent, filePath: string, data: Uint8Array) =>
            service.writeDocxFile(event, filePath, data),
    );
    registrar.handle(DOCUMENTS_CHANNELS.fileSave, (event: IpcMainInvokeEvent, workingPath: string) =>
        service.saveFile(event, workingPath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.fileCleanup, (event: IpcMainInvokeEvent, workingPath: string) => {
        service.cleanupFile(event, workingPath);
        return;
    });
    registrar.handle(DOCUMENTS_CHANNELS.fileCleanupOcrTemp, (event: IpcMainInvokeEvent, filePath: string) =>
        service.cleanupOcrTemp(event, filePath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.windowSetTitle, (event: IpcMainInvokeEvent, title: string) =>
        service.setWindowTitle(event, title),
    );
    registrar.handle(DOCUMENTS_CHANNELS.shellShowItemInFolder, (event: IpcMainInvokeEvent, filePath: string) =>
        service.showItemInFolder(event, filePath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.menuSetDocumentState, (event: IpcMainInvokeEvent, hasDocument: boolean) =>
        service.setMenuDocumentState(event, hasDocument),
    );
    registrar.handle(DOCUMENTS_CHANNELS.menuSetTabCount, (event: IpcMainInvokeEvent, tabCount: number) =>
        service.setMenuTabCount(event, tabCount),
    );
    registrar.handle(DOCUMENTS_CHANNELS.recentFilesGet, () => service.getRecentFiles());
    registrar.handle(DOCUMENTS_CHANNELS.recentFilesAdd, (event: IpcMainInvokeEvent, originalPath: string) =>
        service.addRecentFile(event, originalPath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.recentFilesRemove, (event: IpcMainInvokeEvent, originalPath: string) =>
        service.removeRecentFile(event, originalPath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.recentFilesClear, () => service.clearRecentFiles());
}
