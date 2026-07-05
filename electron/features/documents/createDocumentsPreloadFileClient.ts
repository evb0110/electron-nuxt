import type {
    IpcRenderer,
    IpcRendererEvent,
} from 'electron';
import type { IDocumentRevisionChangedEvent } from '@contracts/documentRevision';
import type {
    IDocumentsFileCapability,
    IDocumentChunkReadOptions,
    IPdfNativePagePreviewOptions,
    IPdfOptimizeOptions,
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import { isPdfOptimizePreset } from '@contracts/electronApiDocuments';
import {
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
    normalizePdfNativeWorkingCopyExpectation,
} from '@pdf-core';
import { isRecord } from '@contracts/runtimeGuards';
import {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    createPdfPersistenceChunkFrame,
    createPdfPersistenceCompleteFrame,
    getPdfPersistenceErrorMessage,
    isSerializedPdfPersistenceLimits,
    parsePdfPersistenceMainToPreloadFrame,
    type IPdfPersistenceErrorFrame,
} from '@contracts/documentPersistenceFrames';
import {
    DOCUMENTS_CHANNELS,
    DOCUMENTS_EVENT_CHANNELS,
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

type TDocumentsPreloadFileClient = Omit<
    IDocumentsFileCapability,
    'getPathForFile' | 'getPathsForFiles' | 'registerFilesForOpen'
>;
type TDocumentsFileIpcRenderer = Pick<IpcRenderer, 'invoke' | 'postMessage'>
    & Partial<Pick<IpcRenderer, 'on' | 'removeListener'>>;
const PDF_PERSISTENCE_CHUNK_BYTES = PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES;
const PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS = PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS;
const PDF_PERSISTENCE_READY_TIMEOUT_MS = 10_000;
const PDF_PERSISTENCE_ACK_TIMEOUT_MS = PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS;
const PDF_PERSISTENCE_RESULT_TIMEOUT_MS = PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS;
const LONG_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1000;
const DOCUMENTS_NATIVE_INVOKE_TIMEOUT_MS_BY_CHANNEL = {
    [DOCUMENTS_CHANNELS.openDocumentDirectBatch]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfNativePageSizes]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfNativePagePreview]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfAnalyzeConformance]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfValidatePath]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileRepairPdf]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileSavePdfNoteChanges]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileSavePdfNativeMutations]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy]: LONG_NATIVE_IPC_TIMEOUT_MS,
} as const;
interface ISerializedPdfPersistencePortResult {
    path: string | null;
    validation: Awaited<ReturnType<IDocumentsFileCapability['validatePdfData']>>;
}

type TDocumentChunkSource = Parameters<IDocumentsFileCapability['savePdfDataChunks']>[2];

class PdfPersistenceError extends Error {
    readonly code: IPdfPersistenceErrorFrame['code'];
    readonly phase: IPdfPersistenceErrorFrame['phase'];
    readonly retryable: boolean;
    readonly expected: boolean;
    readonly seq: number | undefined;

    constructor(payload: IPdfPersistenceErrorFrame) {
        super(getPdfPersistenceErrorMessage(payload));
        this.name = 'PdfPersistenceError';
        this.code = payload.code;
        this.phase = payload.phase;
        this.retryable = payload.retryable;
        this.expected = payload.expected;
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

function assertPdfSerializedSaveOptions(value: unknown, label: string): IPdfSerializedSaveOptions {
    if (value === undefined || value === null) {
        throw new TypeError(`${label}.expectedDocumentRevisionToken must be a non-empty string`);
    }
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const token = value.expectedDocumentRevisionToken;
    if (token === undefined || token === null) {
        throw new TypeError(`${label}.expectedDocumentRevisionToken must be a non-empty string`);
    }
    if (typeof token !== 'string' || token.trim().length === 0) {
        throw new TypeError(`${label}.expectedDocumentRevisionToken must be a non-empty string`);
    }

    return { expectedDocumentRevisionToken: token.trim() };
}

function assertPdfOptimizeOptions(value: unknown, label: string): IPdfOptimizeOptions {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (!isPdfOptimizePreset(value.preset)) {
        throw new TypeError(`${label}.preset is invalid`);
    }

    return { preset: value.preset };
}

function assertPdfNativePagePreviewOptions(
    value: unknown,
    label: string,
): IPdfNativePagePreviewOptions | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (
        value.targetWidthPx !== undefined
        && (
            typeof value.targetWidthPx !== 'number'
            || !Number.isFinite(value.targetWidthPx)
            || value.targetWidthPx < 1
        )
    ) {
        throw new TypeError(`${label}.targetWidthPx must be a positive finite number`);
    }
    if (
        value.previewRequestId !== undefined
        && (
            typeof value.previewRequestId !== 'string'
            || value.previewRequestId.trim().length === 0
        )
    ) {
        throw new TypeError(`${label}.previewRequestId must be a non-empty string`);
    }

    const previewRequestId = typeof value.previewRequestId === 'string'
        ? value.previewRequestId.trim()
        : undefined;
    const normalized = {
        ...(value.targetWidthPx === undefined ? {} : {targetWidthPx: Math.trunc(value.targetWidthPx)}),
        ...(previewRequestId === undefined ? {} : {previewRequestId}),
    } satisfies IPdfNativePagePreviewOptions;

    return Object.keys(normalized).length > 0 ? normalized : undefined;
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
    if (!isSerializedPdfPersistenceLimits(value)) {
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
            const payload = parsePdfPersistenceMainToPreloadFrame(event.data);
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
            const payload = parsePdfPersistenceMainToPreloadFrame(event.data);
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
            const payload = parsePdfPersistenceMainToPreloadFrame(event.data);
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
            channel.port1.postMessage(createPdfPersistenceChunkFrame(seq, bytes));
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

        channel.port1.postMessage(createPdfPersistenceCompleteFrame());
        return await resultPromise;
    } finally {
        channel.port1.close();
    }
}

export function createDocumentsPreloadFileClient(
    ipcRenderer: TDocumentsFileIpcRenderer,
): TDocumentsPreloadFileClient {
    const invoke = createTypedIpcInvoker<IDocumentsInvokeMap>(ipcRenderer, {invokeTimeoutMsByChannel: DOCUMENTS_NATIVE_INVOKE_TIMEOUT_MS_BY_CHANNEL});
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
        savePdfAs: (workingPath, options, revisionOptions) =>
            invoke(
                DOCUMENTS_CHANNELS.savePdfAs,
                assertAbsolutePath(workingPath, 'savePdfAs.workingPath'),
                assertPdfSaveAsOptions(options, 'savePdfAs.options'),
                assertPdfSerializedSaveOptions(revisionOptions, 'savePdfAs.revisionOptions'),
            ),
        savePdfDataAs: async (workingPath, data, options, serializedSaveOptions) => {
            const checkedWorkingPath = assertAbsolutePath(workingPath, 'savePdfDataAs.workingPath');
            const checkedData = assertPersistenceData(data, 'savePdfDataAs.data');
            const checkedOptions = assertPdfSaveAsOptions(options, 'savePdfDataAs.options');
            const checkedSerializedSaveOptions = assertPdfSerializedSaveOptions(
                serializedSaveOptions,
                'savePdfDataAs.serializedSaveOptions',
            );
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.savePdfDataAsBegin,
                checkedWorkingPath,
                checkedData.byteLength,
                checkedOptions,
                checkedSerializedSaveOptions,
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
        getPdfNativePageSizes: (path) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfNativePageSizes,
                assertAbsolutePath(path, 'getPdfNativePageSizes.path'),
            ),
        cancelPdfNativePagePreview: (requestId) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfNativePagePreviewCancel,
                assertNonEmptyString(requestId, 'cancelPdfNativePagePreview.requestId'),
            ),
        renderPdfNativePagePreview: (path, pageNumber, options) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfNativePagePreview,
                assertAbsolutePath(path, 'renderPdfNativePagePreview.path'),
                assertPositiveInteger(pageNumber, 'renderPdfNativePagePreview.pageNumber'),
                assertPdfNativePagePreviewOptions(options, 'renderPdfNativePagePreview.options'),
            ),
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
        getDocumentRevision: (path) =>
            invoke(
                DOCUMENTS_CHANNELS.documentRevisionGet,
                assertAbsolutePath(path, 'getDocumentRevision.path'),
            ),
        onDocumentRevisionChanged: (callback) => {
            if (
                typeof ipcRenderer.on !== 'function'
                || typeof ipcRenderer.removeListener !== 'function'
            ) {
                return () => undefined;
            }
            const handler = (
                _event: IpcRendererEvent,
                payload: IDocumentRevisionChangedEvent,
            ) => callback(payload);
            ipcRenderer.on(DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged, handler);
            return () => {
                ipcRenderer.removeListener?.(DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged, handler);
            };
        },
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
        writeFile: (path, data, options) =>
            invoke(
                DOCUMENTS_CHANNELS.fileWrite,
                assertAbsolutePath(path, 'writeFile.path'),
                assertWriteData(data, 'writeFile.data'),
                assertPdfSerializedSaveOptions(options, 'writeFile.options'),
            ),
        replaceWorkingCopyFromPath: (workingCopyPath, sourcePath, options) =>
            invoke(
                DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath,
                assertAbsolutePath(workingCopyPath, 'replaceWorkingCopyFromPath.workingCopyPath'),
                assertAbsolutePath(sourcePath, 'replaceWorkingCopyFromPath.sourcePath'),
                assertPdfSerializedSaveOptions(options, 'replaceWorkingCopyFromPath.options'),
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
        saveFileStructured: (path, options) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSaveStructured,
                assertAbsolutePath(path, 'saveFileStructured.path'),
                assertPdfSerializedSaveOptions(options, 'saveFileStructured.options'),
            ),
        resyncWorkingCopy: (path) =>
            invoke(
                DOCUMENTS_CHANNELS.fileResyncWorkingCopy,
                assertAbsolutePath(path, 'resyncWorkingCopy.path'),
            ),
        repairPdf: (path, options) =>
            invoke(
                DOCUMENTS_CHANNELS.fileRepairPdf,
                assertAbsolutePath(path, 'repairPdf.path'),
                assertPdfSerializedSaveOptions(options, 'repairPdf.options'),
            ),
        optimizePdfForInteraction: (path, options) =>
            invoke(
                DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction,
                assertAbsolutePath(path, 'optimizePdfForInteraction.path'),
                assertPdfSerializedSaveOptions(options, 'optimizePdfForInteraction.options'),
            ),
        optimizePdfAsCopy: (path, options, requestId, revisionOptions) =>
            invoke(
                DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy,
                assertAbsolutePath(path, 'optimizePdfAsCopy.path'),
                assertPdfOptimizeOptions(options, 'optimizePdfAsCopy.options'),
                typeof requestId === 'string'
                    ? assertNonEmptyString(requestId, 'optimizePdfAsCopy.requestId', 128)
                    : undefined,
                revisionOptions === undefined
                    ? undefined
                    : assertPdfSerializedSaveOptions(revisionOptions, 'optimizePdfAsCopy.revisionOptions'),
            ),
        savePdfData: async (path, data, options) => {
            const checkedPath = assertAbsolutePath(path, 'savePdfData.path');
            const checkedData = assertPersistenceData(data, 'savePdfData.data');
            const checkedOptions = assertPdfSerializedSaveOptions(options, 'savePdfData.options');
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
                checkedPath,
                checkedData.byteLength,
                checkedOptions,
            );
            const result = await streamPdfBytesToPersistencePort(
                ipcRenderer,
                beginResult,
                iterateUint8ArrayChunks(checkedData),
                checkedData.byteLength,
            );
            return result.validation;
        },
        savePdfDataChunks: async (path, totalBytes, chunks, options) => {
            const checkedPath = assertAbsolutePath(path, 'savePdfDataChunks.path');
            const checkedTotalBytes = assertPositiveSafeInteger(totalBytes, 'savePdfDataChunks.totalBytes');
            const checkedOptions = assertPdfSerializedSaveOptions(options, 'savePdfDataChunks.options');
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
                checkedPath,
                checkedTotalBytes,
                checkedOptions,
            );
            const result = await streamPdfBytesToPersistencePort(ipcRenderer, beginResult, chunks, checkedTotalBytes);
            return result.validation;
        },
        savePdfNoteTextUpdates: (path, updates, modifiedAt, options) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates,
                assertAbsolutePath(path, 'savePdfNoteTextUpdates.path'),
                normalizePdfNativeNoteTextUpdates(updates, 'savePdfNoteTextUpdates.updates'),
                normalizePdfNativeModifiedAt(modifiedAt, 'savePdfNoteTextUpdates.modifiedAt'),
                assertPdfSerializedSaveOptions(options, 'savePdfNoteTextUpdates.options'),
            ),
        savePdfNoteChanges: (path, changes, modifiedAt, options) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNoteChanges,
                assertAbsolutePath(path, 'savePdfNoteChanges.path'),
                normalizePdfNativeNoteChanges(changes, 'savePdfNoteChanges.changes'),
                normalizePdfNativeModifiedAt(modifiedAt, 'savePdfNoteChanges.modifiedAt'),
                assertPdfSerializedSaveOptions(options, 'savePdfNoteChanges.options'),
            ),
        savePdfNativeMutations: (path, mutations, modifiedAt, options) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNativeMutations,
                assertAbsolutePath(path, 'savePdfNativeMutations.path'),
                normalizePdfNativeMutationSet(mutations, 'savePdfNativeMutations.mutations'),
                normalizePdfNativeModifiedAt(modifiedAt, 'savePdfNativeMutations.modifiedAt'),
                assertPdfSerializedSaveOptions(options, 'savePdfNativeMutations.options'),
            ),
        applyPdfNativeMutationsToWorkingCopy: (path, mutations, modifiedAt, expectedBase, options) =>
            invoke(
                DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy,
                assertAbsolutePath(path, 'applyPdfNativeMutationsToWorkingCopy.path'),
                normalizePdfNativeMutationSet(mutations, 'applyPdfNativeMutationsToWorkingCopy.mutations'),
                normalizePdfNativeModifiedAt(modifiedAt, 'applyPdfNativeMutationsToWorkingCopy.modifiedAt'),
                normalizePdfNativeWorkingCopyExpectation(expectedBase, 'applyPdfNativeMutationsToWorkingCopy.expectedBase'),
                assertPdfSerializedSaveOptions(options, 'applyPdfNativeMutationsToWorkingCopy.options'),
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
