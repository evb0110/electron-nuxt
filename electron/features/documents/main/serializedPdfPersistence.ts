import { randomUUID } from 'node:crypto';
import {
    open,
    rm,
} from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import type {
    IpcMainEvent,
    MessagePortMain,
    WebContents,
} from 'electron';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { IPdfSaveAsOptions } from '@contracts/electronApiDocuments';
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
    describePdfPersistenceMessage,
    getPdfPersistenceChunkBytes,
    isPdfPersistencePreloadToMainPayload,
    normalizePdfPersistencePreloadToMainPayload,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { getErrorMessage } from '@electron/utils/error';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
    setWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import { markWorkingCopyContentChanged } from '@electron/file-access/documentRevisionStore';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { originalPathSaveBaseMatches } from '@electron/features/documents/main/originalPathSaveBaseMatches';
import {
    optimizeLargePdfForSave,
    optimizePdfForSaveAs,
} from '@electron/features/documents/main/pdfSaveAsOptimization';
import type { IDocumentsWebContentsContext } from '@electron/features/documents/documentsService';

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

type TSerializedPdfPersistenceMode = 'save' | 'save_as';

interface ISerializedPdfPersistenceSession {
    id: string;
    mode: TSerializedPdfPersistenceMode;
    senderId: number;
    sender: WebContents;
    workingPath: string;
    targetPath: string;
    saveAsOptions: IPdfSaveAsOptions | undefined;
    tempPath: string;
    totalBytes: number;
    receivedBytes: number;
    nextSeq: number;
    maxChunkBytes: number;
    portAttached: boolean;
    isCommitting: boolean;
    handle: FileHandle;
    timeout: NodeJS.Timeout;
    queue: Promise<void>;
    unregisterSenderCleanup: () => void;
    releaseSenderReservation: () => void;
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
    return {
        ...validation,
        warnings: [
            ...validation.warnings,
            `Saved target file, but failed to refresh the working copy: ${getErrorMessage(error)}`,
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
    await session.handle.close().catch(() => undefined);
    await rm(session.tempPath, { force: true }).catch(() => undefined);
}

function finishSessionLifecycle(session: ISerializedPdfPersistenceSession) {
    clearSessionTimeout(session);
    session.unregisterSenderCleanup();
    session.releaseSenderReservation();
    sessions.delete(session.id);
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
    totalBytes: number;
}) {
    const releaseSenderReservation = reserveSenderPersistenceCapacity(options.sender.id, options.totalBytes);
    const tempPath = makeSiblingTempPath(options.targetPath);
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

    const session: ISerializedPdfPersistenceSession = {
        id,
        mode: options.mode,
        senderId: options.sender.id,
        sender: options.sender,
        workingPath: options.workingPath,
        targetPath: options.targetPath,
        saveAsOptions: options.saveAsOptions,
        tempPath,
        totalBytes: options.totalBytes,
        receivedBytes: 0,
        nextSeq: 0,
        maxChunkBytes: SERIALIZED_PDF_MAX_CHUNK_BYTES,
        portAttached: false,
        isCommitting: false,
        handle,
        timeout,
        queue: Promise.resolve(),
        unregisterSenderCleanup: () => undefined,
        releaseSenderReservation,
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
): Promise<IBeginSerializedPdfPersistenceResult> {
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const normalizedTotalBytes = normalizeTotalBytes(totalBytes);
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, context.senderId);

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
        throw new Error('Working copy path is not managed');
    }
    const session = await createSession({
        mode: 'save',
        sender: context.sender,
        workingPath: normalizedWorkingPath,
        targetPath: originalPath,
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
        totalBytes: normalizedTotalBytes,
    });

    return {
        sessionId: session.id,
        path: targetPath,
        ...getSerializedPdfPersistenceLimits(),
    };
}

async function finishSession(session: ISerializedPdfPersistenceSession) {
    if (session.receivedBytes !== session.totalBytes) {
        return createEmptyPdfValidationResult(
            `PDF persistence stream ended after ${session.receivedBytes} of ${session.totalBytes} bytes`,
        );
    }

    await session.handle.sync();
    await session.handle.close();
    const validation = await validatePdfFile(session.tempPath);
    if (!validation.isValid) {
        return validation;
    }
    const optimizedValidation = session.mode === 'save_as'
        ? await optimizePdfForSaveAs(session.tempPath, session.saveAsOptions)
        : await optimizeLargePdfForSave(session.tempPath);
    const committedValidation = optimizedValidation ?? validation;

    let conflictValidation: IPdfValidationResult | null = null;
    let syncWarningValidation: IPdfValidationResult | null = null;
    await enqueueWorkingCopyMutation(session.workingPath, async () => {
        if (!await ensureWorkingCopyDirectory(session.workingPath, session.senderId)) {
            throw new Error('Working copy path is not managed');
        }

        if (session.mode === 'save_as') {
            await atomicReplace(session.tempPath, session.targetPath);
            try {
                await copyFileCopyOnWrite(session.targetPath, session.workingPath);
            } catch (syncError) {
                syncWarningValidation = withWorkingCopySyncWarning(committedValidation, syncError);
            }
            setWorkingCopyOriginalPath(session.workingPath, session.targetPath, session.senderId);
            if (!syncWarningValidation) {
                await markWorkingCopyContentChanged(session.workingPath, 'save-sync', session.senderId);
            }
            allowOpenPath(session.targetPath, session.sender);
            await addRecentFile(session.targetPath);
            updateRecentFilesMenu();
        } else {
            if (!await originalPathSaveBaseMatches(session.workingPath, session.targetPath, session.senderId)) {
                conflictValidation = createOriginalChangedValidationResult();
                return;
            }
            await atomicReplace(session.tempPath, session.targetPath);
            try {
                await copyFileCopyOnWrite(session.targetPath, session.workingPath);
                refreshWorkingCopyOriginalFileExpectation(session.workingPath, session.senderId);
                await markWorkingCopyContentChanged(session.workingPath, 'save-sync', session.senderId);
            } catch (syncError) {
                syncWarningValidation = withWorkingCopySyncWarning(committedValidation, syncError);
            }
        }
    });

    return conflictValidation ?? syncWarningValidation ?? committedValidation;
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
        session.queue = session.queue.then(
            () => handlePortMessage(session, port, messageEvent),
            () => handlePortMessage(session, port, messageEvent),
        );
    });
    port.once('close', () => {
        if (sessions.get(session.id) === session && !session.isCommitting) {
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
        const normalizedMessage = normalizePdfPersistencePreloadToMainPayload(message);
        if (!isPdfPersistencePreloadToMainPayload(normalizedMessage)) {
            throw new Error(`Unknown PDF persistence message (${describePdfPersistenceMessage(normalizedMessage)})`);
        }
        const payload = normalizedMessage;
        refreshSessionTimeout(session);
        if (payload.type === 'chunk') {
            errorPhase = 'streaming';
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
            session.receivedBytes += bytes.byteLength;
            if (session.receivedBytes > session.totalBytes) {
                throw new Error('PDF persistence stream exceeded expected byte count');
            }

            await session.handle.write(bytes);
            port.postMessage(createPdfPersistenceAckFrame(session.nextSeq, session.receivedBytes));
            session.nextSeq += 1;
            return;
        }

        if (payload.type === 'complete') {
            errorPhase = 'complete';
            session.isCommitting = true;
            clearSessionTimeout(session);
            const validation = await finishSession(session);
            const path = validation.isValid ? session.targetPath : null;
            finishSessionLifecycle(session);
            if (!validation.isValid) {
                await cleanupSession(session);
            }
            port.postMessage(createPdfPersistenceResultFrame(path, validation));
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
