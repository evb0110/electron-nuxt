import type { IpcRenderer } from 'electron';
import type {
    IDocumentsFileCapability,
    IDocumentChunkReadOptions,
    IPdfOptimizeOptions,
    IPdfSaveAsOptions,
} from '@contracts/electronApiDocuments';
import {
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
    normalizePdfNativeWorkingCopyExpectation,
} from '@contracts/nativePdfMutations';
import { isRecord } from '@contracts/runtimeGuards';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    type TPdfPersistenceErrorCode,
    type TPdfPersistenceErrorPhase,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import { createTypedIpcInvoker } from '@electron/preload/ipcClient';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    assertWorkingCopyFileName,
    assertWriteData,
    MAX_IPC_FILE_NAME_LENGTH,
} from '@electron/features/documents/preloadShared';

type TDocumentsPreloadFileClient = Omit<IDocumentsFileCapability, 'getPathForFile' | 'getPathsForFiles'>;
const PDF_PERSISTENCE_CHUNK_BYTES = 8 * 1024 * 1024;
const PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS = 2;
const PDF_PERSISTENCE_READY_TIMEOUT_MS = 10_000;
const PDF_PERSISTENCE_ACK_TIMEOUT_MS = 60_000;
const PDF_PERSISTENCE_RESULT_TIMEOUT_MS = 10 * 60_000;
const PDF_PERSISTENCE_ERROR_CODES = new Set<TPdfPersistenceErrorCode>([
    'CANCELED',
    'PROTOCOL_ERROR',
    'ACK_TIMEOUT',
    'COMMIT_FAILED',
    'WORKING_COPY_SYNC_WARNING',
    'UNKNOWN',
]);
const PDF_PERSISTENCE_ERROR_PHASES = new Set<TPdfPersistenceErrorPhase>([
    'streaming',
    'ack',
    'complete',
    'commit',
    'cancel',
]);
const PDF_OPTIMIZE_PRESETS = new Set<IPdfOptimizeOptions['preset']>([
    'lossless',
    'balancedScanned',
    'smallScanned',
    'blackAndWhite',
]);

interface ISerializedPdfPersistencePortResult {
    path: string | null;
    validation: Awaited<ReturnType<IDocumentsFileCapability['validatePdfData']>>;
}

type TPdfValidationResult = ISerializedPdfPersistencePortResult['validation'];
type TDocumentChunkSource = Parameters<IDocumentsFileCapability['savePdfDataChunks']>[2];

interface IPdfPersistenceResultMessage {
    type: 'result';
    path: string | null;
    validation: TPdfValidationResult;
}

interface IPdfPersistenceErrorMessage {
    type: 'error';
    error?: string;
    code?: TPdfPersistenceErrorCode;
    phase?: TPdfPersistenceErrorPhase;
    retryable?: boolean;
    expected?: boolean;
    seq?: number;
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

class PdfPersistenceError extends Error {
    readonly code: TPdfPersistenceErrorCode;
    readonly phase: TPdfPersistenceErrorPhase;
    readonly retryable: boolean;
    readonly expected: boolean;
    readonly seq: number | undefined;

    constructor(payload: IPdfPersistenceErrorMessage) {
        super(getPdfPersistenceErrorMessage(payload));
        this.name = 'PdfPersistenceError';
        this.code = payload.code ?? 'UNKNOWN';
        this.phase = payload.phase ?? 'streaming';
        this.retryable = payload.retryable ?? false;
        this.expected = payload.expected ?? false;
        this.seq = payload.seq;
    }
}

function assertPositiveInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer`);
    }
    return value;
}

function assertPdfSaveAsOptions(value: unknown, label: string): IPdfSaveAsOptions | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (value.optimizeLossless !== undefined && typeof value.optimizeLossless !== 'boolean') {
        throw new TypeError(`${label}.optimizeLossless must be a boolean`);
    }

    return value.optimizeLossless === true
        ? { optimizeLossless: true }
        : undefined;
}

function assertPdfOptimizeOptions(value: unknown, label: string): IPdfOptimizeOptions {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (!PDF_OPTIMIZE_PRESETS.has(value.preset as IPdfOptimizeOptions['preset'])) {
        throw new TypeError(`${label}.preset is invalid`);
    }

    return { preset: value.preset as IPdfOptimizeOptions['preset'] };
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

function assertPositiveSafeInteger(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${fieldName} must be a positive safe integer`);
    }
    return value;
}

function getChunkReadSize(options: IDocumentChunkReadOptions | undefined) {
    const chunkBytes = options?.chunkBytes ?? PDF_PERSISTENCE_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > PDF_PERSISTENCE_CHUNK_BYTES) {
        throw new Error(`readFileChunks.options.chunkBytes must be an integer between 1 and ${PDF_PERSISTENCE_CHUNK_BYTES}`);
    }
    return chunkBytes;
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('The operation was aborted.', 'AbortError');
    }
}

function getTightTransferChunk(chunk: Uint8Array, fieldName: string) {
    const checkedChunk = assertPersistenceData(chunk, fieldName);
    return checkedChunk.byteOffset === 0 && checkedChunk.byteLength === checkedChunk.buffer.byteLength
        ? checkedChunk
        : checkedChunk.slice();
}

async function* iterateDocumentChunks(chunks: TDocumentChunkSource) {
    for await (const chunk of chunks) {
        yield chunk;
    }
}

function* iterateUint8ArrayChunks(data: Uint8Array) {
    for (let offset = 0; offset < data.byteLength; offset += PDF_PERSISTENCE_CHUNK_BYTES) {
        const end = Math.min(offset + PDF_PERSISTENCE_CHUNK_BYTES, data.byteLength);
        yield data.slice(offset, end);
    }
}

function isPdfValidationResult(value: unknown): value is TPdfValidationResult {
    return isRecord(value)
        && typeof value.isValid === 'boolean'
        && (value.tool === 'qpdf' || value.tool === 'browser' || value.tool === 'native')
        && Array.isArray(value.errors)
        && value.errors.every(error => typeof error === 'string')
        && Array.isArray(value.warnings)
        && value.warnings.every(warning => typeof warning === 'string');
}

function isPersistenceProtocolLimits(value: unknown): value is {
    protocolVersion: number;
    maxChunkBytes: number;
    maxInFlightChunks: number;
    maxTotalBytes: number;
    ackTimeoutMs: number;
    resultTimeoutMs: number;
} {
    return isRecord(value)
        && value.protocolVersion === SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION
        && typeof value.maxChunkBytes === 'number'
        && Number.isSafeInteger(value.maxChunkBytes)
        && value.maxChunkBytes > 0
        && typeof value.maxInFlightChunks === 'number'
        && Number.isSafeInteger(value.maxInFlightChunks)
        && value.maxInFlightChunks > 0
        && typeof value.maxTotalBytes === 'number'
        && Number.isSafeInteger(value.maxTotalBytes)
        && value.maxTotalBytes > 0
        && typeof value.ackTimeoutMs === 'number'
        && Number.isSafeInteger(value.ackTimeoutMs)
        && value.ackTimeoutMs > 0
        && typeof value.resultTimeoutMs === 'number'
        && Number.isSafeInteger(value.resultTimeoutMs)
        && value.resultTimeoutMs > 0;
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
        if (typeof value.code === 'string' && PDF_PERSISTENCE_ERROR_CODES.has(value.code as TPdfPersistenceErrorCode)) {
            errorMessage.code = value.code as TPdfPersistenceErrorCode;
        }
        if (typeof value.phase === 'string' && PDF_PERSISTENCE_ERROR_PHASES.has(value.phase as TPdfPersistenceErrorPhase)) {
            errorMessage.phase = value.phase as TPdfPersistenceErrorPhase;
        }
        if (typeof value.retryable === 'boolean') {
            errorMessage.retryable = value.retryable;
        }
        if (typeof value.expected === 'boolean') {
            errorMessage.expected = value.expected;
        }
        if (typeof value.seq === 'number' && Number.isSafeInteger(value.seq)) {
            errorMessage.seq = value.seq;
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

function assertPersistenceProtocolLimits(value: unknown) {
    if (isRecord(value) && typeof value.sessionId === 'string' && value.protocolVersion === undefined) {
        return {
            protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
            maxChunkBytes: PDF_PERSISTENCE_CHUNK_BYTES,
            maxInFlightChunks: PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS,
            maxTotalBytes: Number.MAX_SAFE_INTEGER,
            ackTimeoutMs: PDF_PERSISTENCE_ACK_TIMEOUT_MS,
            resultTimeoutMs: PDF_PERSISTENCE_RESULT_TIMEOUT_MS,
        };
    }
    if (!isPersistenceProtocolLimits(value)) {
        throw new Error('Unsupported PDF persistence protocol');
    }
    return value;
}

function waitForPortStreamResult(port: MessagePort) {
    return new Promise<ISerializedPdfPersistencePortResult>((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            port.removeEventListener('message', handleMessage);
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('PDF persistence port did not return a final result'));
        }, PDF_PERSISTENCE_RESULT_TIMEOUT_MS);
        const handleMessage = (event: MessageEvent<unknown>) => {
            const payload = parsePdfPersistenceMessage(event.data);
            if (!payload) {
                return;
            }
            if (payload.type === 'result') {
                cleanup();
                resolve({
                    path: payload.path,
                    validation: payload.validation,
                });
                return;
            }
            if (payload.type === 'error') {
                cleanup();
                reject(new PdfPersistenceError(payload));
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
                reject(new PdfPersistenceError(payload));
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
                reject(new PdfPersistenceError(payload));
            }
        };
        port.addEventListener('message', handleMessage);
    });
}

async function streamPdfBytesToPersistencePort(
    ipcRenderer: Pick<IpcRenderer, 'postMessage'>,
    beginResult: {sessionId: string},
    chunks: TDocumentChunkSource,
    expectedTotalBytes: number,
) {
    const limits = assertPersistenceProtocolLimits(beginResult);
    const channel = new MessageChannel();
    channel.port1.start();
    try {
        const resultPromise = waitForPortStreamResult(channel.port1);
        ipcRenderer.postMessage(DOCUMENTS_CHANNELS.fileSavePdfDataPort, beginResult.sessionId, [channel.port2]);
        await waitForPortReady(channel.port1);

        let seq = 0;
        let bytesWritten = 0;
        const inFlightAcks: Array<Promise<void>> = [];
        for await (const chunk of iterateDocumentChunks(chunks)) {
            const bytes = getTightTransferChunk(chunk, `savePdfDataChunks.chunks[${seq}]`);
            bytesWritten += bytes.byteLength;
            if (bytes.byteLength > limits.maxChunkBytes || bytesWritten > expectedTotalBytes) {
                throw new Error('savePdfDataChunks chunks exceed the negotiated PDF persistence size');
            }
            // Electron's main-process MessagePort only transfers ports here; transferring the
            // ArrayBuffer drops the structured-clone payload before MessagePortMain receives it.
            channel.port1.postMessage({
                type: 'chunk',
                seq,
                bytes,
            });
            inFlightAcks.push(waitForPortAck(channel.port1, seq));
            if (inFlightAcks.length >= limits.maxInFlightChunks) {
                await inFlightAcks.shift();
            }
            seq += 1;
        }
        if (bytesWritten !== expectedTotalBytes) {
            throw new Error('savePdfDataChunks chunks did not match the negotiated PDF persistence size');
        }
        await Promise.all(inFlightAcks);

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
    const openDocumentDialog = () => invoke(DOCUMENTS_CHANNELS.openDocumentDialog);
    const openDocumentDirect = (path: string) => invoke(DOCUMENTS_CHANNELS.openDocumentDirect, path);
    const openDocumentDirectBatch = (paths: string[], requestId?: string) =>
        invoke(DOCUMENTS_CHANNELS.openDocumentDirectBatch, paths, requestId);

    return {
        openDocumentDialog,
        openPdfDialog: openDocumentDialog,
        openCombineDialog: () => invoke(DOCUMENTS_CHANNELS.openCombineDialog),
        openFolderDialog: () => invoke(DOCUMENTS_CHANNELS.openFolderDialog),
        openImageDialog: () => invoke(DOCUMENTS_CHANNELS.openImageDialog),
        openDocumentDirect,
        openPdfDirect: openDocumentDirect,
        openDocumentDirectBatch,
        openPdfDirectBatch: openDocumentDirectBatch,
        savePdfAs: (workingPath, options) =>
            invoke(
                DOCUMENTS_CHANNELS.savePdfAs,
                assertAbsolutePath(workingPath, 'savePdfAs.workingPath'),
                assertPdfSaveAsOptions(options, 'savePdfAs.options'),
            ),
        savePdfDataAs: async (workingPath, data, options) => {
            const checkedWorkingPath = assertAbsolutePath(workingPath, 'savePdfDataAs.workingPath');
            const checkedData = assertPersistenceData(data, 'savePdfDataAs.data');
            const checkedOptions = assertPdfSaveAsOptions(options, 'savePdfDataAs.options');
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.savePdfDataAsBegin,
                checkedWorkingPath,
                checkedData.byteLength,
                checkedOptions,
            );
            if (!beginResult.sessionId) {
                return {
                    path: null,
                    validation: null,
                };
            }
            const streamingBeginResult = {
                ...beginResult,
                sessionId: beginResult.sessionId,
            };

            return streamPdfBytesToPersistencePort(
                ipcRenderer,
                streamingBeginResult,
                iterateUint8ArrayChunks(checkedData),
                checkedData.byteLength,
            );
        },
        savePdfDialog: (suggestedName) => invoke(DOCUMENTS_CHANNELS.savePdfDialog, suggestedName),
        saveDocxAs: (workingPath) => invoke(DOCUMENTS_CHANNELS.saveDocxAs, workingPath),
        readFile: (path) => invoke(DOCUMENTS_CHANNELS.fileRead, path),
        statFile: (path) => invoke(DOCUMENTS_CHANNELS.fileStat, path),
        readFileRange: (path, offset, length) =>
            invoke(DOCUMENTS_CHANNELS.fileReadRange, path, offset, length),
        readFileChunks: async (path, options, onChunk) => {
            const checkedPath = assertAbsolutePath(path, 'readFileChunks.path');
            const chunkBytes = getChunkReadSize(options);
            const { size } = await invoke(DOCUMENTS_CHANNELS.fileStat, checkedPath);
            let bytesRead = 0;
            let chunks = 0;
            while (bytesRead < size) {
                throwIfAborted(options?.signal);
                const length = Math.min(chunkBytes, size - bytesRead);
                const chunk = await invoke(DOCUMENTS_CHANNELS.fileReadRange, checkedPath, bytesRead, length);
                await onChunk(chunk, bytesRead);
                bytesRead += chunk.byteLength;
                chunks += 1;
            }
            return {
                size,
                bytesRead,
                chunks,
            };
        },
        readTextFile: (path) => invoke(DOCUMENTS_CHANNELS.fileReadText, path),
        fileExists: (path) => invoke(DOCUMENTS_CHANNELS.fileExists, path),
        analyzePdfConformance: (path) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfAnalyzeConformance,
                assertAbsolutePath(path, 'analyzePdfConformance.path'),
            ),
        validatePdfData: (data, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfValidateData,
                assertWriteData(data, 'validatePdfData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'validatePdfData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        validatePdfPath: (path) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfValidatePath,
                assertAbsolutePath(path, 'validatePdfPath.path'),
            ),
        openPdfInDefaultAppData: (data, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData,
                assertWriteData(data, 'openPdfInDefaultAppData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'openPdfInDefaultAppData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        openPdfInDefaultAppPath: (path, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath,
                assertAbsolutePath(path, 'openPdfInDefaultAppPath.path'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'openPdfInDefaultAppPath.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        printPdfData: (data, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfPrintData,
                assertWriteData(data, 'printPdfData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'printPdfData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        printPdfPath: (path, fileName?: string, pageNumbers?: number[]) =>
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
        writeFile: (path, data) =>
            invoke(
                DOCUMENTS_CHANNELS.fileWrite,
                assertAbsolutePath(path, 'writeFile.path'),
                assertWriteData(data, 'writeFile.data'),
            ),
        replaceWorkingCopyFromPath: (workingCopyPath, sourcePath) =>
            invoke(
                DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath,
                assertAbsolutePath(workingCopyPath, 'replaceWorkingCopyFromPath.workingCopyPath'),
                assertAbsolutePath(sourcePath, 'replaceWorkingCopyFromPath.sourcePath'),
            ),
        writeDocxFile: (path, data) =>
            invoke(
                DOCUMENTS_CHANNELS.fileWriteDocx,
                assertAbsolutePath(path, 'writeDocxFile.path'),
                assertWriteData(data, 'writeDocxFile.data'),
            ),
        createWorkingCopyFromData: (fileName, data, originalPath?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromData,
                assertWorkingCopyFileName(fileName, 'createWorkingCopyFromData.fileName'),
                assertWriteData(data, 'createWorkingCopyFromData.data'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromData.originalPath'),
            ),
        createWorkingCopyFromPath: (sourcePath, originalPath?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
                assertAbsolutePath(sourcePath, 'createWorkingCopyFromPath.sourcePath'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromPath.originalPath'),
            ),
        saveFile: (path) => invoke(DOCUMENTS_CHANNELS.fileSave, path),
        repairPdf: (path) =>
            invoke(
                DOCUMENTS_CHANNELS.fileRepairPdf,
                assertAbsolutePath(path, 'repairPdf.path'),
            ),
        optimizePdfForInteraction: (path) =>
            invoke(
                DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction,
                assertAbsolutePath(path, 'optimizePdfForInteraction.path'),
            ),
        optimizePdfAsCopy: (path, options, requestId) =>
            invoke(
                DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy,
                assertAbsolutePath(path, 'optimizePdfAsCopy.path'),
                assertPdfOptimizeOptions(options, 'optimizePdfAsCopy.options'),
                typeof requestId === 'string'
                    ? assertNonEmptyString(requestId, 'optimizePdfAsCopy.requestId', 128)
                    : undefined,
            ),
        savePdfData: async (path, data) => {
            const checkedPath = assertAbsolutePath(path, 'savePdfData.path');
            const checkedData = assertPersistenceData(data, 'savePdfData.data');
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
                checkedPath,
                checkedData.byteLength,
            );
            const result = await streamPdfBytesToPersistencePort(
                ipcRenderer,
                beginResult,
                iterateUint8ArrayChunks(checkedData),
                checkedData.byteLength,
            );
            return result.validation;
        },
        savePdfDataChunks: async (path, totalBytes, chunks) => {
            const checkedPath = assertAbsolutePath(path, 'savePdfDataChunks.path');
            const checkedTotalBytes = assertPositiveSafeInteger(totalBytes, 'savePdfDataChunks.totalBytes');
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
                checkedPath,
                checkedTotalBytes,
            );
            const result = await streamPdfBytesToPersistencePort(ipcRenderer, beginResult, chunks, checkedTotalBytes);
            return result.validation;
        },
        savePdfNoteTextUpdates: (path, updates, modifiedAt) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates,
                assertAbsolutePath(path, 'savePdfNoteTextUpdates.path'),
                normalizePdfNativeNoteTextUpdates(updates, 'savePdfNoteTextUpdates.updates'),
                normalizePdfNativeModifiedAt(modifiedAt, 'savePdfNoteTextUpdates.modifiedAt'),
            ),
        savePdfNoteChanges: (path, changes, modifiedAt) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNoteChanges,
                assertAbsolutePath(path, 'savePdfNoteChanges.path'),
                normalizePdfNativeNoteChanges(changes, 'savePdfNoteChanges.changes'),
                normalizePdfNativeModifiedAt(modifiedAt, 'savePdfNoteChanges.modifiedAt'),
            ),
        savePdfNativeMutations: (path, mutations, modifiedAt) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNativeMutations,
                assertAbsolutePath(path, 'savePdfNativeMutations.path'),
                normalizePdfNativeMutationSet(mutations, 'savePdfNativeMutations.mutations'),
                normalizePdfNativeModifiedAt(modifiedAt, 'savePdfNativeMutations.modifiedAt'),
            ),
        applyPdfNativeMutationsToWorkingCopy: (path, mutations, modifiedAt, expectedBase) =>
            invoke(
                DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy,
                assertAbsolutePath(path, 'applyPdfNativeMutationsToWorkingCopy.path'),
                normalizePdfNativeMutationSet(mutations, 'applyPdfNativeMutationsToWorkingCopy.mutations'),
                normalizePdfNativeModifiedAt(modifiedAt, 'applyPdfNativeMutationsToWorkingCopy.modifiedAt'),
                normalizePdfNativeWorkingCopyExpectation(expectedBase, 'applyPdfNativeMutationsToWorkingCopy.expectedBase'),
            ),
        cleanupFile: (path) => invoke(DOCUMENTS_CHANNELS.fileCleanup, path),
        cleanupOcrTemp: (path) => invoke(DOCUMENTS_CHANNELS.fileCleanupOcrTemp, path),
        setWindowTitle: (title) => invoke(DOCUMENTS_CHANNELS.windowSetTitle, title),
        showItemInFolder: (path) => invoke(DOCUMENTS_CHANNELS.shellShowItemInFolder, path),
        recentFiles: {
            get: () => invoke(DOCUMENTS_CHANNELS.recentFilesGet),
            remove: (path) => invoke(DOCUMENTS_CHANNELS.recentFilesRemove, path),
            clear: () => invoke(DOCUMENTS_CHANNELS.recentFilesClear),
        },
    };
}
