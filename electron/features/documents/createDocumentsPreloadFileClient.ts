import type { IpcRenderer } from 'electron';
import type {
    IDocumentsFileCapability,
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeFreeTextNoteMarkerRect,
} from '@contracts/electronApiDocuments';
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
const PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS = 2;
const PDF_PERSISTENCE_READY_TIMEOUT_MS = 10_000;
const PDF_PERSISTENCE_ACK_TIMEOUT_MS = 60_000;
const PDF_NOTE_TEXT_MAX_UPDATES = 256;
const PDF_NATIVE_NOTE_MAX_CHANGES = 256;
const PDF_DATE_PATTERN = /^D:\d{14}(?:Z|[+-]\d{2}'\d{2}')?$/u;

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

function assertPdfNoteTextUpdates(
    value: unknown,
    label: string,
    options: {allowEmpty?: boolean} = {},
) {
    if (
        !Array.isArray(value)
        || (!options.allowEmpty && value.length === 0)
        || value.length > PDF_NOTE_TEXT_MAX_UPDATES
    ) {
        const emptyDescription = options.allowEmpty ? 'an array' : 'a non-empty array';
        throw new TypeError(`${label} must be ${emptyDescription} with at most ${PDF_NOTE_TEXT_MAX_UPDATES} updates`);
    }

    return value.map((update, index) => {
        if (!isRecord(update)) {
            throw new TypeError(`${label}[${index}] must be an object`);
        }
        const objectNumber = update.objectNumber;
        const generationNumber = update.generationNumber;
        const text = update.text;
        if (typeof objectNumber !== 'number' || !Number.isSafeInteger(objectNumber) || objectNumber < 1) {
            throw new TypeError(`${label}[${index}].objectNumber must be a positive safe integer`);
        }
        if (
            typeof generationNumber !== 'number'
            || !Number.isSafeInteger(generationNumber)
            || generationNumber < 0
            || generationNumber > 65_535
        ) {
            throw new TypeError(`${label}[${index}].generationNumber must be an integer from 0 to 65535`);
        }
        if (typeof text !== 'string') {
            throw new TypeError(`${label}[${index}].text must be a string`);
        }
        return {
            objectNumber,
            generationNumber,
            text,
        };
    });
}

function assertPdfDateString(value: unknown, label: string) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!PDF_DATE_PATTERN.test(normalized)) {
        throw new TypeError(`${label} must be a PDF date string`);
    }
    return normalized;
}

function assertFiniteUnitNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`${label} must be a finite number from 0 to 1`);
    }
    return value;
}

function assertPdfNativeFreeTextNoteMarkerRect(value: unknown, label: string): IPdfNativeFreeTextNoteMarkerRect {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const left = assertFiniteUnitNumber(value.left, `${label}.left`);
    const top = assertFiniteUnitNumber(value.top, `${label}.top`);
    const width = assertFiniteUnitNumber(value.width, `${label}.width`);
    const height = assertFiniteUnitNumber(value.height, `${label}.height`);
    if (width <= 0 || height <= 0 || left + width > 1 || top + height > 1) {
        throw new TypeError(`${label} must fit inside the normalized page bounds`);
    }
    return {
        left,
        top,
        width,
        height,
    };
}

function assertOptionalString(value: unknown, label: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string or null`);
    }
    return value;
}

function assertOptionalTimestamp(value: unknown, label: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${label} must be a finite positive timestamp or null`);
    }
    return Math.trunc(value);
}

function assertPdfNativeFreeTextNotes(value: unknown, label: string) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_NOTE_MAX_CHANGES) {
        throw new TypeError(`${label} must be an array with at most ${PDF_NATIVE_NOTE_MAX_CHANGES} notes`);
    }

    return value.map((note, index): IPdfNativeFreeTextNote => {
        if (!isRecord(note)) {
            throw new TypeError(`${label}[${index}] must be an object`);
        }
        if (
            typeof note.pageIndex !== 'number'
            || !Number.isSafeInteger(note.pageIndex)
            || note.pageIndex < 0
        ) {
            throw new TypeError(`${label}[${index}].pageIndex must be a non-negative safe integer`);
        }
        const stableKey = typeof note.stableKey === 'string' ? note.stableKey.trim() : '';
        if (!stableKey) {
            throw new TypeError(`${label}[${index}].stableKey must be a non-empty string`);
        }
        if (typeof note.text !== 'string') {
            throw new TypeError(`${label}[${index}].text must be a string`);
        }
        return {
            pageIndex: note.pageIndex,
            stableKey,
            text: note.text,
            markerRect: assertPdfNativeFreeTextNoteMarkerRect(note.markerRect, `${label}[${index}].markerRect`),
            author: assertOptionalString(note.author, `${label}[${index}].author`),
            color: assertOptionalString(note.color, `${label}[${index}].color`),
            createdAt: assertOptionalTimestamp(note.createdAt, `${label}[${index}].createdAt`),
        };
    });
}

function assertPdfNativeAnnotationDeletes(value: unknown, label: string) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_NOTE_MAX_CHANGES) {
        throw new TypeError(`${label} must be an array with at most ${PDF_NATIVE_NOTE_MAX_CHANGES} deletes`);
    }

    return value.map((item, index): IPdfNativeAnnotationDelete => {
        if (!isRecord(item)) {
            throw new TypeError(`${label}[${index}] must be an object`);
        }
        const stableKey = typeof item.stableKey === 'string' ? item.stableKey.trim() : '';
        const hasRef = item.objectNumber !== undefined || item.generationNumber !== undefined;
        const hasValidRef = typeof item.objectNumber === 'number'
            && Number.isSafeInteger(item.objectNumber)
            && item.objectNumber >= 1
            && typeof item.generationNumber === 'number'
            && Number.isSafeInteger(item.generationNumber)
            && item.generationNumber >= 0
            && item.generationNumber <= 65_535;
        const createdAt = item.createdAt === undefined || item.createdAt === null
            ? null
            : item.createdAt;
        if (
            typeof item.pageIndex !== 'number'
            || !Number.isSafeInteger(item.pageIndex)
            || item.pageIndex < 0
            || (hasRef && !hasValidRef)
            || (!hasValidRef && !stableKey)
            || (createdAt !== null && (
                typeof createdAt !== 'number'
                || !Number.isFinite(createdAt)
                || createdAt < 0
            ))
        ) {
            throw new TypeError(`${label}[${index}] must contain a valid pageIndex and either a PDF object ref or stableKey`);
        }
        const normalizedDelete = {
            pageIndex: item.pageIndex,
            ...(stableKey ? {stableKey} : {}),
            ...(createdAt !== null ? {createdAt: Math.trunc(createdAt)} : {}),
        };
        if (!hasValidRef) {
            return normalizedDelete;
        }
        return {
            ...normalizedDelete,
            objectNumber: item.objectNumber as number,
            generationNumber: item.generationNumber as number,
        };
    });
}

function assertPdfNativeNoteChanges(
    value: unknown,
    label: string,
): NonNullable<Parameters<NonNullable<IDocumentsFileCapability['savePdfNoteChanges']>>[1]> {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const updates = value.updates === undefined
        ? []
        : assertPdfNoteTextUpdates(value.updates, `${label}.updates`, {allowEmpty: true});
    const freeTextNotes = assertPdfNativeFreeTextNotes(value.freeTextNotes, `${label}.freeTextNotes`);
    const deletes = assertPdfNativeAnnotationDeletes(value.deletes, `${label}.deletes`);
    if (updates.length + freeTextNotes.length + deletes.length === 0) {
        throw new TypeError(`${label} must include at least one note change`);
    }
    if (updates.length + freeTextNotes.length + deletes.length > PDF_NATIVE_NOTE_MAX_CHANGES) {
        throw new TypeError(`${label} must include at most ${PDF_NATIVE_NOTE_MAX_CHANGES} note changes`);
    }
    return {
        ...(updates.length > 0 ? {updates} : {}),
        ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
        ...(deletes.length > 0 ? {deletes} : {}),
    };
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
        && (value.tool === 'qpdf' || value.tool === 'browser' || value.tool === 'native')
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
        const inFlightAcks: Array<Promise<void>> = [];
        for (let offset = 0; offset < data.byteLength; offset += PDF_PERSISTENCE_CHUNK_BYTES) {
            const end = Math.min(offset + PDF_PERSISTENCE_CHUNK_BYTES, data.byteLength);
            const bytes = data.slice(offset, end);
            channel.port1.postMessage({
                type: 'chunk',
                seq,
                bytes,
            });
            inFlightAcks.push(waitForPortAck(channel.port1, seq));
            if (inFlightAcks.length >= PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS) {
                await inFlightAcks.shift();
            }
            seq += 1;
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
        savePdfAs: (workingPath) => invoke(DOCUMENTS_CHANNELS.savePdfAs, workingPath),
        savePdfDataAs: async (workingPath, data) => {
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
        savePdfDialog: (suggestedName) => invoke(DOCUMENTS_CHANNELS.savePdfDialog, suggestedName),
        saveDocxAs: (workingPath) => invoke(DOCUMENTS_CHANNELS.saveDocxAs, workingPath),
        readFile: (path) => invoke(DOCUMENTS_CHANNELS.fileRead, path),
        statFile: (path) => invoke(DOCUMENTS_CHANNELS.fileStat, path),
        readFileRange: (path, offset, length) =>
            invoke(DOCUMENTS_CHANNELS.fileReadRange, path, offset, length),
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
        savePdfData: async (path, data) => {
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
        savePdfNoteTextUpdates: (path, updates, modifiedAt) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates,
                assertAbsolutePath(path, 'savePdfNoteTextUpdates.path'),
                assertPdfNoteTextUpdates(updates, 'savePdfNoteTextUpdates.updates'),
                assertPdfDateString(modifiedAt, 'savePdfNoteTextUpdates.modifiedAt'),
            ),
        savePdfNoteChanges: (path, changes, modifiedAt) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNoteChanges,
                assertAbsolutePath(path, 'savePdfNoteChanges.path'),
                assertPdfNativeNoteChanges(changes, 'savePdfNoteChanges.changes'),
                assertPdfDateString(modifiedAt, 'savePdfNoteChanges.modifiedAt'),
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
