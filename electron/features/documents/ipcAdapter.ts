import type { IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import type { IIpcMainRegistrar } from '@contracts/ipcMain';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import {createDocumentsService} from '@electron/features/documents/service';
import type { IDocumentsService } from '@electron/features/documents/ports';
import {
    allowOpenPath,
    requireOpenPath,
    type TOpenPath,
} from '@electron/ipc/openPathCapabilities';
import { isSupportedOpenPath } from '@electron/image/pdfConversion';
import { requireManagedWorkingCopyPath } from '@electron/ipc/workingCopyCreation';

interface IRendererFileOpenToken {expiresAtMs: number;}

const RENDERER_FILE_OPEN_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER = 16;
const rendererFileOpenTokens = new Map<number, Map<string, IRendererFileOpenToken>>();
const rendererFileOpenTokenCleanupSenders = new Set<number>();

function getSenderId(event: IpcMainInvokeEvent) {
    return event.sender.id;
}

function pruneRendererFileOpenTokens(senderId: number, now = Date.now()) {
    const tokens = rendererFileOpenTokens.get(senderId);
    if (!tokens) {
        return;
    }

    for (const [
        token,
        grant,
    ] of tokens.entries()) {
        if (grant.expiresAtMs <= now) {
            tokens.delete(token);
        }
    }

    while (tokens.size > MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER) {
        const oldestToken = tokens.keys().next().value;
        if (!oldestToken) {
            break;
        }
        tokens.delete(oldestToken);
    }

    if (tokens.size === 0) {
        rendererFileOpenTokens.delete(senderId);
    }
}

function registerRendererFileOpenTokenCleanup(event: IpcMainInvokeEvent, senderId: number) {
    if (rendererFileOpenTokenCleanupSenders.has(senderId)) {
        return;
    }

    rendererFileOpenTokenCleanupSenders.add(senderId);
    event.sender.once('destroyed', () => {
        rendererFileOpenTokens.delete(senderId);
        rendererFileOpenTokenCleanupSenders.delete(senderId);
    });
}

function consumeRendererFileOpenToken(senderId: number, token: string) {
    pruneRendererFileOpenTokens(senderId);
    const tokens = rendererFileOpenTokens.get(senderId);
    const grant = tokens?.get(token);
    if (!tokens || !grant || grant.expiresAtMs <= Date.now()) {
        tokens?.delete(token);
        return false;
    }

    tokens.delete(token);
    if (tokens.size === 0) {
        rendererFileOpenTokens.delete(senderId);
    }
    return true;
}

async function requireWorkingCopySourcePath(event: IpcMainInvokeEvent, sourcePath: string): Promise<TOpenPath> {
    try {
        return requireOpenPath(sourcePath, getSenderId(event));
    } catch {
        return requireManagedWorkingCopyPath(sourcePath, getSenderId(event));
    }
}

export function registerDocumentsIpcAdapter(
    registrar: IIpcMainRegistrar,
    service: IDocumentsService = createDocumentsService(),
) {
    registrar.handle(DOCUMENTS_CHANNELS.openPdfDialog, (event: IpcMainInvokeEvent) => service.openPdfDialog(event));
    registrar.handle(DOCUMENTS_CHANNELS.openCombineDialog, (event: IpcMainInvokeEvent) => service.openCombineDialog(event));
    registrar.handle(DOCUMENTS_CHANNELS.openFolderDialog, (event: IpcMainInvokeEvent) => service.openFolderDialog(event));
    registrar.handle(DOCUMENTS_CHANNELS.openImageDialog, (event: IpcMainInvokeEvent) => service.openImageDialog(event));
    registrar.handle(DOCUMENTS_CHANNELS.openPdfDirect, (event: IpcMainInvokeEvent, filePath: string) =>
        service.openPdfDirect(event, filePath),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.openPdfDirectBatch,
        (event: IpcMainInvokeEvent, filePaths: string[], requestId?: string) =>
            service.openPdfDirectBatch(event, filePaths, requestId),
    );
    registrar.handle(DOCUMENTS_CHANNELS.registerRendererFileOpenToken, (event: IpcMainInvokeEvent, token: string) => {
        const normalizedToken = typeof token === 'string' ? token.trim() : '';
        if (!normalizedToken) {
            return false;
        }

        const senderId = getSenderId(event);
        const tokens = rendererFileOpenTokens.get(senderId) ?? new Map<string, IRendererFileOpenToken>();
        tokens.delete(normalizedToken);
        tokens.set(normalizedToken, {expiresAtMs: Date.now() + RENDERER_FILE_OPEN_TOKEN_TTL_MS});
        rendererFileOpenTokens.set(senderId, tokens);
        pruneRendererFileOpenTokens(senderId);
        registerRendererFileOpenTokenCleanup(event, senderId);
        return true;
    });
    registrar.handle(DOCUMENTS_CHANNELS.allowRendererFileOpen, (event: IpcMainInvokeEvent, request: unknown) => {
        const senderId = getSenderId(event);
        const filePath = typeof request === 'object' && request !== null && 'filePath' in request
            ? (request as {filePath?: unknown;}).filePath
            : '';
        const token = typeof request === 'object' && request !== null && 'token' in request
            ? (request as {token?: unknown;}).token
            : '';
        if (typeof token !== 'string' || !consumeRendererFileOpenToken(senderId, token)) {
            return false;
        }

        const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
        if (!normalizedPath || !isAbsolute(normalizedPath) || !existsSync(normalizedPath) || !isSupportedOpenPath(normalizedPath)) {
            return false;
        }

        return allowOpenPath(normalizedPath, senderId) !== null;
    });
    registrar.handle(
        DOCUMENTS_CHANNELS.createWorkingCopyFromData,
        (event: IpcMainInvokeEvent, fileName: string, data: Uint8Array, originalPath?: string) =>
            service.createWorkingCopyFromData(event, fileName, data, originalPath),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
        (event: IpcMainInvokeEvent, sourcePath: string, originalPath?: string) =>
            requireWorkingCopySourcePath(event, sourcePath)
                .then(trustedSourcePath => service.createWorkingCopyFromPath(event, trustedSourcePath, originalPath)),
    );
    registrar.handle(DOCUMENTS_CHANNELS.savePdfAs, (event: IpcMainInvokeEvent, workingPath: string) =>
        service.savePdfAs(event, workingPath),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.savePdfDataAs,
        (event: IpcMainInvokeEvent, workingPath: string, data: Uint8Array) =>
            service.savePdfDataAs(event, workingPath, data),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.savePdfDataAsBegin,
        (event: IpcMainInvokeEvent, workingPath: string, totalBytes: number) =>
            service.beginSavePdfDataAs(event, workingPath, totalBytes),
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
    registrar.handle(DOCUMENTS_CHANNELS.pdfAnalyzeConformance, (event: IpcMainInvokeEvent, filePath: string) =>
        service.analyzePdfConformance(event, filePath),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.pdfValidateData,
        (event: IpcMainInvokeEvent, data: Uint8Array, fileName?: string) =>
            service.validatePdfData(event, data, fileName),
    );
    registrar.handle(DOCUMENTS_CHANNELS.pdfValidatePath, (event: IpcMainInvokeEvent, filePath: string) =>
        service.validatePdfPath(event, filePath),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData,
        (event: IpcMainInvokeEvent, data: Uint8Array, fileName?: string) =>
            service.openPdfInDefaultAppData(event, data, fileName),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath,
        (event: IpcMainInvokeEvent, filePath: string, fileName?: string) =>
            service.openPdfInDefaultAppPath(event, filePath, fileName),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.pdfPrintData,
        (event: IpcMainInvokeEvent, data: Uint8Array, fileName?: string) =>
            service.printPdfData(event, data, fileName),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.pdfPrintPath,
        (event: IpcMainInvokeEvent, filePath: string, fileName?: string, pageNumbers?: number[]) =>
            service.printPdfPath(event, filePath, fileName, pageNumbers),
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
    registrar.handle(
        DOCUMENTS_CHANNELS.fileSavePdfData,
        (event: IpcMainInvokeEvent, workingPath: string, data: Uint8Array) =>
            service.savePdfData(event, workingPath, data),
    );
    registrar.handle(
        DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
        (event: IpcMainInvokeEvent, workingPath: string, totalBytes: number) =>
            service.beginSavePdfData(event, workingPath, totalBytes),
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
    registrar.handle(DOCUMENTS_CHANNELS.recentFilesGet, (event: IpcMainInvokeEvent) => service.getRecentFiles(event));
    registrar.handle(DOCUMENTS_CHANNELS.recentFilesRemove, (event: IpcMainInvokeEvent, originalPath: string) =>
        service.removeRecentFile(event, originalPath),
    );
    registrar.handle(DOCUMENTS_CHANNELS.recentFilesClear, () => service.clearRecentFiles());
}
