import {randomUUID} from 'node:crypto';
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
import type {
    IPdfAnnotationIndexChunk,
    IPdfAnnotationIndexChunkOptions,
    IPdfAnnotationIndexEntry,
    IPdfAnnotationIndexObjectRef,
    IPdfAnnotationIndexOptions,
    IPdfAnnotationIndexSession,
} from '@contracts/electronApiDocuments';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';
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
import {isRecord} from '@contracts/runtimeGuards';

const ANNOTATION_INDEX_DIRECTORY_PREFIX = 'pdf-annotation-index-';
const ANNOTATION_INDEX_FILE_NAME = 'index.jsonl';
const ANNOTATION_INDEX_FORMATS = new Set([
    'evb-pdf-annotation-index',
    'evb-pdf-annotation-name-index',
]);
const ANNOTATION_INDEX_SCHEMA_VERSION = 1;
const ANNOTATION_INDEX_LINE_MAX_BYTES = PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES;
const ANNOTATION_INDEX_DEFAULT_TTL_MS = 10 * 60 * 1_000;
const ANNOTATION_INDEX_SWEEP_MAX_ENTRIES = 200;
const ANNOTATION_INDEX_NATIVE_TIMEOUT_MS = 30 * 60 * 1_000;
const ANNOTATION_INDEX_NATIVE_STDOUT_BYTES = 64 * 1_024;
const ANNOTATION_INDEX_NATIVE_STDERR_BYTES = 512 * 1_024;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const logger = createLogger('pdf-annotation-index');

interface IAnnotationIndexLine {
    offset: number;
    byteLength: number;
}

interface IScannedAnnotationIndex {
    dataStartOffset: number;
    dataBytes: number;
    pageCount: number;
    entryCount: number;
    lines: IAnnotationIndexLine[];
}

interface IAnnotationIndexSessionState {
    sessionId: string;
    ownerId: number;
    documentRef: string;
    resolvedPath: string;
    expectedRevisionToken: TDocumentRevisionToken;
    sidecarDirectory: string;
    sidecarPath: string;
    index: IScannedAnnotationIndex;
    abortController: AbortController;
    cancelGroup: string;
    operationPromise: Promise<void>;
    lastTouchedAt: number;
    canceled: boolean;
    released: boolean;
    cleanupPromise?: Promise<void>;
}

const sessions = new Map<string, IAnnotationIndexSessionState>();

function getOwnerId(context: IDocumentsSenderIdContext) {
    return context.senderId ?? -1;
}

function assertSafeOffset(value: number, fieldName: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${fieldName} must be a non-negative safe integer`);
    }
    return value;
}

function addSafeOffsets(left: number, right: number, fieldName: string) {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new RangeError(`${fieldName} exceeds the safe integer range`);
    }
    return result;
}

function decodeHeader(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('PDF annotation index sidecar is missing its JSONL header');
    }
    const format = typeof value.format === 'string' ? value.format : '';
    const schemaVersion = value.schemaVersion;
    if (
        !ANNOTATION_INDEX_FORMATS.has(format)
        || !Number.isSafeInteger(schemaVersion)
        || schemaVersion !== ANNOTATION_INDEX_SCHEMA_VERSION
    ) {
        throw new Error('PDF annotation index sidecar has an unsupported header');
    }
    const pageCount = value.pageCount;
    if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < 0) {
        throw new Error('PDF annotation index sidecar header has an invalid page count');
    }
    if (value.chunkBytes !== undefined && (
        typeof value.chunkBytes !== 'number'
        || !Number.isSafeInteger(value.chunkBytes)
        || value.chunkBytes < 1
        || value.chunkBytes > ANNOTATION_INDEX_LINE_MAX_BYTES
    )) {
        throw new Error('PDF annotation index sidecar header has an invalid chunk size');
    }
    return {pageCount};
}

function decodeObjectRef(value: unknown, fieldName: string): IPdfAnnotationIndexObjectRef | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value === 'string') {
        const match = /^(\d+)\s+(\d+)\s+R$/u.exec(value.trim());
        if (!match) {
            throw new Error(`${fieldName} must be a PDF object reference`);
        }
        const objectNumber = Number(match[1]);
        const generationNumber = Number(match[2]);
        if (!Number.isSafeInteger(objectNumber) || objectNumber < 1 || !Number.isSafeInteger(generationNumber)) {
            throw new Error(`${fieldName} contains an unsafe PDF object reference`);
        }
        return {
            objectNumber,
            generationNumber,
        };
    }
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be an object or null`);
    }
    const objectNumber = value.objectNumber;
    const generationNumber = value.generationNumber;
    if (
        typeof objectNumber !== 'number'
        || !Number.isSafeInteger(objectNumber)
        || objectNumber < 1
        || typeof generationNumber !== 'number'
        || !Number.isSafeInteger(generationNumber)
        || generationNumber < 0
    ) {
        throw new Error(`${fieldName} contains an unsafe PDF object reference`);
    }
    return {
        objectNumber,
        generationNumber,
    };
}

function decodeEntry(value: unknown, linePageIndex?: number): IPdfAnnotationIndexEntry {
    if (!isRecord(value)) {
        throw new Error('PDF annotation index entry must be an object');
    }
    const rawPageIndex = value.pageIndex ?? linePageIndex;
    if (typeof rawPageIndex !== 'number' || !Number.isSafeInteger(rawPageIndex) || rawPageIndex < 0) {
        throw new Error('PDF annotation index entry has an invalid page index');
    }
    if (
        linePageIndex !== undefined
        && rawPageIndex !== linePageIndex
    ) {
        throw new Error('PDF annotation index entry page does not match its chunk');
    }
    const objectNumber = value.objectNumber;
    const generationNumber = value.generationNumber;
    const subtype = value.subtype;
    if (
        typeof objectNumber !== 'number'
        || !Number.isSafeInteger(objectNumber)
        || objectNumber < 0
        || typeof generationNumber !== 'number'
        || !Number.isSafeInteger(generationNumber)
        || generationNumber < 0
        || typeof subtype !== 'string'
        || subtype.length === 0
    ) {
        throw new Error('PDF annotation index entry has invalid object or subtype fields');
    }
    const name = value.name;
    if (name !== null && typeof name !== 'string') {
        throw new Error('PDF annotation index entry name must be a string or null');
    }
    const popupRef = decodeObjectRef(value.popupRef ?? value.popup, 'PDF annotation index popupRef');
    const parentRef = decodeObjectRef(value.parentRef ?? value.parent, 'PDF annotation index parentRef');
    return {
        pageIndex: rawPageIndex as IPdfAnnotationIndexEntry['pageIndex'],
        objectNumber,
        generationNumber,
        subtype,
        name,
        popupRef,
        parentRef,
    };
}

function decodeDataLine(value: unknown): IPdfAnnotationIndexEntry[] {
    if (!isRecord(value)) {
        throw new Error('PDF annotation index sidecar line must be an object');
    }
    const rawPageIndex = value.pageIndex;
    const pageIndex = rawPageIndex === undefined
        ? undefined
        : typeof rawPageIndex === 'number' && Number.isSafeInteger(rawPageIndex) && rawPageIndex >= 0
            ? rawPageIndex
            : null;
    if (pageIndex === null) {
        throw new Error('PDF annotation index sidecar line has an invalid page index');
    }
    const rawEntries = Array.isArray(value.entries)
        ? value.entries
        : Array.isArray(value.annotations)
            ? value.annotations
            : value.objectNumber !== undefined
                ? [value]
                : null;
    if (rawEntries === null) {
        throw new Error('PDF annotation index sidecar line has no entries');
    }
    return rawEntries.map(item => decodeEntry(item, pageIndex));
}

function parseJsonLine(bytes: Buffer, label: string) {
    const withoutNewline = bytes[bytes.length - 1] === 0x0a
        ? bytes.subarray(0, bytes.length - 1)
        : bytes;
    const jsonBytes = withoutNewline[withoutNewline.length - 1] === 0x0d
        ? withoutNewline.subarray(0, withoutNewline.length - 1)
        : withoutNewline;
    if (jsonBytes.length === 0) {
        throw new Error(`PDF annotation index sidecar contains an empty ${label} line`);
    }
    try {
        return JSON.parse(jsonBytes.toString('utf8')) as unknown;
    } catch (error) {
        throw new Error(`PDF annotation index sidecar contains invalid JSON in its ${label} line`, {cause: error});
    }
}

function scanSidecarLines(sidecarPath: string): Promise<IScannedAnnotationIndex> {
    return new Promise((resolveScan, rejectScan) => {
        const lines: IAnnotationIndexLine[] = [];
        let stream: ReturnType<typeof createReadStream> | null = null;
        let pending = Buffer.alloc(0) as Buffer;
        let pendingStartOffset = 0;
        let dataStartOffset = 0;
        let totalBytes = 0;
        let headerPageCount: number | null = null;
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
            if (line.length === 0 || line.length > ANNOTATION_INDEX_LINE_MAX_BYTES) {
                throw new Error(`PDF annotation index sidecar line exceeds ${ANNOTATION_INDEX_LINE_MAX_BYTES} bytes`);
            }
            const lineValue = parseJsonLine(line, headerSeen ? 'data' : 'header');
            if (!headerSeen) {
                headerPageCount = decodeHeader(lineValue).pageCount;
                dataStartOffset = addSafeOffsets(offset, line.length, 'PDF annotation index offset');
                headerSeen = true;
                return;
            }
            const entries = decodeDataLine(lineValue);
            entryCount = addSafeOffsets(entryCount, entries.length, 'PDF annotation index entry count');
            lines.push({
                offset: addSafeOffsets(offset, -dataStartOffset, 'PDF annotation index offset'),
                byteLength: line.length,
            });
        };
        const consume = (chunk: Buffer) => {
            totalBytes = addSafeOffsets(totalBytes, chunk.length, 'PDF annotation index sidecar size');
            pending = pending.length === 0 ? chunk : Buffer.concat([
                pending,
                chunk,
            ]);
            if (pending.length > ANNOTATION_INDEX_LINE_MAX_BYTES && pending.indexOf(0x0a) < 0) {
                throw new Error(`PDF annotation index sidecar line exceeds ${ANNOTATION_INDEX_LINE_MAX_BYTES} bytes`);
            }
            let newlineIndex = pending.indexOf(0x0a);
            while (newlineIndex >= 0) {
                const lineLength = newlineIndex + 1;
                const line = pending.subarray(0, lineLength);
                processLine(line, pendingStartOffset);
                pendingStartOffset = addSafeOffsets(pendingStartOffset, lineLength, 'PDF annotation index offset');
                pending = pending.subarray(lineLength);
                newlineIndex = pending.indexOf(0x0a);
            }
            if (pending.length > ANNOTATION_INDEX_LINE_MAX_BYTES) {
                throw new Error(`PDF annotation index sidecar line exceeds ${ANNOTATION_INDEX_LINE_MAX_BYTES} bytes`);
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
                    pendingStartOffset = addSafeOffsets(pendingStartOffset, pending.length, 'PDF annotation index offset');
                }
                if (headerPageCount === null) {
                    throw new Error('PDF annotation index sidecar is empty');
                }
                if (pendingStartOffset !== totalBytes) {
                    throw new Error('PDF annotation index sidecar offset accounting failed');
                }
                settled = true;
                resolveScan({
                    dataStartOffset,
                    dataBytes: addSafeOffsets(totalBytes, -dataStartOffset, 'PDF annotation index bytes'),
                    pageCount: headerPageCount,
                    entryCount,
                    lines,
                });
            } catch (error) {
                rejectOnce(error);
            }
        });
    });
}

function parseChunkOptions(options: IPdfAnnotationIndexChunkOptions | undefined) {
    const chunkBytes = options?.chunkBytes ?? ANNOTATION_INDEX_LINE_MAX_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > ANNOTATION_INDEX_LINE_MAX_BYTES) {
        throw new RangeError(`Annotation index chunkBytes must be between 1 and ${ANNOTATION_INDEX_LINE_MAX_BYTES}`);
    }
    return chunkBytes;
}

function findLineIndex(lines: readonly IAnnotationIndexLine[], offset: number) {
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

function assertSessionOwner(session: IAnnotationIndexSessionState, context: IDocumentsSenderIdContext) {
    if (session.ownerId !== getOwnerId(context)) {
        throw new Error('PDF annotation index session belongs to another sender');
    }
}

function cancelSession(session: IAnnotationIndexSessionState, reason: string) {
    session.canceled = true;
    if (!session.abortController.signal.aborted) {
        session.abortController.abort(new Error(reason));
    }
    cancelNativeCommandGroup(session.cancelGroup);
}

function cleanupWhenOperationSettles(session: IAnnotationIndexSessionState) {
    void session.operationPromise
        .catch(() => undefined)
        .then(() => cleanupSession(session));
}

async function cleanupSession(session: IAnnotationIndexSessionState) {
    if (session.cleanupPromise) {
        return session.cleanupPromise;
    }
    sessions.delete(session.sessionId);
    session.cleanupPromise = rm(session.sidecarDirectory, {
        force: true,
        recursive: true,
    }).catch((error: unknown) => {
        logger.warn(`Failed to remove PDF annotation index sidecar: ${String(error)}`);
    });
    return session.cleanupPromise;
}

/** Build the native command in one place so the native operation can rename its verb. */
function buildPdfAnnotationIndexCommandArgs(inputPath: string, outputPath: string, qpdfPath: string) {
    return [
        'annotation-index',
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--qpdf',
        qpdfPath,
    ];
}

async function runPdfAnnotationIndexNative(
    inputPath: string,
    outputPath: string,
    signal: AbortSignal,
    cancelGroup: string,
) {
    if (isNativePageOpsDisabled()) {
        throw new Error('Cannot build a PDF annotation index while native page operations are disabled');
    }
    const nativePath = resolveNativePageOpsPath();
    if (!nativePath) {
        throw new Error('Cannot build a PDF annotation index because the native page tool is unavailable');
    }
    await runNativeToolCommand(
        nativePath,
        buildPdfAnnotationIndexCommandArgs(inputPath, outputPath, getPdfNativeToolPaths().qpdf),
        {
            timeoutMs: ANNOTATION_INDEX_NATIVE_TIMEOUT_MS,
            maxStdoutBytes: ANNOTATION_INDEX_NATIVE_STDOUT_BYTES,
            maxStderrBytes: ANNOTATION_INDEX_NATIVE_STDERR_BYTES,
            rejectOnStdoutTruncation: true,
            commandLabel: 'evb-pdf-page-ops(annotation-index)',
            signal,
            cancelGroup,
        },
    );
}

export async function beginPdfAnnotationIndex(
    context: IDocumentsSenderIdContext,
    filePath: string,
    options: IPdfAnnotationIndexOptions,
): Promise<IPdfAnnotationIndexSession> {
    const expectedRevisionToken = parseDocumentRevisionToken(
        options?.expectedDocumentRevisionToken,
    );
    if (expectedRevisionToken === null) {
        throw new Error('Document revision token is required to build a PDF annotation index');
    }
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, context.senderId);
    const revision = await getWorkingCopyRevision(resolvedPath, context.senderId);
    if (revision.token !== expectedRevisionToken) {
        throw createStaleRevisionError({
            documentRef: resolvedPath,
            expectedRevision: expectedRevisionToken,
            actualRevision: revision.token,
        });
    }
    await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);

    const sessionId = randomUUID();
    const sidecarDirectory = await mkdtemp(join(getAppTempDir(), ANNOTATION_INDEX_DIRECTORY_PREFIX));
    const sidecarPath = join(sidecarDirectory, ANNOTATION_INDEX_FILE_NAME);
    const abortController = new AbortController();
    let cancelGroup = `pdf-annotation-index:${sessionId}`;
    const session: IAnnotationIndexSessionState = {
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
        cancelGroup,
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
    cancelGroup = `pdf-annotation-index:${mainOperation.id}`;
    session.cancelGroup = cancelGroup;
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancel,
        'Renderer navigation canceled PDF annotation indexing',
    );
    const handleMainAbort = () => cancel('PDF annotation indexing canceled');
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    session.operationPromise = (async () => {
        try {
            await runWithWorkingCopyReadBacking(
                resolvedPath,
                physicalPath => runPdfAnnotationIndexNative(
                    physicalPath,
                    sidecarPath,
                    abortController.signal,
                    cancelGroup,
                ),
                context.senderId === undefined ? {} : {ownerWebContentsId: context.senderId},
            );
            if (abortController.signal.aborted) {
                throw abortErrorFromSignal(abortController.signal);
            }
            await assertWorkingCopyRevisionCurrent(resolvedPath, expectedRevisionToken);
            const sidecarStat = await stat(sidecarPath, {bigint: true});
            if (sidecarStat.size > MAX_SAFE_INTEGER_BIGINT) {
                throw new Error('PDF annotation index sidecar exceeds the safe offset range');
            }
            session.index = await scanSidecarLines(sidecarPath);
            if (session.index.dataBytes !== Number(sidecarStat.size) - session.index.dataStartOffset) {
                throw new Error('PDF annotation index sidecar changed while it was being indexed');
            }
            session.lastTouchedAt = Date.now();
        } catch (error) {
            session.canceled = session.canceled || abortController.signal.aborted;
            throw error;
        } finally {
            mainOperation.signal.removeEventListener('abort', handleMainAbort);
            unregisterSenderCleanup();
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

export async function readPdfAnnotationIndexChunk(
    context: IDocumentsSenderIdContext,
    sessionId: string,
    offset: number,
    options?: IPdfAnnotationIndexChunkOptions,
): Promise<IPdfAnnotationIndexChunk> {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error('PDF annotation index session is not available');
    }
    assertSessionOwner(session, context);
    if (session.canceled || session.released) {
        throw new Error('PDF annotation index session is canceled');
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
        throw new RangeError('PDF annotation index offset must point to the beginning of a chunk line');
    }
    const line = session.index.lines[lineIndex]!;
    if (line.byteLength > chunkBytes) {
        throw new RangeError(`PDF annotation index line requires a chunk of at least ${line.byteLength} bytes`);
    }
    const absoluteOffset = addSafeOffsets(session.index.dataStartOffset, requestedOffset, 'PDF annotation index offset');
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
                throw new Error('PDF annotation index sidecar ended before the requested chunk');
            }
            bytesRead += readResult.bytesRead;
        }
    } finally {
        await sidecarHandle.close();
    }
    const entries = decodeDataLine(parseJsonLine(lineBytes, 'data'));
    const nextOffset = lineIndex + 1 < session.index.lines.length
        ? addSafeOffsets(line.offset, line.byteLength, 'PDF annotation index offset')
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

export async function releasePdfAnnotationIndex(
    context: IDocumentsSenderIdContext,
    sessionId: string,
) {
    const session = sessions.get(sessionId);
    if (!session) {
        return false;
    }
    assertSessionOwner(session, context);
    session.released = true;
    if (!session.abortController.signal.aborted) {
        cancelSession(session, 'PDF annotation index released');
    }
    await session.operationPromise.catch(() => undefined);
    await cleanupSession(session);
    return true;
}

export function cancelPdfAnnotationIndex(
    context: IDocumentsSenderIdContext,
    sessionId: string,
) {
    const session = sessions.get(sessionId);
    if (!session) {
        return Promise.resolve({canceled: false});
    }
    assertSessionOwner(session, context);
    if (session.canceled || session.released) {
        return Promise.resolve({canceled: false});
    }
    cancelSession(session, 'PDF annotation index canceled');
    cleanupWhenOperationSettles(session);
    return Promise.resolve({canceled: true});
}

export async function sweepStalePdfAnnotationIndexArtifacts(
    maxAgeMs = ANNOTATION_INDEX_DEFAULT_TTL_MS,
    maxEntries = ANNOTATION_INDEX_SWEEP_MAX_ENTRIES,
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
    for (const entry of entries.filter(name => name.startsWith(ANNOTATION_INDEX_DIRECTORY_PREFIX)).slice(0, maxEntries)) {
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
            logger.warn(`Failed to sweep stale PDF annotation index artifact "${directoryPath}": ${String(error)}`);
        }
    }
    return deletedCount;
}

const annotationIndexTtlTimer = setInterval(() => {
    const cutoff = Date.now() - ANNOTATION_INDEX_DEFAULT_TTL_MS;
    for (const session of sessions.values()) {
        if (session.lastTouchedAt >= cutoff) continue;
        session.released = true;
        cancelSession(session, 'PDF annotation index session expired');
        cleanupWhenOperationSettles(session);
    }
    void sweepStalePdfAnnotationIndexArtifacts().catch((error: unknown) => {
        logger.debug(`PDF annotation index TTL sweep failed: ${String(error)}`);
    });
}, 30_000);
annotationIndexTtlTimer.unref?.();
