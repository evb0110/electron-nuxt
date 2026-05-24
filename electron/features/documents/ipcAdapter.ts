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
// The registrar accepts heterogeneous IPC handler signatures, so the forwarding
// table needs a variadic catch-all type here.
type TDocumentsForwarderHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

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
        return requireOpenPath(sourcePath, event.sender);
    } catch {
        return requireManagedWorkingCopyPath(sourcePath, getSenderId(event));
    }
}

function registerForwardedDocumentHandlers(
    registrar: IIpcMainRegistrar,
    handlers: Readonly<Record<string, TDocumentsForwarderHandler>>,
) {
    for (const [
        channel,
        handler,
    ] of Object.entries(handlers)) {
        registrar.handle(channel, handler);
    }
}

export function registerDocumentsIpcAdapter(
    registrar: IIpcMainRegistrar,
    service: IDocumentsService = createDocumentsService(),
) {
    const forwardedHandlers = {
        [DOCUMENTS_CHANNELS.openPdfDialog]: (event) => service.openPdfDialog(event),
        [DOCUMENTS_CHANNELS.openCombineDialog]: (event) => service.openCombineDialog(event),
        [DOCUMENTS_CHANNELS.openFolderDialog]: (event) => service.openFolderDialog(event),
        [DOCUMENTS_CHANNELS.openImageDialog]: (event) => service.openImageDialog(event),
        [DOCUMENTS_CHANNELS.openPdfDirect]: (event, filePath: string) => service.openPdfDirect(event, filePath),
        [DOCUMENTS_CHANNELS.openPdfDirectBatch]: (event, filePaths: string[], requestId?: string) =>
            service.openPdfDirectBatch(event, filePaths, requestId),
        [DOCUMENTS_CHANNELS.createWorkingCopyFromData]: (event, fileName: string, data: Uint8Array, originalPath?: string) =>
            service.createWorkingCopyFromData(event, fileName, data, originalPath),
        [DOCUMENTS_CHANNELS.savePdfAs]: (event, workingPath: string) => service.savePdfAs(event, workingPath),
        [DOCUMENTS_CHANNELS.savePdfDataAs]: (event, workingPath: string, data: Uint8Array) =>
            service.savePdfDataAs(event, workingPath, data),
        [DOCUMENTS_CHANNELS.savePdfDataAsBegin]: (event, workingPath: string, totalBytes: number) =>
            service.beginSavePdfDataAs(event, workingPath, totalBytes),
        [DOCUMENTS_CHANNELS.savePdfDialog]: (event, suggestedName: string) => service.savePdfDialog(event, suggestedName),
        [DOCUMENTS_CHANNELS.saveDocxAs]: (event, workingPath: string) => service.saveDocxAs(event, workingPath),
        [DOCUMENTS_CHANNELS.fileRead]: (event, filePath: string) => service.readFile(event, filePath),
        [DOCUMENTS_CHANNELS.fileStat]: (event, filePath: string) => service.statFile(event, filePath),
        [DOCUMENTS_CHANNELS.fileReadRange]: (event, filePath: string, offset: number, length: number) =>
            service.readFileRange(event, filePath, offset, length),
        [DOCUMENTS_CHANNELS.fileReadText]: (event, filePath: string) => service.readTextFile(event, filePath),
        [DOCUMENTS_CHANNELS.fileExists]: (event, filePath: string) => service.fileExists(event, filePath),
        [DOCUMENTS_CHANNELS.pdfAnalyzeConformance]: (event, filePath: string) => service.analyzePdfConformance(event, filePath),
        [DOCUMENTS_CHANNELS.pdfValidateData]: (event, data: Uint8Array, fileName?: string) =>
            service.validatePdfData(event, data, fileName),
        [DOCUMENTS_CHANNELS.pdfValidatePath]: (event, filePath: string) => service.validatePdfPath(event, filePath),
        [DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData]: (event, data: Uint8Array, fileName?: string) =>
            service.openPdfInDefaultAppData(event, data, fileName),
        [DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath]: (event, filePath: string, fileName?: string) =>
            service.openPdfInDefaultAppPath(event, filePath, fileName),
        [DOCUMENTS_CHANNELS.pdfPrintData]: (event, data: Uint8Array, fileName?: string) =>
            service.printPdfData(event, data, fileName),
        [DOCUMENTS_CHANNELS.pdfPrintPath]: (event, filePath: string, fileName?: string, pageNumbers?: number[]) =>
            service.printPdfPath(event, filePath, fileName, pageNumbers),
        [DOCUMENTS_CHANNELS.fileWrite]: (event, filePath: string, data: Uint8Array) =>
            service.writeFile(event, filePath, data),
        [DOCUMENTS_CHANNELS.fileWriteDocx]: (event, filePath: string, data: Uint8Array) =>
            service.writeDocxFile(event, filePath, data),
        [DOCUMENTS_CHANNELS.fileSave]: (event, workingPath: string) => service.saveFile(event, workingPath),
        [DOCUMENTS_CHANNELS.fileSavePdfData]: (event, workingPath: string, data: Uint8Array) =>
            service.savePdfData(event, workingPath, data),
        [DOCUMENTS_CHANNELS.fileSavePdfDataBegin]: (event, workingPath: string, totalBytes: number) =>
            service.beginSavePdfData(event, workingPath, totalBytes),
        [DOCUMENTS_CHANNELS.fileCleanupOcrTemp]: (event, filePath: string) => service.cleanupOcrTemp(event, filePath),
        [DOCUMENTS_CHANNELS.windowSetTitle]: (event, title: string) => service.setWindowTitle(event, title),
        [DOCUMENTS_CHANNELS.shellShowItemInFolder]: (event, filePath: string) => service.showItemInFolder(event, filePath),
        [DOCUMENTS_CHANNELS.menuSetDocumentState]: (
            event,
            state: boolean | {
                hasDocument: boolean;
                canSave: boolean 
            },
        ) => service.setMenuDocumentState(event, state),
        [DOCUMENTS_CHANNELS.menuSetTabCount]: (event, tabCount: number) => service.setMenuTabCount(event, tabCount),
        [DOCUMENTS_CHANNELS.recentFilesGet]: (event) => service.getRecentFiles(event),
        [DOCUMENTS_CHANNELS.recentFilesRemove]: (event, originalPath: string) => service.removeRecentFile(event, originalPath),
    } satisfies Record<string, TDocumentsForwarderHandler>;
    registerForwardedDocumentHandlers(registrar, forwardedHandlers);
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

        return allowOpenPath(normalizedPath, event.sender) !== null;
    });
    registrar.handle(
        DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
        (event: IpcMainInvokeEvent, sourcePath: string, originalPath?: string) =>
            requireWorkingCopySourcePath(event, sourcePath)
                .then(trustedSourcePath => service.createWorkingCopyFromPath(event, trustedSourcePath, originalPath)),
    );
    registrar.handle(DOCUMENTS_CHANNELS.fileCleanup, (event: IpcMainInvokeEvent, workingPath: string) => {
        service.cleanupFile(event, workingPath);
        return;
    });
    registrar.handle(DOCUMENTS_CHANNELS.recentFilesClear, () => service.clearRecentFiles());
}
