import {
    createHash,
    randomUUID,
    type Hash,
} from 'node:crypto';
import {
    open,
    rm,
    stat,
} from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type {
    IpcMainEvent,
    MessagePortMain,
    WebContents,
} from 'electron';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import type {
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { createMissingRevisionError } from '@contracts/documentMutationErrors';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
    ISerializedPdfPersistenceLimits,
    TPdfPersistenceErrorPhase,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    createPdfPersistenceAckFrame,
    createPdfPersistenceErrorFrame,
    createPdfPersistenceReadyFrame,
    createPdfPersistenceResultFrame,
    createPdfPersistenceStagedFrame,
    describePdfPersistenceMessage,
    getPdfPersistenceChunkBytes,
    isPdfPersistencePreloadToMainPayload,
    normalizePdfPersistencePreloadToMainPayload,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import { makeSiblingTempPath } from '@electron/utils/atomicReplace';
import { getErrorMessage } from '@electron/utils/error';
import { syncFileHandleForDurability } from '@electron/utils/syncFileHandleForDurability';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
    setWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
import {
    allowOpenPath,
    removeAllowedOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import {
    markWorkingCopySyncRequired,
    markWorkingCopyContentChanged,
} from '@electron/file-access/documentRevisionStore';
import { assertQueuedWorkingCopyMutationPreconditions } from '@electron/file-access/documentMutationGuards';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { originalPathSaveBaseMatches } from '@electron/features/documents/main/originalPathSaveBaseMatches';
import {transitionOriginalAndWorkingCopyRevision} from '@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision';
import { commitPdfTempFile } from '@electron/features/documents/main/commitPdfTempFile';
import {
    optimizeLargePdfForOrdinarySave,
    optimizePdfForSaveAs,
} from '@electron/features/documents/main/pdfSaveAsOptimization';
import type {
    IDocumentsSenderIdContext,
    IDocumentsWebContentsContext,
} from '@electron/features/documents/documentsService';
import {
    registerMainOperation,
    type IRegisteredMainOperation,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {
    createTypedStagedArtifact,
    releaseManagedTempFileHandle,
} from '@electron/features/documents/main/managedTempFileHandles';

const SERIALIZED_PDF_SESSION_TIMEOUT_MS = 10 * 60_000;
const SERIALIZED_PDF_MAX_CHUNK_BYTES = PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES;
const SERIALIZED_PDF_MAX_IN_FLIGHT_CHUNKS = PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS;
const SERIALIZED_PDF_ACK_TIMEOUT_MS = PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS;
const SERIALIZED_PDF_RESULT_TIMEOUT_MS = PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS;
const DEFAULT_SERIALIZED_PDF_PERSISTENCE_MAX_BYTES = 16 * 1024 * 1024 * 1024;
const MIN_SERIALIZED_PDF_PERSISTENCE_MAX_BYTES = 1024 * 1024;
const MAX_SERIALIZED_PDF_PERSISTENCE_BYTES = (() => {
    const parsed = Number.parseInt(
        process.env.EVB_MAX_SERIALIZED_PDF_PERSISTENCE_BYTES
            ?? `${DEFAULT_SERIALIZED_PDF_PERSISTENCE_MAX_BYTES}`,
        10,
    );
    if (!Number.isSafeInteger(parsed) || parsed < MIN_SERIALIZED_PDF_PERSISTENCE_MAX_BYTES) {
        return DEFAULT_SERIALIZED_PDF_PERSISTENCE_MAX_BYTES;
    }
    return parsed;
})();
const MAX_SERIALIZED_PDF_SESSIONS_PER_SENDER = (() => {
    const parsed = Number.parseInt(process.env.EVB_MAX_SERIALIZED_PDF_SESSIONS_PER_SENDER ?? '4', 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return 4;
    }
    return Math.min(parsed, 64);
})();
const MAX_SERIALIZED_PDF_RESERVED_BYTES_PER_SENDER = (() => {
    const parsed = Number.parseInt(
        process.env.EVB_MAX_SERIALIZED_PDF_RESERVED_BYTES_PER_SENDER
            ?? `${MAX_SERIALIZED_PDF_PERSISTENCE_BYTES}`,
        10,
    );
    if (!Number.isSafeInteger(parsed) || parsed < MIN_SERIALIZED_PDF_PERSISTENCE_MAX_BYTES) {
        return MAX_SERIALIZED_PDF_PERSISTENCE_BYTES;
    }
    return Math.max(parsed, MIN_SERIALIZED_PDF_PERSISTENCE_MAX_BYTES);
})();
const PDF_EOF_TAIL_BYTES = 64 * 1024;

type TSerializedPdfPersistenceMode = 'save' | 'save_as' | 'working_copy';

interface ISerializedPdfPersistenceSession {
    id: string;
    mode: TSerializedPdfPersistenceMode;
    senderId: number;
    sender: WebContents;
    workingPath: string;
    targetPath: string;
    saveAsOptions: IPdfSaveAsOptions | undefined;
    expectedDocumentRevisionToken: TDocumentRevisionToken;
    changedObjectRefs: string[];
    tempPath: string;
    totalBytes: number;
    receivedBytes: number;
    nextSeq: number;
    maxChunkBytes: number;
    portAttached: boolean;
    isCommitting: boolean;
    isStaged: boolean;
    pendingPortMessages: number;
    portQueueOverflowed: boolean;
    handle: FileHandle;
    hash: Hash;
    streamedTail: Buffer;
    stagedOutput: ITypedStagedArtifact | null;
    stagedValidation: IPdfValidationResult | null;
    timeout: NodeJS.Timeout;
    queue: Promise<void>;
    unregisterSenderCleanup: () => void;
    releaseSenderReservation: () => void;
    lifecycleOperation: IRegisteredMainOperation;
}

interface ISerializedPdfPersistenceCommitResult {
    validation: IPdfValidationResult;
    targetWriteCommitted: boolean;
    workingCopyRefreshed: boolean;
}

interface ISerializedPdfPersistenceStageResult {
    validation: IPdfValidationResult;
    stagedOutput: ITypedStagedArtifact | null;
}

const sessions = new Map<string, ISerializedPdfPersistenceSession>();
const senderReservations = new Map<number, {
    sessionCount: number;
    reservedBytes: number;
}>();

function createEmptyPdfValidationResult(message: string): IPdfValidationResult {
    return {
        isValid: false,
        tool: 'qpdf',
        errors: [message],
        warnings: [],
    };
}

function createOriginalChangedValidationResult() {
    return createEmptyPdfValidationResult('Original file changed on disk; save skipped to avoid overwriting external edits');
}

function normalizeExpectedDocumentRevisionToken(
    workingPath: string,
    options?: IPdfSerializedSaveOptions | null,
) {
    const token = options?.expectedDocumentRevisionToken;
    if (token === undefined || token === null) {
        throw createMissingRevisionError({documentRef: workingPath});
    }
    const parsedToken = parseDocumentRevisionToken(token);
    if (parsedToken === null) {
        throw new TypeError('expectedDocumentRevisionToken must be a non-empty string');
    }
    return parsedToken;
}

function getSerializedPdfPersistenceLimits(): ISerializedPdfPersistenceLimits {
    return {
        protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
        maxChunkBytes: SERIALIZED_PDF_MAX_CHUNK_BYTES,
        maxInFlightChunks: SERIALIZED_PDF_MAX_IN_FLIGHT_CHUNKS,
        maxTotalBytes: MAX_SERIALIZED_PDF_PERSISTENCE_BYTES,
        ackTimeoutMs: SERIALIZED_PDF_ACK_TIMEOUT_MS,
        resultTimeoutMs: SERIALIZED_PDF_RESULT_TIMEOUT_MS,
    };
}

function withWorkingCopySyncWarning(validation: IPdfValidationResult, error: unknown): IPdfValidationResult {
    const message = `Saved target file, but failed to refresh the working copy: ${getErrorMessage(error)}`;
    return {
        ...validation,
        isValid: false,
        errors: [
            ...validation.errors,
            message,
        ],
        warnings: [
            ...validation.warnings,
            message,
        ],
    };
}

function normalizeWorkingPath(workingPath: unknown) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }

    return normalizedWorkingPath;
}

function normalizeTotalBytes(totalBytes: unknown) {
    if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
        throw new Error('Invalid total byte count');
    }

    if (totalBytes > MAX_SERIALIZED_PDF_PERSISTENCE_BYTES) {
        throw new Error(
            `Invalid PDF persistence stream: exceeds maximum size (${MAX_SERIALIZED_PDF_PERSISTENCE_BYTES} bytes)`,
        );
    }
    return totalBytes;
}

function getValidatedOriginalPath(workingPath: string, senderWebContentsId: number) {
    const originalPath = getWorkingCopyOriginalPath(workingPath, senderWebContentsId)?.originalPath;
    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    return originalPath;
}

function clearSessionTimeout(session: ISerializedPdfPersistenceSession) {
    clearTimeout(session.timeout);
}

function reserveSenderPersistenceCapacity(senderId: number, totalBytes: number) {
    const existingReservation = senderReservations.get(senderId) ?? {
        sessionCount: 0,
        reservedBytes: 0,
    };
    if (existingReservation.sessionCount >= MAX_SERIALIZED_PDF_SESSIONS_PER_SENDER) {
        throw new Error(`Too many active PDF persistence streams (${MAX_SERIALIZED_PDF_SESSIONS_PER_SENDER})`);
    }
    if (existingReservation.reservedBytes + totalBytes > MAX_SERIALIZED_PDF_RESERVED_BYTES_PER_SENDER) {
        throw new Error(
            `Active PDF persistence streams exceed reserved byte budget (${MAX_SERIALIZED_PDF_RESERVED_BYTES_PER_SENDER})`,
        );
    }

    const nextReservation = {
        sessionCount: existingReservation.sessionCount + 1,
        reservedBytes: existingReservation.reservedBytes + totalBytes,
    };
    senderReservations.set(senderId, nextReservation);

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;

        const currentReservation = senderReservations.get(senderId);
        if (!currentReservation) {
            return;
        }
        const sessionCount = Math.max(0, currentReservation.sessionCount - 1);
        const reservedBytes = Math.max(0, currentReservation.reservedBytes - totalBytes);
        if (sessionCount === 0 || reservedBytes === 0) {
            senderReservations.delete(senderId);
            return;
        }
        senderReservations.set(senderId, {
            sessionCount,
            reservedBytes,
        });
    };
}

function refreshSessionTimeout(session: ISerializedPdfPersistenceSession) {
    clearSessionTimeout(session);
    session.timeout = setTimeout(() => {
        if (sessions.get(session.id) === session) {
            void cleanupSession(session);
        }
    }, SERIALIZED_PDF_SESSION_TIMEOUT_MS);
    session.timeout.unref?.();
}

async function cleanupSession(session: ISerializedPdfPersistenceSession) {
    clearSessionTimeout(session);
    session.unregisterSenderCleanup();
    session.releaseSenderReservation();
    sessions.delete(session.id);
    if (session.stagedOutput !== null) {
        releaseManagedTempFileHandle(
            {senderId: session.senderId},
            session.stagedOutput.leaseId,
        );
        session.stagedOutput = null;
    }
    removeAllowedOpenPath(session.tempPath);
    await session.handle.close().catch(() => undefined);
    await rm(session.tempPath, { force: true }).catch(() => undefined);
    session.lifecycleOperation.complete();
}

function finishSessionLifecycle(session: ISerializedPdfPersistenceSession) {
    clearSessionTimeout(session);
    session.unregisterSenderCleanup();
    session.releaseSenderReservation();
    sessions.delete(session.id);
    if (session.stagedOutput !== null) {
        releaseManagedTempFileHandle(
            {senderId: session.senderId},
            session.stagedOutput.leaseId,
        );
        session.stagedOutput = null;
    }
    removeAllowedOpenPath(session.tempPath);
    session.lifecycleOperation.complete();
}

function registerSessionSenderCleanup(sender: WebContents, getSession: () => ISerializedPdfPersistenceSession) {
    const cleanup = () => {
        const session = getSession();
        if (sessions.get(session.id) === session && !session.isCommitting) {
            void cleanupSession(session);
        }
    };

    const handleDestroyed = () => {
        cleanup();
    };
    const handleRenderProcessGone = () => {
        cleanup();
    };
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            cleanup();
        }
    };

    sender.once('destroyed', handleDestroyed);
    sender.once('render-process-gone', handleRenderProcessGone);
    sender.on('did-start-navigation', handleNavigation);

    return () => {
        sender.removeListener('destroyed', handleDestroyed);
        sender.removeListener('render-process-gone', handleRenderProcessGone);
        sender.removeListener('did-start-navigation', handleNavigation);
    };
}

async function createSession(options: {
    mode: TSerializedPdfPersistenceMode;
    sender: WebContents;
    workingPath: string;
    targetPath: string;
    saveAsOptions?: IPdfSaveAsOptions | undefined;
    serializedSaveOptions?: IPdfSerializedSaveOptions | undefined;
    totalBytes: number;
}) {
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(
        options.workingPath,
        options.serializedSaveOptions,
    );
    const releaseSenderReservation = reserveSenderPersistenceCapacity(options.sender.id, options.totalBytes);
    const tempPath = `${makeSiblingTempPath(options.targetPath)}.pdf`;
    let handle: FileHandle;
    try {
        handle = await open(tempPath, 'wx');
    } catch (error) {
        releaseSenderReservation();
        throw error;
    }
    const id = randomUUID();
    const timeout = setTimeout(() => undefined, SERIALIZED_PDF_SESSION_TIMEOUT_MS);
    timeout.unref?.();
    const lifecycleOperation = registerMainOperation({
        kind: 'critical-write',
        ownerWebContentsId: options.sender.id,
        workingCopyPath: options.workingPath,
    });

    const session: ISerializedPdfPersistenceSession = {
        id,
        mode: options.mode,
        senderId: options.sender.id,
        sender: options.sender,
        workingPath: options.workingPath,
        targetPath: options.targetPath,
        saveAsOptions: options.saveAsOptions,
        changedObjectRefs: options.serializedSaveOptions?.changedObjectRefs ?? [],
        expectedDocumentRevisionToken,
        tempPath,
        totalBytes: options.totalBytes,
        receivedBytes: 0,
        nextSeq: 0,
        maxChunkBytes: SERIALIZED_PDF_MAX_CHUNK_BYTES,
        portAttached: false,
        isCommitting: false,
        isStaged: false,
        pendingPortMessages: 0,
        portQueueOverflowed: false,
        handle,
        hash: createHash('sha256'),
        streamedTail: Buffer.alloc(0),
        stagedOutput: null,
        stagedValidation: null,
        timeout,
        queue: Promise.resolve(),
        unregisterSenderCleanup: () => undefined,
        releaseSenderReservation,
        lifecycleOperation,
    };
    session.unregisterSenderCleanup = registerSessionSenderCleanup(options.sender, () => session);
    refreshSessionTimeout(session);
    sessions.set(id, session);
    return session;
}

export async function beginSerializedPdfSaveToOriginal(
    context: IDocumentsWebContentsContext,
    workingPath: unknown,
    totalBytes: unknown,
    serializedSaveOptions?: IPdfSerializedSaveOptions,
): Promise<IBeginSerializedPdfPersistenceResult> {
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const normalizedTotalBytes = normalizeTotalBytes(totalBytes);
    const workingCopyOnly = serializedSaveOptions?.workingCopyOnly === true;
    const targetPath = workingCopyOnly
        ? normalizedWorkingPath
        : getValidatedOriginalPath(normalizedWorkingPath, context.senderId);

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
        throw new Error('Working copy path is not managed');
    }
    const session = await createSession({
        mode: workingCopyOnly ? 'working_copy' : 'save',
        sender: context.sender,
        workingPath: normalizedWorkingPath,
        targetPath,
        serializedSaveOptions,
        totalBytes: normalizedTotalBytes,
    });

    return {
        sessionId: session.id,
        ...getSerializedPdfPersistenceLimits(),
    };
}

export async function beginSerializedPdfSaveAs(
    context: IDocumentsWebContentsContext,
    workingPath: unknown,
    totalBytes: unknown,
    targetPath: string | null,
    saveAsOptions?: IPdfSaveAsOptions,
    serializedSaveOptions?: IPdfSerializedSaveOptions,
): Promise<IBeginSerializedPdfSaveAsResult> {
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const normalizedTotalBytes = normalizeTotalBytes(totalBytes);
    if (!targetPath) {
        return {
            sessionId: null,
            path: null,
            ...getSerializedPdfPersistenceLimits(),
        };
    }
    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
        throw new Error('Working copy path is not managed');
    }

    const session = await createSession({
        mode: 'save_as',
        sender: context.sender,
        workingPath: normalizedWorkingPath,
        targetPath,
        saveAsOptions,
        serializedSaveOptions,
        totalBytes: normalizedTotalBytes,
    });

    return {
        sessionId: session.id,
        path: targetPath,
        ...getSerializedPdfPersistenceLimits(),
    };
}

function updateStreamedTail(currentTail: Buffer, bytes: Uint8Array) {
    if (bytes.byteLength >= PDF_EOF_TAIL_BYTES) {
        return Buffer.from(bytes.subarray(bytes.byteLength - PDF_EOF_TAIL_BYTES));
    }
    const combined = Buffer.concat([
        currentTail,
        Buffer.from(bytes),
    ]);
    return combined.byteLength <= PDF_EOF_TAIL_BYTES
        ? combined
        : combined.subarray(combined.byteLength - PDF_EOF_TAIL_BYTES);
}

function containsPdfEofMarker(bytes: Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from('%%EOF'));
}

async function writeSessionBytes(handle: FileHandle, bytes: Uint8Array) {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const {bytesWritten} = await handle.write(bytes, offset, bytes.byteLength - offset);
        if (bytesWritten < 1) {
            throw new Error('PDF persistence stream write made no progress');
        }
        offset += bytesWritten;
    }
}

async function hasPdfEofMarker(path: string) {
    const file = await stat(path);
    if (!file.isFile() || file.size < 1) {
        return false;
    }
    const tailBytes = Math.min(file.size, PDF_EOF_TAIL_BYTES);
    const tail = Buffer.alloc(tailBytes);
    const handle = await open(path, 'r');
    try {
        const result = await handle.read(tail, 0, tailBytes, file.size - tailBytes);
        return result.bytesRead === tailBytes && containsPdfEofMarker(tail);
    } finally {
        await handle.close();
    }
}

async function stageSession(
    session: ISerializedPdfPersistenceSession,
): Promise<ISerializedPdfPersistenceStageResult> {
    if (session.receivedBytes !== session.totalBytes) {
        return {
            validation: createEmptyPdfValidationResult(
                `PDF persistence stream ended after ${session.receivedBytes} of ${session.totalBytes} bytes`,
            ),
            stagedOutput: null,
        };
    }

    await syncFileHandleForDurability(session.handle);
    await session.handle.close();
    const validation = await validatePdfFile(session.tempPath);
    if (!validation.isValid) {
        return {
            validation,
            stagedOutput: null,
        };
    }
    const optimizedValidation = session.mode === 'save_as'
        ? await optimizePdfForSaveAs(session.tempPath, session.saveAsOptions)
        : session.mode === 'save'
            ? await optimizeLargePdfForOrdinarySave(session.tempPath)
            : null;
    const stagedValidation = optimizedValidation ?? validation;
    if (stagedValidation.tool !== 'qpdf') {
        throw new Error('Serialized PDF staging requires qpdf validation');
    }
    if (allowOpenPath(session.tempPath, session.sender) === null) {
        throw new Error('Serialized PDF staging path could not be granted for verification');
    }
    const streamedSha256 = session.hash.digest('hex');
    const tailCheck = optimizedValidation === null
        ? containsPdfEofMarker(session.streamedTail)
        : await hasPdfEofMarker(session.tempPath);
    const artifactOptions = optimizedValidation === null
        ? {
            cleanupOnRelease: true,
            trustedFingerprint: {
                bytes: session.totalBytes,
                sha256: streamedSha256,
            },
        }
        : {cleanupOnRelease: true};
    const stagedOutput = await createTypedStagedArtifact(
        {senderId: session.senderId},
        session.tempPath,
        {
            qpdfCheck: true,
            qpdfResult: stagedValidation,
            tailCheck,
            semanticCheck: false,
            fsynced: true,
        },
        artifactOptions,
    );
    session.isStaged = true;
    session.stagedOutput = stagedOutput;
    session.stagedValidation = stagedValidation;
    refreshSessionTimeout(session);
    return {
        validation: stagedValidation,
        stagedOutput,
    };
}

async function commitSession(
    session: ISerializedPdfPersistenceSession,
    stagedOutput: ITypedStagedArtifact,
): Promise<ISerializedPdfPersistenceCommitResult> {
    if (
        !session.isStaged
        || session.stagedOutput === null
        || session.stagedValidation === null
        || !isDeepStrictEqual(stagedOutput, session.stagedOutput)
    ) {
        throw new Error('Serialized PDF persistence session does not match the staged artifact');
    }
    const committedValidation = session.stagedValidation;
    const receipt = {
        artifact: stagedOutput,
        context: {senderId: session.senderId},
    };
    let conflictValidation: IPdfValidationResult | null = null;
    let syncWarningValidation: IPdfValidationResult | null = null;
    let targetWriteCommitted = false;
    let workingCopyRefreshed = false;
    await enqueueWorkingCopyMutation(session.workingPath, async () => {
        if (!await ensureWorkingCopyDirectory(session.workingPath, session.senderId)) {
            throw new Error('Working copy path is not managed');
        }
        await assertQueuedWorkingCopyMutationPreconditions(
            session.workingPath,
            session.expectedDocumentRevisionToken,
        );

        if (session.mode === 'working_copy') {
            await commitPdfTempFile(session.tempPath, session.workingPath, {
                signal: session.lifecycleOperation.signal,
                ownerId: `serialized-pdf:${session.id}`,
                receipt,
                ...(session.changedObjectRefs.length ? {changedObjectRefs: session.changedObjectRefs} : {}),
            });
            await markWorkingCopyContentChanged(session.workingPath, 'replace-working-copy', session.senderId);
            targetWriteCommitted = true;
            workingCopyRefreshed = true;
        } else if (session.mode === 'save_as') {
            await commitPdfTempFile(session.tempPath, session.targetPath, {
                signal: session.lifecycleOperation.signal,
                ownerId: `serialized-pdf:${session.id}`,
                receipt,
                ...(session.changedObjectRefs.length ? {changedObjectRefs: session.changedObjectRefs} : {}),
            });
            targetWriteCommitted = true;
            try {
                await setWorkingCopyOriginalPath(session.workingPath, session.targetPath, session.senderId);
                await copyFileCopyOnWrite(session.targetPath, session.workingPath);
                await markWorkingCopyContentChanged(session.workingPath, 'save-sync', session.senderId);
                workingCopyRefreshed = true;
            } catch (syncError) {
                markWorkingCopySyncRequired(
                    session.workingPath,
                    `Target file was saved, but the working copy refresh failed: ${getErrorMessage(syncError)}`,
                );
                syncWarningValidation = withWorkingCopySyncWarning(committedValidation, syncError);
            }
            allowOpenPath(session.targetPath, session.sender);
            await addRecentFile(session.targetPath);
            updateRecentFilesMenu();
        } else {
            const transition = await transitionOriginalAndWorkingCopyRevision({
                workingCopyPath: session.workingPath,
                originalPath: session.targetPath,
                reason: 'save-sync',
                senderId: session.senderId,
                assertOriginalCurrent: () => originalPathSaveBaseMatches(
                    session.workingPath,
                    session.targetPath,
                    session.senderId,
                ),
                publishOriginal: async () => {
                    await commitPdfTempFile(session.tempPath, session.targetPath, {
                        signal: session.lifecycleOperation.signal,
                        ownerId: `serialized-pdf:${session.id}`,
                        receipt,
                        ...(session.changedObjectRefs.length ? {changedObjectRefs: session.changedObjectRefs} : {}),
                    });
                },
                afterWorkingCopySync: async () => {
                    if (!await refreshWorkingCopyOriginalFileExpectation(session.workingPath, session.senderId)) {
                        throw new Error('Working copy registration changed before original expectation refresh completed');
                    }
                    workingCopyRefreshed = true;
                },
            });
            if (!transition) {
                conflictValidation = createOriginalChangedValidationResult();
            } else {
                targetWriteCommitted = true;
            }
        }
    });

    return {
        validation: conflictValidation ?? syncWarningValidation ?? committedValidation,
        targetWriteCommitted,
        workingCopyRefreshed,
    };
}

function getSessionForPortEvent(event: IpcMainEvent, rawSessionId: unknown) {
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : '';
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error('PDF persistence session was not found');
    }
    if (session.senderId !== event.sender.id) {
        throw new Error('PDF persistence session belongs to a different sender');
    }

    return session;
}

function getOwnedStagedSession(
    context: IDocumentsSenderIdContext,
    rawSessionId: unknown,
) {
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : '';
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error('PDF persistence session was not found');
    }
    if (session.senderId !== context.senderId) {
        throw new Error('PDF persistence session belongs to a different sender');
    }
    if (!session.isStaged || session.stagedOutput === null) {
        throw new Error('PDF persistence session has no staged artifact');
    }
    return session;
}

export async function commitStagedSerializedPdf(
    context: IDocumentsSenderIdContext,
    sessionId: unknown,
    stagedOutput: ITypedStagedArtifact,
) {
    const session = getOwnedStagedSession(context, sessionId);
    if (session.isCommitting) {
        throw new Error('PDF persistence session is already committing');
    }
    session.isCommitting = true;
    session.lifecycleOperation.markCommitStarted();
    clearSessionTimeout(session);
    const executeCommit = async () => {
        try {
            const result = await commitSession(session, stagedOutput);
            const path = result.targetWriteCommitted ? session.targetPath : null;
            if (result.targetWriteCommitted) {
                finishSessionLifecycle(session);
                await rm(session.tempPath, {force: true}).catch(() => undefined);
            } else {
                await cleanupSession(session);
            }
            return {
                path,
                validation: result.validation,
            };
        } catch (error) {
            await cleanupSession(session);
            throw error;
        }
    };
    const commitPromise = session.queue.then(executeCommit, executeCommit);
    session.queue = commitPromise.then(() => undefined, () => undefined);
    return commitPromise;
}

export async function cancelStagedSerializedPdf(
    context: IDocumentsSenderIdContext,
    sessionId: unknown,
    stagedOutput: ITypedStagedArtifact,
) {
    const session = getOwnedStagedSession(context, sessionId);
    if (session.isCommitting) {
        throw new Error('PDF persistence session is already committing');
    }
    if (!isDeepStrictEqual(stagedOutput, session.stagedOutput)) {
        throw new Error('Serialized PDF persistence session does not match the staged artifact');
    }
    await cleanupSession(session);
    return true;
}

export function attachSerializedPdfPersistencePort(event: IpcMainEvent, rawSessionId: unknown) {
    const session = getSessionForPortEvent(event, rawSessionId);
    if (session.portAttached) {
        throw new Error('PDF persistence MessagePort is already attached');
    }
    const port = event.ports[0];
    if (!port) {
        throw new Error('PDF persistence MessagePort is missing');
    }
    session.portAttached = true;

    port.on('message', (messageEvent) => {
        const maxQueuedMessages = SERIALIZED_PDF_MAX_IN_FLIGHT_CHUNKS + 2;
        if (session.portQueueOverflowed || sessions.get(session.id) !== session) {
            return;
        }
        if (session.pendingPortMessages >= maxQueuedMessages) {
            session.portQueueOverflowed = true;
            return;
        }
        session.pendingPortMessages += 1;
        const processMessage = async () => {
            try {
                await handlePortMessage(session, port, messageEvent);
            } finally {
                session.pendingPortMessages = Math.max(0, session.pendingPortMessages - 1);
            }
        };
        session.queue = session.queue.then(
            processMessage,
            processMessage,
        );
    });
    port.once('close', () => {
        if (sessions.get(session.id) === session && !session.isCommitting && !session.isStaged) {
            void cleanupSession(session);
        }
    });
    port.start();
    port.postMessage(createPdfPersistenceReadyFrame());
}

async function handlePortMessage(
    session: ISerializedPdfPersistenceSession,
    port: MessagePortMain,
    message: unknown,
) {
    let errorPhase: TPdfPersistenceErrorPhase = 'streaming';
    let errorSeq: number | undefined;
    try {
        if (sessions.get(session.id) !== session) {
            return;
        }
        if (session.portQueueOverflowed) {
            throw new Error(
                `PDF persistence stream exceeded queued message limit (${SERIALIZED_PDF_MAX_IN_FLIGHT_CHUNKS + 2})`,
            );
        }
        if (session.lifecycleOperation.signal.aborted && !session.isCommitting) {
            throw new Error('PDF persistence stream canceled during shutdown');
        }
        const normalizedMessage = normalizePdfPersistencePreloadToMainPayload(message);
        if (!isPdfPersistencePreloadToMainPayload(normalizedMessage)) {
            throw new Error(`Unknown PDF persistence message (${describePdfPersistenceMessage(normalizedMessage)})`);
        }
        const payload = normalizedMessage;
        refreshSessionTimeout(session);
        if (payload.type === 'chunk') {
            errorPhase = 'streaming';
            if (session.lifecycleOperation.signal.aborted && !session.isCommitting) {
                throw new Error('PDF persistence stream canceled during shutdown');
            }
            errorSeq = typeof payload.seq === 'number' ? payload.seq : undefined;
            if (payload.seq !== session.nextSeq) {
                throw new Error('Unexpected PDF persistence chunk sequence');
            }

            const bytes = getPdfPersistenceChunkBytes(payload.bytes);
            if (bytes.byteLength === 0) {
                throw new Error('PDF persistence chunk must not be empty');
            }
            if (bytes.byteLength > session.maxChunkBytes) {
                throw new Error(`PDF persistence chunk exceeds maximum size (${session.maxChunkBytes} bytes)`);
            }
            const receivedBytes = session.receivedBytes + bytes.byteLength;
            if (receivedBytes > session.totalBytes) {
                throw new Error('PDF persistence stream exceeded expected byte count');
            }

            await writeSessionBytes(session.handle, bytes);
            session.receivedBytes = receivedBytes;
            session.hash.update(bytes);
            session.streamedTail = updateStreamedTail(session.streamedTail, bytes);
            port.postMessage(createPdfPersistenceAckFrame(session.nextSeq, session.receivedBytes));
            session.nextSeq += 1;
            return;
        }

        if (payload.type === 'complete') {
            errorPhase = 'complete';
            if (session.lifecycleOperation.signal.aborted && !session.isCommitting) {
                throw new Error('PDF persistence stream canceled during shutdown');
            }
            clearSessionTimeout(session);
            const stageResult = await stageSession(session);
            if (stageResult.stagedOutput === null) {
                await cleanupSession(session);
                port.postMessage(createPdfPersistenceResultFrame(null, stageResult.validation));
            } else {
                port.postMessage(createPdfPersistenceStagedFrame(
                    session.id,
                    stageResult.stagedOutput,
                    stageResult.validation,
                ));
            }
            port.close();
            return;
        }

        if (payload.type === 'cancel') {
            await cleanupSession(session);
            port.postMessage(createPdfPersistenceErrorFrame('PDF persistence stream canceled', {
                phase: 'cancel',
                expected: true,
            }));
            port.close();
            return;
        }

        throw new Error(`Unknown PDF persistence message (${describePdfPersistenceMessage(normalizedMessage)})`);
    } catch (error) {
        await cleanupSession(session);
        const errorFrameOptions: {
            phase: TPdfPersistenceErrorPhase;
            seq?: number;
        } = {phase: errorPhase};
        if (errorSeq !== undefined) {
            errorFrameOptions.seq = errorSeq;
        }
        port.postMessage(createPdfPersistenceErrorFrame(error, errorFrameOptions));
        port.close();
    }
}

export async function shutdownSerializedPdfPersistence() {
    await Promise.all([...sessions.values()].map(async (session) => {
        if (session.isCommitting) {
            await session.queue.catch(() => undefined);
            return;
        }
        await cleanupSession(session);
    }));
}
