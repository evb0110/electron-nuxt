import { randomUUID } from 'node:crypto';
import {
    copyFile,
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
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { getErrorMessage } from '@electron/utils/error';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';
import {
    getWorkingCopyOriginalPath,
    setWorkingCopyOriginalPath,
} from '@electron/ipc/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/ipc/workingCopyValidation';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
import { allowOpenPath } from '@electron/ipc/openPathCapabilities';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';

const SERIALIZED_PDF_SESSION_TIMEOUT_MS = 10 * 60_000;

type TSerializedPdfPersistenceMode = 'save' | 'save_as';

interface ISerializedPdfPersistenceSession {
    id: string;
    mode: TSerializedPdfPersistenceMode;
    senderId: number;
    workingPath: string;
    targetPath: string;
    tempPath: string;
    totalBytes: number;
    receivedBytes: number;
    nextSeq: number;
    handle: FileHandle;
    timeout: NodeJS.Timeout;
    queue: Promise<void>;
    unregisterSenderCleanup: () => void;
}

export interface IBeginSerializedPdfPersistenceResult {sessionId: string;}

export interface IBeginSerializedPdfSaveAsResult {
    sessionId: string | null;
    path: string | null;
}

const sessions = new Map<string, ISerializedPdfPersistenceSession>();

function getPdfPersistencePortMessageData(messageEvent: unknown): unknown {
    if (!messageEvent || typeof messageEvent !== 'object' || !('data' in messageEvent)) {
        return messageEvent;
    }

    const data = messageEvent.data;
    if (data == null) {
        return messageEvent;
    }

    return getPdfPersistencePortMessageData(data);
}

function createEmptyPdfValidationResult(message: string): IPdfValidationResult {
    return {
        isValid: false,
        tool: 'qpdf',
        errors: [message],
        warnings: [],
    };
}

function normalizeWorkingPath(workingPath: unknown) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }

    return normalizedWorkingPath;
}

function normalizeTotalBytes(totalBytes: unknown): number {
    if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
        throw new Error('Invalid total byte count');
    }

    return totalBytes;
}

function getValidatedOriginalPath(workingPath: string) {
    const originalPath = getWorkingCopyOriginalPath(workingPath)?.originalPath;
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
    sessions.delete(session.id);
    await session.handle.close().catch(() => undefined);
    await rm(session.tempPath, { force: true }).catch(() => undefined);
}

function registerSessionSenderCleanup(sender: WebContents, getSession: () => ISerializedPdfPersistenceSession) {
    const cleanup = () => {
        const session = getSession();
        if (sessions.get(session.id) === session) {
            void cleanupSession(session);
        }
    };

    const handleDestroyed = () => {
        cleanup();
    };
    const handleRenderProcessGone = () => {
        cleanup();
    };

    sender.once('destroyed', handleDestroyed);
    sender.once('render-process-gone', handleRenderProcessGone);

    return () => {
        sender.removeListener('destroyed', handleDestroyed);
        sender.removeListener('render-process-gone', handleRenderProcessGone);
    };
}

async function createSession(options: {
    mode: TSerializedPdfPersistenceMode;
    sender: WebContents;
    workingPath: string;
    targetPath: string;
    totalBytes: number;
}) {
    const tempPath = makeSiblingTempPath(options.targetPath);
    const handle = await open(tempPath, 'wx');
    const id = randomUUID();
    const timeout = setTimeout(() => undefined, SERIALIZED_PDF_SESSION_TIMEOUT_MS);
    timeout.unref?.();

    const session: ISerializedPdfPersistenceSession = {
        id,
        mode: options.mode,
        senderId: options.sender.id,
        workingPath: options.workingPath,
        targetPath: options.targetPath,
        tempPath,
        totalBytes: options.totalBytes,
        receivedBytes: 0,
        nextSeq: 0,
        handle,
        timeout,
        queue: Promise.resolve(),
        unregisterSenderCleanup: () => undefined,
    };
    session.unregisterSenderCleanup = registerSessionSenderCleanup(options.sender, () => session);
    refreshSessionTimeout(session);
    sessions.set(id, session);
    return session;
}

export async function beginSerializedPdfSaveToOriginal(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    totalBytes: unknown,
): Promise<IBeginSerializedPdfPersistenceResult> {
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const normalizedTotalBytes = normalizeTotalBytes(totalBytes);
    const originalPath = getValidatedOriginalPath(normalizedWorkingPath);

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath)) {
        throw new Error('Working copy path is not managed');
    }
    const session = await createSession({
        mode: 'save',
        sender: event.sender,
        workingPath: normalizedWorkingPath,
        targetPath: originalPath,
        totalBytes: normalizedTotalBytes,
    });

    return { sessionId: session.id };
}

export async function beginSerializedPdfSaveAs(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    totalBytes: unknown,
    targetPath: string | null,
): Promise<IBeginSerializedPdfSaveAsResult> {
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const normalizedTotalBytes = normalizeTotalBytes(totalBytes);
    if (!targetPath) {
        return {
            sessionId: null,
            path: null,
        };
    }

    const session = await createSession({
        mode: 'save_as',
        sender: event.sender,
        workingPath: normalizedWorkingPath,
        targetPath,
        totalBytes: normalizedTotalBytes,
    });

    return {
        sessionId: session.id,
        path: targetPath,
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

    if (session.mode === 'save_as') {
        if (!await ensureWorkingCopyDirectory(session.workingPath)) {
            throw new Error('Working copy path is not managed');
        }
        await copyFile(session.tempPath, session.workingPath);
        await atomicReplace(session.tempPath, session.targetPath);
        setWorkingCopyOriginalPath(session.workingPath, session.targetPath);
        allowOpenPath(session.targetPath, session.senderId);
        await addRecentFile(session.targetPath);
        updateRecentFilesMenu();
    } else {
        await atomicReplace(session.tempPath, session.targetPath);
        await copyFile(session.targetPath, session.workingPath);
    }

    return validation;
}

function getChunkBytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    throw new Error('Invalid PDF persistence chunk');
}

function describePersistenceMessage(message: unknown) {
    if (!message || typeof message !== 'object') {
        return typeof message;
    }

    return `keys=${Object.keys(message).join(',')}`;
}

function isPdfPersistencePortPayload(message: unknown): message is {
    type?: unknown;
    seq?: unknown;
    bytes?: unknown;
} {
    return Boolean(message && typeof message === 'object' && 'type' in message);
}

function normalizePdfPersistencePortPayload(message: unknown): unknown {
    let currentMessage = message;
    for (let depth = 0; depth < 4; depth += 1) {
        if (isPdfPersistencePortPayload(currentMessage)) {
            return currentMessage;
        }
        if (!currentMessage || typeof currentMessage !== 'object' || !('data' in currentMessage)) {
            return currentMessage;
        }

        const nextMessage = currentMessage.data;
        if (nextMessage == null || nextMessage === currentMessage) {
            return currentMessage;
        }
        currentMessage = nextMessage;
    }

    return currentMessage;
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
    const port = event.ports[0];
    if (!port) {
        throw new Error('PDF persistence MessagePort is missing');
    }

    port.on('message', (messageEvent) => {
        const messageData = getPdfPersistencePortMessageData(messageEvent);
        session.queue = session.queue.then(
            () => handlePortMessage(session, port, messageData),
            () => handlePortMessage(session, port, messageData),
        );
    });
    port.once('close', () => {
        if (sessions.get(session.id) === session) {
            void cleanupSession(session);
        }
    });
    port.start();
    port.postMessage({ type: 'ready' });
}

async function handlePortMessage(
    session: ISerializedPdfPersistenceSession,
    port: MessagePortMain,
    message: unknown,
) {
    try {
        const normalizedMessage = normalizePdfPersistencePortPayload(message);
        if (!normalizedMessage || typeof normalizedMessage !== 'object') {
            throw new Error('Invalid PDF persistence message');
        }

        const payload = normalizedMessage as {
            type?: unknown;
            seq?: unknown;
            bytes?: unknown;
        };
        refreshSessionTimeout(session);
        if (payload.type === 'chunk') {
            if (payload.seq !== session.nextSeq) {
                throw new Error('Unexpected PDF persistence chunk sequence');
            }

            const bytes = getChunkBytes(payload.bytes);
            session.receivedBytes += bytes.byteLength;
            if (session.receivedBytes > session.totalBytes) {
                throw new Error('PDF persistence stream exceeded expected byte count');
            }

            await session.handle.write(bytes);
            port.postMessage({
                type: 'ack',
                seq: session.nextSeq,
                receivedBytes: session.receivedBytes,
            });
            session.nextSeq += 1;
            return;
        }

        if (payload.type === 'complete') {
            const validation = await finishSession(session);
            const path = validation.isValid ? session.targetPath : null;
            sessions.delete(session.id);
            clearSessionTimeout(session);
            session.unregisterSenderCleanup();
            if (!validation.isValid) {
                await cleanupSession(session);
            }
            port.postMessage({
                type: 'result',
                path,
                validation,
            });
            port.close();
            return;
        }

        throw new Error(`Unknown PDF persistence message (${describePersistenceMessage(normalizedMessage)})`);
    } catch (error) {
        await cleanupSession(session);
        port.postMessage({
            type: 'error',
            error: getErrorMessage(error),
        });
        port.close();
    }
}
