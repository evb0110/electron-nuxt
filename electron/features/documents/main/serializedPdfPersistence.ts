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
}

export interface IBeginSerializedPdfPersistenceResult {sessionId: string;}

export interface IBeginSerializedPdfSaveAsResult {
    sessionId: string | null;
    path: string | null;
}

const sessions = new Map<string, ISerializedPdfPersistenceSession>();

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
    sessions.delete(session.id);
    await session.handle.close().catch(() => undefined);
    await rm(session.tempPath, { force: true }).catch(() => undefined);
}

async function createSession(options: {
    mode: TSerializedPdfPersistenceMode;
    senderId: number;
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
        senderId: options.senderId,
        workingPath: options.workingPath,
        targetPath: options.targetPath,
        tempPath,
        totalBytes: options.totalBytes,
        receivedBytes: 0,
        nextSeq: 0,
        handle,
        timeout,
        queue: Promise.resolve(),
    };
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

    await ensureWorkingCopyDirectory(normalizedWorkingPath);
    const session = await createSession({
        mode: 'save',
        senderId: event.sender.id,
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
        senderId: event.sender.id,
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

    await atomicReplace(session.tempPath, session.targetPath);
    if (session.mode === 'save_as') {
        await ensureWorkingCopyDirectory(session.workingPath);
        await copyFile(session.targetPath, session.workingPath);
        setWorkingCopyOriginalPath(session.workingPath, session.targetPath);
        allowOpenPath(session.targetPath, session.senderId);
        await addRecentFile(session.targetPath);
        updateRecentFilesMenu();
    } else {
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
        session.queue = session.queue.then(
            () => handlePortMessage(session, port, messageEvent.data),
            () => handlePortMessage(session, port, messageEvent.data),
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
        if (!message || typeof message !== 'object') {
            throw new Error('Invalid PDF persistence message');
        }

        const payload = message as {
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
            session.nextSeq += 1;
            return;
        }

        if (payload.type === 'complete') {
            const validation = await finishSession(session);
            const path = validation.isValid ? session.targetPath : null;
            sessions.delete(session.id);
            clearSessionTimeout(session);
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

        throw new Error('Unknown PDF persistence message');
    } catch (error) {
        await cleanupSession(session);
        port.postMessage({
            type: 'error',
            error: getErrorMessage(error),
        });
        port.close();
    }
}
