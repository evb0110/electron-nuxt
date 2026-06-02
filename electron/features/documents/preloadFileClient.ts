import type { IpcRenderer } from 'electron';
import type {IDocumentsFileCapability} from '@contracts/platformApi';
import { isRecord } from '@contracts/runtimeGuards';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { createTypedIpcInvoker } from '@electron/preload/ipcClient';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    assertWorkingCopyFileName,
    assertWriteData,
    MAX_IPC_FILE_NAME_LENGTH,
} from '@electron/features/documents/preloadShared';

type TDocumentsPreloadFileClient = Omit<IDocumentsFileCapability, 'getPathForFile'>;
const PDF_PERSISTENCE_CHUNK_BYTES = 8 * 1024 * 1024;
const PDF_PERSISTENCE_READY_TIMEOUT_MS = 10_000;
const PDF_PERSISTENCE_ACK_TIMEOUT_MS = 60_000;

interface ISerializedPdfPersistencePortResult {
    path: string | null;
    validation: Awaited<ReturnType<IDocumentsFileCapability['validatePdfData']>>;
}

type TPdfValidationResult = ISerializedPdfPersistencePortResult['validation'];

interface IPdfPersistenceResultMessage {
    type: 'result';
    path: string | null;
    validation: TPdfValidationResult;
}

interface IPdfPersistenceErrorMessage {
    type: 'error';
    error?: string;
}

interface IPdfPersistenceReadyMessage {type: 'ready';}

interface IPdfPersistenceAckMessage {
    type: 'ack';
    seq: number;
}

type TPdfPersistenceMessage =
    | IPdfPersistenceResultMessage
    | IPdfPersistenceErrorMessage
    | IPdfPersistenceReadyMessage
    | IPdfPersistenceAckMessage;

function assertPositiveInteger(value: number, label: string) {
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer`);
    }
    return value;
}

function assertPersistenceData(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength === 0) {
        throw new Error(`${fieldName} must not be empty`);
    }
    return value;
}

function isPdfValidationResult(value: unknown): value is TPdfValidationResult {
    return isRecord(value)
        && typeof value.isValid === 'boolean'
        && (value.tool === 'qpdf' || value.tool === 'browser')
        && Array.isArray(value.errors)
        && value.errors.every(error => typeof error === 'string')
        && Array.isArray(value.warnings)
        && value.warnings.every(warning => typeof warning === 'string');
}

function parsePdfPersistenceMessage(value: unknown): TPdfPersistenceMessage | null {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return null;
    }
    if (value.type === 'result' && isPdfValidationResult(value.validation)) {
        return {
            type: 'result',
            path: typeof value.path === 'string' ? value.path : null,
            validation: value.validation,
        };
    }
    if (value.type === 'error') {
        const errorMessage: IPdfPersistenceErrorMessage = {type: 'error'};
        if (typeof value.error === 'string') {
            errorMessage.error = value.error;
        }
        return errorMessage;
    }
    if (value.type === 'ready') {
        return {type: 'ready'};
    }
    if (value.type === 'ack' && typeof value.seq === 'number') {
        return {
            type: 'ack',
            seq: value.seq,
        };
    }
    return null;
}

function getPdfPersistenceErrorMessage(payload: IPdfPersistenceErrorMessage) {
    return typeof payload.error === 'string' ? payload.error : 'PDF persistence failed';
}

function waitForPortStreamResult(port: MessagePort) {
    return new Promise<ISerializedPdfPersistencePortResult>((resolve, reject) => {
        const handleMessage = (event: MessageEvent<unknown>) => {
            const payload = parsePdfPersistenceMessage(event.data);
            if (!payload) {
                return;
            }
            if (payload.type === 'result') {
                resolve({
                    path: payload.path,
                    validation: payload.validation,
                });
                return;
            }
            if (payload.type === 'error') {
                reject(new Error(getPdfPersistenceErrorMessage(payload)));
            }
        };
        port.addEventListener('message', handleMessage);
    });
}

function waitForPortReady(port: MessagePort) {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            port.removeEventListener('message', handleMessage);
            reject(new Error('PDF persistence port did not become ready'));
        }, PDF_PERSISTENCE_READY_TIMEOUT_MS);
        const handleMessage = (event: MessageEvent<unknown>) => {
            const payload = parsePdfPersistenceMessage(event.data);
            if (!payload) {
                return;
            }
            if (payload.type === 'ready') {
                clearTimeout(timeout);
                port.removeEventListener('message', handleMessage);
                resolve();
                return;
            }
            if (payload.type === 'error') {
                clearTimeout(timeout);
                port.removeEventListener('message', handleMessage);
                reject(new Error(getPdfPersistenceErrorMessage(payload)));
            }
        };
        port.addEventListener('message', handleMessage);
    });
}

function waitForPortAck(port: MessagePort, expectedSeq: number) {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            port.removeEventListener('message', handleMessage);
            reject(new Error(`PDF persistence chunk ${expectedSeq} was not acknowledged`));
        }, PDF_PERSISTENCE_ACK_TIMEOUT_MS);
        const handleMessage = (event: MessageEvent<unknown>) => {
            const payload = parsePdfPersistenceMessage(event.data);
            if (!payload) {
                return;
            }
            if (payload.type === 'ack') {
                if (payload.seq !== expectedSeq) {
                    clearTimeout(timeout);
                    port.removeEventListener('message', handleMessage);
                    reject(new Error('Unexpected PDF persistence acknowledgement sequence'));
                    return;
                }
                clearTimeout(timeout);
                port.removeEventListener('message', handleMessage);
                resolve();
                return;
            }
            if (payload.type === 'error') {
                clearTimeout(timeout);
                port.removeEventListener('message', handleMessage);
                reject(new Error(getPdfPersistenceErrorMessage(payload)));
            }
        };
        port.addEventListener('message', handleMessage);
    });
}

async function streamPdfBytesToPersistencePort(
    ipcRenderer: Pick<IpcRenderer, 'postMessage'>,
    sessionId: string,
    data: Uint8Array,
) {
    const channel = new MessageChannel();
    channel.port1.start();
    try {
        const resultPromise = waitForPortStreamResult(channel.port1);
        ipcRenderer.postMessage(DOCUMENTS_CHANNELS.fileSavePdfDataPort, sessionId, [channel.port2]);
        await waitForPortReady(channel.port1);

        let seq = 0;
        for (let offset = 0; offset < data.byteLength; offset += PDF_PERSISTENCE_CHUNK_BYTES) {
            const end = Math.min(offset + PDF_PERSISTENCE_CHUNK_BYTES, data.byteLength);
            const bytes = data.slice(offset, end);
            channel.port1.postMessage({
                type: 'chunk',
                seq,
                bytes,
            });
            await waitForPortAck(channel.port1, seq);
            seq += 1;
        }

        channel.port1.postMessage({ type: 'complete' });
        return await resultPromise;
    } finally {
        channel.port1.close();
    }
}

export function createDocumentsPreloadFileClient(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'postMessage'>,
): TDocumentsPreloadFileClient {
    const invoke = createTypedIpcInvoker<IDocumentsInvokeMap>(ipcRenderer);

    return {
        openPdfDialog: () => invoke(DOCUMENTS_CHANNELS.openPdfDialog),
        openCombineDialog: () => invoke(DOCUMENTS_CHANNELS.openCombineDialog),
        openFolderDialog: () => invoke(DOCUMENTS_CHANNELS.openFolderDialog),
        openImageDialog: () => invoke(DOCUMENTS_CHANNELS.openImageDialog),
        openPdfDirect: (path: string) => invoke(DOCUMENTS_CHANNELS.openPdfDirect, path),
        openPdfDirectBatch: (paths: string[], requestId?: string) =>
            invoke(DOCUMENTS_CHANNELS.openPdfDirectBatch, paths, requestId),
        savePdfAs: (workingPath: string) => invoke(DOCUMENTS_CHANNELS.savePdfAs, workingPath),
        savePdfDataAs: async (workingPath: string, data: Uint8Array) => {
            const checkedWorkingPath = assertAbsolutePath(workingPath, 'savePdfDataAs.workingPath');
            const checkedData = assertPersistenceData(data, 'savePdfDataAs.data');
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.savePdfDataAsBegin,
                checkedWorkingPath,
                checkedData.byteLength,
            );
            if (!beginResult.sessionId) {
                return {
                    path: null,
                    validation: null,
                };
            }

            return streamPdfBytesToPersistencePort(ipcRenderer, beginResult.sessionId, checkedData);
        },
        savePdfDialog: (suggestedName: string) => invoke(DOCUMENTS_CHANNELS.savePdfDialog, suggestedName),
        saveDocxAs: (workingPath: string) => invoke(DOCUMENTS_CHANNELS.saveDocxAs, workingPath),
        readFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileRead, path),
        statFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileStat, path),
        readFileRange: (path: string, offset: number, length: number) =>
            invoke(DOCUMENTS_CHANNELS.fileReadRange, path, offset, length),
        readTextFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileReadText, path),
        fileExists: (path: string) => invoke(DOCUMENTS_CHANNELS.fileExists, path),
        analyzePdfConformance: (path: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfAnalyzeConformance,
                assertAbsolutePath(path, 'analyzePdfConformance.path'),
            ),
        validatePdfData: (data: Uint8Array, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfValidateData,
                assertWriteData(data, 'validatePdfData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'validatePdfData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        validatePdfPath: (path: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfValidatePath,
                assertAbsolutePath(path, 'validatePdfPath.path'),
            ),
        openPdfInDefaultAppData: (data: Uint8Array, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData,
                assertWriteData(data, 'openPdfInDefaultAppData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'openPdfInDefaultAppData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        openPdfInDefaultAppPath: (path: string, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath,
                assertAbsolutePath(path, 'openPdfInDefaultAppPath.path'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'openPdfInDefaultAppPath.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        printPdfData: (data: Uint8Array, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfPrintData,
                assertWriteData(data, 'printPdfData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'printPdfData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        printPdfPath: (path: string, fileName?: string, pageNumbers?: number[]) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfPrintPath,
                assertAbsolutePath(path, 'printPdfPath.path'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'printPdfPath.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
                Array.isArray(pageNumbers)
                    ? pageNumbers.map((pageNumber, index) => assertPositiveInteger(pageNumber, `printPdfPath.pageNumbers[${index}]`))
                    : undefined,
            ),
        writeFile: (path: string, data: Uint8Array) =>
            invoke(
                DOCUMENTS_CHANNELS.fileWrite,
                assertAbsolutePath(path, 'writeFile.path'),
                assertWriteData(data, 'writeFile.data'),
            ),
        replaceWorkingCopyFromPath: (workingCopyPath: string, sourcePath: string) =>
            invoke(
                DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath,
                assertAbsolutePath(workingCopyPath, 'replaceWorkingCopyFromPath.workingCopyPath'),
                assertAbsolutePath(sourcePath, 'replaceWorkingCopyFromPath.sourcePath'),
            ),
        writeDocxFile: (path: string, data: Uint8Array) =>
            invoke(
                DOCUMENTS_CHANNELS.fileWriteDocx,
                assertAbsolutePath(path, 'writeDocxFile.path'),
                assertWriteData(data, 'writeDocxFile.data'),
            ),
        createWorkingCopyFromData: (fileName: string, data: Uint8Array, originalPath?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromData,
                assertWorkingCopyFileName(fileName, 'createWorkingCopyFromData.fileName'),
                assertWriteData(data, 'createWorkingCopyFromData.data'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromData.originalPath'),
            ),
        createWorkingCopyFromPath: (sourcePath: string, originalPath?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
                assertAbsolutePath(sourcePath, 'createWorkingCopyFromPath.sourcePath'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromPath.originalPath'),
            ),
        saveFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileSave, path),
        savePdfData: async (path: string, data: Uint8Array) => {
            const checkedPath = assertAbsolutePath(path, 'savePdfData.path');
            const checkedData = assertPersistenceData(data, 'savePdfData.data');
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
                checkedPath,
                checkedData.byteLength,
            );
            const result = await streamPdfBytesToPersistencePort(ipcRenderer, beginResult.sessionId, checkedData);
            return result.validation;
        },
        cleanupFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileCleanup, path),
        cleanupOcrTemp: (path: string) => invoke(DOCUMENTS_CHANNELS.fileCleanupOcrTemp, path),
        setWindowTitle: (title: string) => invoke(DOCUMENTS_CHANNELS.windowSetTitle, title),
        showItemInFolder: (path: string) => invoke(DOCUMENTS_CHANNELS.shellShowItemInFolder, path),
        recentFiles: {
            get: () => invoke(DOCUMENTS_CHANNELS.recentFilesGet),
            remove: (path: string) => invoke(DOCUMENTS_CHANNELS.recentFilesRemove, path),
            clear: () => invoke(DOCUMENTS_CHANNELS.recentFilesClear),
        },
    };
}
