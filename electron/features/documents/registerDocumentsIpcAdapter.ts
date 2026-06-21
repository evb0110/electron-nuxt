import type { IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import type {
    IIpcMainRegistrar,
    TIpcMainInvokeHandler,
} from '@contracts/ipcMain';
import { isRecord } from '@contracts/runtimeGuards';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {createDocumentsService} from '@electron/features/documents/createDocumentsService';
import type { IDocumentsService } from '@electron/features/documents/documentsService';
import {
    allowOpenPath,
    requireOpenPath,
    type TOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { isSupportedOpenPath } from '@electron/image/pdfConversion';
import { requireManagedWorkingCopyPath } from '@electron/file-access/workingCopyCreation';

interface IRendererFileOpenToken {expiresAtMs: number;}
type TDocumentsIpcRegistrar = IIpcMainRegistrar<IDocumentsInvokeMap, IpcMainInvokeEvent>;
type TDocumentsIpcChannel = Extract<keyof IDocumentsInvokeMap, string>;

const RENDERER_FILE_OPEN_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER = 128;
const RENDERER_FILE_OPEN_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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

export function registerDocumentsIpcAdapter(
    registrar: TDocumentsIpcRegistrar,
    service: IDocumentsService = createDocumentsService(),
) {
    const register = <TChannel extends TDocumentsIpcChannel>(
        channel: TChannel,
        handler: TIpcMainInvokeHandler<
            IDocumentsInvokeMap[TChannel]['args'],
            IDocumentsInvokeMap[TChannel]['result'],
            IpcMainInvokeEvent
        >,
    ) => registrar.handle(channel, handler);

    register(DOCUMENTS_CHANNELS.openDocumentDialog, event => service.openDocumentDialog(event));
    register(DOCUMENTS_CHANNELS.openCombineDialog, event => service.openCombineDialog(event));
    register(DOCUMENTS_CHANNELS.openFolderDialog, event => service.openFolderDialog(event));
    register(DOCUMENTS_CHANNELS.openImageDialog, event => service.openImageDialog(event));
    register(DOCUMENTS_CHANNELS.openDocumentDirect, (event, filePath) => service.openDocumentDirect(event, filePath));
    register(DOCUMENTS_CHANNELS.openDocumentDirectBatch, (event, filePaths, requestId) =>
        service.openDocumentDirectBatch(event, filePaths, requestId));
    register(DOCUMENTS_CHANNELS.createWorkingCopyFromData, (event, fileName, data, originalPath) =>
        service.createWorkingCopyFromData(event, fileName, data, originalPath));
    register(DOCUMENTS_CHANNELS.savePdfAs, (event, workingPath) => service.savePdfAs(event, workingPath));
    register(DOCUMENTS_CHANNELS.savePdfDataAs, (event, workingPath, data) =>
        service.savePdfDataAs(event, workingPath, data));
    register(DOCUMENTS_CHANNELS.savePdfDataAsBegin, (event, workingPath, totalBytes) =>
        service.beginSavePdfDataAs(event, workingPath, totalBytes));
    register(DOCUMENTS_CHANNELS.savePdfDialog, (event, suggestedName) => service.savePdfDialog(event, suggestedName));
    register(DOCUMENTS_CHANNELS.saveDocxAs, (event, workingPath) => service.saveDocxAs(event, workingPath));
    register(DOCUMENTS_CHANNELS.fileRead, (event, filePath) => service.readFile(event, filePath));
    register(DOCUMENTS_CHANNELS.fileStat, (event, filePath) => service.statFile(event, filePath));
    register(DOCUMENTS_CHANNELS.fileReadRange, (event, filePath, offset, length) =>
        service.readFileRange(event, filePath, offset, length));
    register(DOCUMENTS_CHANNELS.fileReadText, (event, filePath) => service.readTextFile(event, filePath));
    register(DOCUMENTS_CHANNELS.fileExists, (event, filePath) => service.fileExists(event, filePath));
    register(DOCUMENTS_CHANNELS.pdfAnalyzeConformance, (event, filePath) => service.analyzePdfConformance(event, filePath));
    register(DOCUMENTS_CHANNELS.pdfValidateData, (event, data, fileName) =>
        service.validatePdfData(event, data, fileName));
    register(DOCUMENTS_CHANNELS.pdfValidatePath, (event, filePath) => service.validatePdfPath(event, filePath));
    register(DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData, (event, data, fileName) =>
        service.openPdfInDefaultAppData(event, data, fileName));
    register(DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath, (event, filePath, fileName) =>
        service.openPdfInDefaultAppPath(event, filePath, fileName));
    register(DOCUMENTS_CHANNELS.pdfPrintData, (event, data, fileName) =>
        service.printPdfData(event, data, fileName));
    register(DOCUMENTS_CHANNELS.pdfPrintPath, (event, filePath, fileName, pageNumbers) =>
        service.printPdfPath(event, filePath, fileName, pageNumbers));
    register(DOCUMENTS_CHANNELS.fileWrite, (event, filePath, data) =>
        service.writeFile(event, filePath, data));
    register(DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath, (event, workingCopyPath, sourcePath) =>
        service.replaceWorkingCopyFromPath(event, workingCopyPath, sourcePath));
    register(DOCUMENTS_CHANNELS.fileWriteDocx, (event, filePath, data) =>
        service.writeDocxFile(event, filePath, data));
    register(DOCUMENTS_CHANNELS.fileSave, (event, workingPath) => service.saveFile(event, workingPath));
    register(DOCUMENTS_CHANNELS.fileRepairPdf, (event, workingPath) => service.repairPdf(event, workingPath));
    register(DOCUMENTS_CHANNELS.fileSavePdfData, (event, workingPath, data) =>
        service.savePdfData(event, workingPath, data));
    register(DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates, (event, workingPath, updates, modifiedAt) =>
        service.savePdfNoteTextUpdates(event, workingPath, updates, modifiedAt));
    register(DOCUMENTS_CHANNELS.fileSavePdfNoteChanges, (event, workingPath, changes, modifiedAt) =>
        service.savePdfNoteChanges(event, workingPath, changes, modifiedAt));
    register(DOCUMENTS_CHANNELS.fileSavePdfNativeMutations, (event, workingPath, mutations, modifiedAt) =>
        service.savePdfNativeMutations(event, workingPath, mutations, modifiedAt));
    register(DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy, (event, workingPath, mutations, modifiedAt, expectedBase) =>
        service.applyPdfNativeMutationsToWorkingCopy(event, workingPath, mutations, modifiedAt, expectedBase));
    register(DOCUMENTS_CHANNELS.fileSavePdfDataBegin, (event, workingPath, totalBytes) =>
        service.beginSavePdfData(event, workingPath, totalBytes));
    register(DOCUMENTS_CHANNELS.fileCleanupOcrTemp, (event, filePath) => service.cleanupOcrTemp(event, filePath));
    register(DOCUMENTS_CHANNELS.windowSetTitle, (event, title) => service.setWindowTitle(event, title));
    register(DOCUMENTS_CHANNELS.shellShowItemInFolder, (event, filePath) => service.showItemInFolder(event, filePath));
    register(DOCUMENTS_CHANNELS.menuSetDocumentState, (event, state) => service.setMenuDocumentState(event, state));
    register(DOCUMENTS_CHANNELS.menuSetTabCount, (event, tabCount) => service.setMenuTabCount(event, tabCount));
    register(DOCUMENTS_CHANNELS.recentFilesGet, event => service.getRecentFiles(event));
    register(DOCUMENTS_CHANNELS.recentFilesRemove, (event, originalPath) => service.removeRecentFile(event, originalPath));
    register(DOCUMENTS_CHANNELS.registerRendererFileOpenToken, (event, token: unknown) => {
        const normalizedToken = typeof token === 'string' ? token.trim() : '';
        if (!RENDERER_FILE_OPEN_TOKEN_PATTERN.test(normalizedToken)) {
            return false;
        }

        const senderId = getSenderId(event);
        const tokens = rendererFileOpenTokens.get(senderId) ?? new Map<string, IRendererFileOpenToken>();
        pruneRendererFileOpenTokens(senderId);
        if (tokens.size >= MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER && !tokens.has(normalizedToken)) {
            return false;
        }
        tokens.delete(normalizedToken);
        tokens.set(normalizedToken, {expiresAtMs: Date.now() + RENDERER_FILE_OPEN_TOKEN_TTL_MS});
        rendererFileOpenTokens.set(senderId, tokens);
        registerRendererFileOpenTokenCleanup(event, senderId);
        return true;
    });
    register(DOCUMENTS_CHANNELS.allowRendererFileOpen, (event, request: unknown) => {
        const senderId = getSenderId(event);
        const filePath = isRecord(request) ? request.filePath : '';
        const token = isRecord(request) ? request.token : '';
        if (typeof token !== 'string' || !consumeRendererFileOpenToken(senderId, token)) {
            return false;
        }

        const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
        if (!normalizedPath || !isAbsolute(normalizedPath) || !existsSync(normalizedPath) || !isSupportedOpenPath(normalizedPath)) {
            return false;
        }

        return allowOpenPath(normalizedPath, event.sender) !== null;
    });
    register(
        DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
        (event, sourcePath: string, originalPath?: string) =>
            requireWorkingCopySourcePath(event, sourcePath)
                .then(trustedSourcePath => service.createWorkingCopyFromPath(event, trustedSourcePath, originalPath)),
    );
    register(DOCUMENTS_CHANNELS.fileCleanup, (event, workingPath: string) => {
        service.cleanupFile(event, workingPath);
        return undefined;
    });
    register(DOCUMENTS_CHANNELS.recentFilesClear, () => service.clearRecentFiles());
}
