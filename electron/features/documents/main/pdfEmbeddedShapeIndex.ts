import {createReadStream} from 'node:fs';
import {
    lstat,
    mkdtemp,
    open,
    readdir,
    rm,
    stat,
} from 'node:fs/promises';
import {join} from 'node:path';
import {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
import type {
    IPdfEmbeddedShapeIndexChunk,
    IPdfEmbeddedShapeIndexChunkOptions,
    IPdfEmbeddedShapeIndexEntry,
    IPdfEmbeddedShapeIndexOptions,
    IPdfEmbeddedShapeIndexPoint,
    IPdfEmbeddedShapeIndexSession,
} from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    createSessionId,
    type TSessionId,
} from '@contracts/shared';
import { parseEpochMs } from '@contracts/timestamps';
import {
    PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES,
} from '@contracts/electronApiDocuments';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {IDocumentsSenderIdContext} from '@electron/features/documents/documentsService';
import {resolveExistingReadablePdfPath} from '@electron/features/documents/main/documentFilePathResolution';
import {
    assertWorkingCopyRevisionCurrent,
    getWorkingCopyRevision,
} from '@electron/file-access/documentRevisionStore';
import {runWithWorkingCopyReadBacking} from '@electron/file-access/runWithWorkingCopyReadBacking';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public/nativePageOpsPath';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {cancelNativeCommandGroup} from '@electron/native-tools/runNativeCommand';
import {registerMainOperation} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {registerNativePdfSenderCleanup} from '@electron/features/documents/main/nativePdfPreview';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

const SHAPE_INDEX_DIRECTORY_PREFIX = 'pdf-embedded-shape-index-';
const SHAPE_INDEX_FILE_NAME = 'index.jsonl';
const SHAPE_INDEX_FORMAT = 'evb-pdf-embedded-shape-index';
const SHAPE_INDEX_SCHEMA_VERSION = 1;
const SHAPE_INDEX_DEFAULT_TTL_MS = 10 * 60 * 1_000;
const SHAPE_INDEX_SWEEP_MAX_ENTRIES = 200;
const SHAPE_INDEX_NATIVE_TIMEOUT_MS = 30 * 60 * 1_000;
const SHAPE_INDEX_NATIVE_STDOUT_BYTES = 64 * 1_024;
const SHAPE_INDEX_NATIVE_STDERR_BYTES = 512 * 1_024;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SHAPE_POINTS = 40_000;
const MAX_SHAPE_STROKES = 4_096;
const logger = createLogger('pdf-embedded-shape-index');

interface IShapeIndexLine {
    offset: number;
    byteLength: number;
}

interface IScannedShapeIndex {
    dataStartOffset: number;
    dataBytes: number;
    pageCount: number;
    entryCount: number;
    lines: IShapeIndexLine[];
}

interface IShapeIndexSessionState {
    sessionId: TSessionId;
    ownerId: number;
    documentRef: TDocumentRef;
    resolvedPath: string;
    expectedRevisionToken: TDocumentRevisionToken;
    sidecarDirectory: string;
    sidecarPath: string;
    index: IScannedShapeIndex;
    abortController: AbortController;
    cancelGroup: string;
    operationPromise: Promise<void>;
    lastTouchedAt: number;
    canceled: boolean;
    released: boolean;
    unregisterSenderCleanup?: () => void;
    cleanupPromise?: Promise<void>;
}

const sessions = new Map<TSessionId, IShapeIndexSessionState>();

function getOwnerId(context: IDocumentsSenderIdContext) {
    return context.senderId ?? -1;
}

function addSafeOffsets(left: number, right: number, fieldName: string) {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new RangeError(`${fieldName} exceeds the safe integer range`);
    }
    return result;
}

function assertSafeOffset(value: number, fieldName: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${fieldName} must be a non-negative safe integer`);
    }
    return value;
}

function decodeHeader(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('Embedded shape index sidecar is missing its JSONL header');
    }
    if (
        value.format !== SHAPE_INDEX_FORMAT
        || value.schemaVersion !== SHAPE_INDEX_SCHEMA_VERSION
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
    ) {
        throw new Error('Embedded shape index sidecar has an unsupported header');
    }
    if (value.chunkBytes !== undefined && (
        typeof value.chunkBytes !== 'number'
        || !Number.isSafeInteger(value.chunkBytes)
        || value.chunkBytes < 1
        || value.chunkBytes > PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES
    )) {
        throw new Error('Embedded shape index sidecar header has an invalid chunk size');
    }
    return value.pageCount;
}

function decodeSafeInteger(value: unknown, fieldName: string, min = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function decodeFiniteNumber(value: unknown, fieldName: string, min?: number) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (min !== undefined && value < min)) {
        throw new Error(`${fieldName} must be a finite number`);
    }
    return value;
}

function decodeOptionalFiniteNumber(value: unknown, fieldName: string) {
    return value === undefined || value === null
        ? null
        : decodeFiniteNumber(value, fieldName);
}

function decodeOptionalString(value: unknown, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty string or null`);
    }
    return value;
}

function decodeOptionalTimestamp(value: unknown, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    const timestamp = parseEpochMs(value);
    if (timestamp === null) {
        throw new Error(`${fieldName} must be an epoch millisecond timestamp`);
    }
    return timestamp;
}

function decodeOptionalEnum<T extends string>(
    value: unknown,
    values: readonly T[],
    fieldName: string,
) {
    if (value === undefined || value === null) {
        return null;
    }
    if (!isOneOf(values, value)) {
        throw new Error(`${fieldName} is unsupported`);
    }
    return value;
}

function decodePoint(value: unknown, fieldName: string): IPdfEmbeddedShapeIndexPoint {
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be an object`);
    }
    return {
        x: decodeFiniteNumber(value.x, `${fieldName}.x`),
        y: decodeFiniteNumber(value.y, `${fieldName}.y`),
    };
}

function decodePoints(value: unknown, fieldName: string): IPdfEmbeddedShapeIndexPoint[] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length > MAX_SHAPE_POINTS) {
        throw new Error(`${fieldName} contains too many points`);
    }
    return value.map((point, index) => decodePoint(point, `${fieldName}[${index}]`));
}

function decodeStrokes(value: unknown): IPdfEmbeddedShapeIndexPoint[][] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length > MAX_SHAPE_STROKES) {
        throw new Error('Embedded shape index strokes contain too many strokes');
    }
    return value.map((stroke, index) => decodePoints(
        stroke,
        `embedded shape index strokes[${index}]`,
    ) ?? []);
}

function decodeShapeEntry(value: unknown): IPdfEmbeddedShapeIndexEntry {
    if (!isRecord(value)) {
        throw new Error('Embedded shape index entry must be an object');
    }
    const pdfSubtype = decodeOptionalEnum(
        value.pdfSubtype,
        PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
        'Embedded shape index entry pdfSubtype',
    );
    if (pdfSubtype === null) {
        throw new Error('Embedded shape index entry has an unsupported PDF subtype');
    }
    const type = decodeOptionalEnum(
        value.type,
        PDF_ANNOTATION_SHAPE_TYPES,
        'Embedded shape index entry type',
    );
    if (type === null) {
        throw new Error('Embedded shape index entry has an unsupported shape type');
    }
    const lineStartStyle = decodeOptionalEnum(
        value.lineStartStyle,
        PDF_ANNOTATION_LINE_END_STYLES,
        'Embedded shape index entry lineStartStyle',
    );
    const lineEndStyle = decodeOptionalEnum(
        value.lineEndStyle,
        PDF_ANNOTATION_LINE_END_STYLES,
        'Embedded shape index entry lineEndStyle',
    );
    return {
        pageIndex: decodeSafeInteger(value.pageIndex, 'Embedded shape index entry pageIndex') as IPdfEmbeddedShapeIndexEntry['pageIndex'],
        objectNumber: decodeSafeInteger(value.objectNumber, 'Embedded shape index entry objectNumber', 1),
        generationNumber: decodeSafeInteger(value.generationNumber, 'Embedded shape index entry generationNumber'),
        stableKey: decodeOptionalString(value.stableKey, 'Embedded shape index entry stableKey'),
        pdfSubtype,
        type,
        x: decodeFiniteNumber(value.x, 'Embedded shape index entry x'),
        y: decodeFiniteNumber(value.y, 'Embedded shape index entry y'),
        width: decodeFiniteNumber(value.width, 'Embedded shape index entry width', 0),
        height: decodeFiniteNumber(value.height, 'Embedded shape index entry height', 0),
        x2: decodeOptionalFiniteNumber(value.x2, 'Embedded shape index entry x2'),
        y2: decodeOptionalFiniteNumber(value.y2, 'Embedded shape index entry y2'),
        color: typeof value.color === 'string' ? value.color : (() => { throw new Error('Embedded shape index entry color must be a string'); })(),
        fillColor: decodeOptionalString(value.fillColor, 'Embedded shape index entry fillColor'),
        opacity: decodeFiniteNumber(value.opacity, 'Embedded shape index entry opacity', 0),
        strokeWidth: decodeFiniteNumber(value.strokeWidth, 'Embedded shape index entry strokeWidth', 0),
        points: decodePoints(value.points, 'Embedded shape index entry points'),
        strokes: decodeStrokes(value.strokes),
        lineStartStyle,
        lineEndStyle,
        createdAt: decodeOptionalTimestamp(value.createdAt, 'Embedded shape index entry createdAt'),
        modifiedAt: decodeOptionalTimestamp(value.modifiedAt, 'Embedded shape index entry modifiedAt'),
    };
}

function decodeDataLine(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.entries)) {
        throw new Error('Embedded shape index sidecar line must contain entries');
    }
    return value.entries.map(decodeShapeEntry);
}

function parseJsonLine(bytes: Buffer, label: string) {
    const withoutNewline = bytes[bytes.length - 1] === 0x0a
        ? bytes.subarray(0, bytes.length - 1)
        : bytes;
    const jsonBytes = withoutNewline[withoutNewline.length - 1] === 0x0d
        ? withoutNewline.subarray(0, withoutNewline.length - 1)
        : withoutNewline;
    if (jsonBytes.length === 0) {
        throw new Error(`Embedded shape index sidecar contains an empty ${label} line`);
    }
    try {
        return JSON.parse(jsonBytes.toString('utf8')) as unknown;
    } catch (error) {
        throw new Error(`Embedded shape index sidecar contains invalid JSON in its ${label} line`, {cause: error});
    }
}

function scanSidecarLines(sidecarPath: string): Promise<IScannedShapeIndex> {
    return new Promise((resolveScan, rejectScan) => {
        const lines: IShapeIndexLine[] = [];
        let stream: ReturnType<typeof createReadStream> | null = null;
        let pending = Buffer.alloc(0) as Buffer;
        let pendingStartOffset = 0;
        let dataStartOffset = 0;
        let totalBytes = 0;
        let pageCount: number | null = null;
        let entryCount = 0;
        let headerSeen = false;
        let settled = false;

        const rejectOnce = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            stream?.destroy();
            rejectScan(error);
        };
        const processLine = (line: Buffer, offset: number) => {
            if (line.length === 0 || line.length > PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES) {
                throw new Error(`Embedded shape index sidecar line exceeds ${PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES} bytes`);
            }
            const value = parseJsonLine(line, headerSeen ? 'data' : 'header');
            if (!headerSeen) {
                pageCount = decodeHeader(value);
                dataStartOffset = addSafeOffsets(offset, line.length, 'Embedded shape index offset');
                headerSeen = true;
                return;
            }
            const entries = decodeDataLine(value);
            entryCount = addSafeOffsets(entryCount, entries.length, 'Embedded shape index entry count');
            lines.push({
                offset: addSafeOffsets(offset, -dataStartOffset, 'Embedded shape index offset'),
                byteLength: line.length,
            });
        };
        const consume = (chunk: Buffer) => {
            totalBytes = addSafeOffsets(totalBytes, chunk.length, 'Embedded shape index sidecar size');
            pending = pending.length === 0 ? chunk : Buffer.concat([
                pending,
                chunk,
            ]);
            if (pending.length > PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES && pending.indexOf(0x0a) < 0) {
                throw new Error(`Embedded shape index sidecar line exceeds ${PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES} bytes`);
            }
            let newlineIndex = pending.indexOf(0x0a);
            while (newlineIndex >= 0) {
                const lineLength = newlineIndex + 1;
                processLine(pending.subarray(0, lineLength), pendingStartOffset);
                pendingStartOffset = addSafeOffsets(pendingStartOffset, lineLength, 'Embedded shape index offset');
                pending = pending.subarray(lineLength);
                newlineIndex = pending.indexOf(0x0a);
            }
            if (pending.length > PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES) {
                throw new Error(`Embedded shape index sidecar line exceeds ${PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES} bytes`);
            }
        };

        stream = createReadStream(sidecarPath, {highWaterMark: 64 * 1_024});
        stream.on('data', (chunk: Buffer | string) => {
            try {
                consume(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            } catch (error) {
                rejectOnce(error);
            }
        });
        stream.once('error', rejectOnce);
        stream.once('end', () => {
            if (settled) {
                return;
            }
            try {
                if (pending.length > 0) {
                    processLine(pending, pendingStartOffset);
                    pendingStartOffset = addSafeOffsets(pendingStartOffset, pending.length, 'Embedded shape index offset');
                }
                if (pageCount === null) {
                    throw new Error('Embedded shape index sidecar is empty');
                }
                if (pendingStartOffset !== totalBytes) {
                    throw new Error('Embedded shape index sidecar offset accounting failed');
                }
                settled = true;
                resolveScan({
                    dataStartOffset,
                    dataBytes: addSafeOffsets(totalBytes, -dataStartOffset, 'Embedded shape index bytes'),
                    pageCount,
                    entryCount,
                    lines,
                });
            } catch (error) {
                rejectOnce(error);
            }
        });
    });
}

function parseChunkOptions(options: IPdfEmbeddedShapeIndexChunkOptions | undefined) {
    const chunkBytes = options?.chunkBytes ?? PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES;
    if (
        !Number.isSafeInteger(chunkBytes)
        || chunkBytes < 1
        || chunkBytes > PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES
    ) {
        throw new RangeError(`Embedded shape index chunkBytes must be between 1 and ${PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES}`);
    }
    return chunkBytes;
}

function findLineIndex(lines: readonly IShapeIndexLine[], offset: number) {
    let low = 0;
    let high = lines.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const line = lines[middle]!;
        if (line.offset === offset) {
            return middle;
        }
        if (line.offset < offset) low = middle + 1;
        else high = middle - 1;
    }
    return -1;
}

function assertSessionOwner(session: IShapeIndexSessionState, context: IDocumentsSenderIdContext) {
    if (session.ownerId !== getOwnerId(context)) {
        throw new Error('Embedded shape index session belongs to another sender');
    }
}

function cancelSession(session: IShapeIndexSessionState, reason: string) {
    session.canceled = true;
    if (!session.abortController.signal.aborted) {
        session.abortController.abort(new Error(reason));
    }
    cancelNativeCommandGroup(session.cancelGroup);
}

function cleanupWhenOperationSettles(session: IShapeIndexSessionState) {
    void session.operationPromise
        .catch(() => undefined)
        .then(() => cleanupSession(session));
}

async function cleanupSession(session: IShapeIndexSessionState) {
    if (session.cleanupPromise) {
        return session.cleanupPromise;
    }
    sessions.delete(session.sessionId);
    session.unregisterSenderCleanup?.();
    delete session.unregisterSenderCleanup;
    session.cleanupPromise = rm(session.sidecarDirectory, {
        force: true,
        recursive: true,
    })
        .catch((error: unknown) => {
            logger.warn(`Failed to remove embedded shape index sidecar: ${String(error)}`);
        });
    return session.cleanupPromise;
}

/** Keep the native verb and argument order in one helper for CLI alignment. */
function buildPdfEmbeddedShapeIndexCommandArgs(inputPath: string, outputPath: string, qpdfPath: string) {
    return [
        'embedded-shape-index',
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--qpdf',
        qpdfPath,
    ];
}

async function runEmbeddedShapeIndexNative(
    inputPath: string,
    outputPath: string,
    signal: AbortSignal,
    cancelGroup: string,
) {
    if (isNativePageOpsDisabled()) {
        throw new Error('Cannot build an embedded shape index while native page operations are disabled');
    }
    const nativePath = resolveNativePageOpsPath();
    if (!nativePath) {
        throw new Error('Cannot build an embedded shape index because the native page tool is unavailable');
    }
    await runNativeToolCommand(
        nativePath,
        buildPdfEmbeddedShapeIndexCommandArgs(inputPath, outputPath, getPdfNativeToolPaths().qpdf),
        {
            timeoutMs: SHAPE_INDEX_NATIVE_TIMEOUT_MS,
            maxStdoutBytes: SHAPE_INDEX_NATIVE_STDOUT_BYTES,
            maxStderrBytes: SHAPE_INDEX_NATIVE_STDERR_BYTES,
            rejectOnStdoutTruncation: true,
            commandLabel: 'evb-pdf-page-ops(embedded-shape-index)',
            signal,
            cancelGroup,
        },
    );
}

export async function beginPdfEmbeddedShapeIndex(
    context: IDocumentsSenderIdContext,
    filePath: TDocumentRef,
    options: IPdfEmbeddedShapeIndexOptions,
): Promise<IPdfEmbeddedShapeIndexSession> {
    const expectedRevisionToken = parseDocumentRevisionToken(options.expectedDocumentRevisionToken);
    if (expectedRevisionToken === null) {
        throw new Error('Document revision token is required to build an embedded shape index');
    }
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, context.senderId);
    const revision = await getWorkingCopyRevision(resolvedPath, context.senderId);
    if (revision.token !== expectedRevisionToken) {
        throw createStaleRevisionError({
            documentRef: filePath,
            expectedRevision: expectedRevisionToken,
            actualRevision: revision.token,
        });
    }
    await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);

    const sessionId = createSessionId('pdf-embedded-shape-index');
    const sidecarDirectory = await mkdtemp(join(getAppTempDir(), SHAPE_INDEX_DIRECTORY_PREFIX));
    const sidecarPath = join(sidecarDirectory, SHAPE_INDEX_FILE_NAME);
    const abortController = new AbortController();
    const session: IShapeIndexSessionState = {
        sessionId,
        ownerId: getOwnerId(context),
        documentRef: filePath,
        resolvedPath,
        expectedRevisionToken,
        sidecarDirectory,
        sidecarPath,
        index: {
            dataStartOffset: 0,
            dataBytes: 0,
            pageCount: 0,
            entryCount: 0,
            lines: [],
        },
        abortController,
        cancelGroup: `pdf-embedded-shape-index:${sessionId}`,
        operationPromise: Promise.resolve(),
        lastTouchedAt: Date.now(),
        canceled: false,
        released: false,
    };
    sessions.set(sessionId, session);

    const cancel = (reason: string) => cancelSession(session, reason);
    let mainOperation: ReturnType<typeof registerMainOperation>;
    try {
        mainOperation = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: context.senderId,
            workingCopyPath: resolvedPath,
            cancel,
        });
    } catch (error) {
        await cleanupSession(session);
        throw error;
    }
    session.cancelGroup = `pdf-embedded-shape-index:${mainOperation.id}`;
    session.unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancel,
        'Renderer navigation canceled embedded shape indexing',
    );
    const handleMainAbort = () => cancel('Embedded shape indexing canceled');
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    session.operationPromise = (async () => {
        try {
            await runWithWorkingCopyReadBacking(
                resolvedPath,
                physicalPath => runEmbeddedShapeIndexNative(
                    physicalPath,
                    sidecarPath,
                    abortController.signal,
                    session.cancelGroup,
                ),
                context.senderId === undefined ? {} : {ownerWebContentsId: context.senderId},
            );
            if (abortController.signal.aborted) {
                throw abortErrorFromSignal(abortController.signal);
            }
            await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);
            const sidecarStat = await stat(sidecarPath, {bigint: true});
            if (sidecarStat.size > MAX_SAFE_INTEGER_BIGINT) {
                throw new Error('Embedded shape index sidecar exceeds the safe offset range');
            }
            session.index = await scanSidecarLines(sidecarPath);
            if (session.index.dataBytes !== Number(sidecarStat.size) - session.index.dataStartOffset) {
                throw new Error('Embedded shape index sidecar changed while it was being indexed');
            }
            session.lastTouchedAt = Date.now();
        } catch (error) {
            session.canceled = session.canceled || abortController.signal.aborted;
            throw error;
        } finally {
            mainOperation.signal.removeEventListener('abort', handleMainAbort);
            mainOperation.complete();
            if (session.canceled || session.released) {
                await cleanupSession(session);
            }
        }
    })();

    try {
        await session.operationPromise;
    } catch (error) {
        await cleanupSession(session);
        throw error;
    }
    return {
        sessionId,
        documentRef: filePath,
        documentRevisionToken: expectedRevisionToken,
        pageCount: session.index.pageCount,
        entryCount: session.index.entryCount,
        totalBytes: session.index.dataBytes,
    };
}

export async function readPdfEmbeddedShapeIndexChunk(
    context: IDocumentsSenderIdContext,
    sessionId: TSessionId,
    offset: number,
    options?: IPdfEmbeddedShapeIndexChunkOptions,
): Promise<IPdfEmbeddedShapeIndexChunk> {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error('Embedded shape index session is not available');
    }
    assertSessionOwner(session, context);
    if (session.canceled || session.released) {
        throw new Error('Embedded shape index session is canceled');
    }
    const requestedOffset = assertSafeOffset(offset, 'offset');
    const chunkBytes = parseChunkOptions(options);
    if (requestedOffset === session.index.dataBytes) {
        session.lastTouchedAt = Date.now();
        return {
            offset: requestedOffset,
            nextOffset: null,
            byteLength: 0,
            done: true,
            entries: [],
        };
    }
    const lineIndex = findLineIndex(session.index.lines, requestedOffset);
    if (lineIndex < 0) {
        throw new RangeError('Embedded shape index offset must point to the beginning of a chunk line');
    }
    const line = session.index.lines[lineIndex]!;
    if (line.byteLength > chunkBytes) {
        throw new RangeError(`Embedded shape index line requires a chunk of at least ${line.byteLength} bytes`);
    }
    const absoluteOffset = addSafeOffsets(session.index.dataStartOffset, requestedOffset, 'Embedded shape index offset');
    const lineBytes = Buffer.allocUnsafe(line.byteLength);
    const sidecarHandle = await open(session.sidecarPath, 'r');
    try {
        let bytesRead = 0;
        while (bytesRead < line.byteLength) {
            const readResult = await sidecarHandle.read(
                lineBytes,
                bytesRead,
                line.byteLength - bytesRead,
                absoluteOffset + bytesRead,
            );
            if (readResult.bytesRead === 0) {
                throw new Error('Embedded shape index sidecar ended before the requested chunk');
            }
            bytesRead += readResult.bytesRead;
        }
    } finally {
        await sidecarHandle.close();
    }
    const entries = decodeDataLine(parseJsonLine(lineBytes, 'data'));
    const nextOffset = lineIndex + 1 < session.index.lines.length
        ? addSafeOffsets(line.offset, line.byteLength, 'Embedded shape index offset')
        : null;
    session.lastTouchedAt = Date.now();
    return {
        offset: requestedOffset,
        nextOffset,
        byteLength: line.byteLength,
        done: nextOffset === null,
        entries,
    };
}

export async function releasePdfEmbeddedShapeIndex(
    context: IDocumentsSenderIdContext,
    sessionId: TSessionId,
) {
    const session = sessions.get(sessionId);
    if (!session) {
        return false;
    }
    assertSessionOwner(session, context);
    session.released = true;
    if (!session.abortController.signal.aborted) {
        cancelSession(session, 'Embedded shape index released');
    }
    await session.operationPromise.catch(() => undefined);
    await cleanupSession(session);
    return true;
}

export function cancelPdfEmbeddedShapeIndex(
    context: IDocumentsSenderIdContext,
    sessionId: TSessionId,
) {
    const session = sessions.get(sessionId);
    if (!session) {
        return Promise.resolve({canceled: false});
    }
    assertSessionOwner(session, context);
    if (session.canceled || session.released) {
        return Promise.resolve({canceled: false});
    }
    cancelSession(session, 'Embedded shape index canceled');
    cleanupWhenOperationSettles(session);
    return Promise.resolve({canceled: true});
}

export async function sweepStalePdfEmbeddedShapeIndexArtifacts(
    maxAgeMs = SHAPE_INDEX_DEFAULT_TTL_MS,
    maxEntries = SHAPE_INDEX_SWEEP_MAX_ENTRIES,
) {
    const tempDir = getAppTempDir();
    const now = Date.now();
    const activeDirectories = new Set([...sessions.values()].map(session => session.sidecarDirectory));
    let entries: string[];
    try {
        entries = await readdir(tempDir);
    } catch {
        return 0;
    }
    let deletedCount = 0;
    for (const entry of entries
        .filter(name => name.startsWith(SHAPE_INDEX_DIRECTORY_PREFIX))
        .slice(0, maxEntries)) {
        const directoryPath = join(tempDir, entry);
        if (activeDirectories.has(directoryPath)) continue;
        try {
            const directoryStat = await lstat(directoryPath);
            if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
            if (now - Math.floor(Math.max(directoryStat.mtimeMs, directoryStat.ctimeMs)) < maxAgeMs) continue;
            await rm(directoryPath, {
                force: true,
                recursive: true,
            });
            deletedCount += 1;
        } catch (error) {
            logger.warn(`Failed to sweep stale embedded shape index artifact "${directoryPath}": ${String(error)}`);
        }
    }
    return deletedCount;
}

const shapeIndexTtlTimer = setInterval(() => {
    const cutoff = Date.now() - SHAPE_INDEX_DEFAULT_TTL_MS;
    for (const session of sessions.values()) {
        if (session.lastTouchedAt >= cutoff) continue;
        session.released = true;
        cancelSession(session, 'Embedded shape index session expired');
        cleanupWhenOperationSettles(session);
    }
    void sweepStalePdfEmbeddedShapeIndexArtifacts().catch((error: unknown) => {
        logger.debug(`Embedded shape index TTL sweep failed: ${String(error)}`);
    });
}, 30_000);
shapeIndexTtlTimer.unref();
