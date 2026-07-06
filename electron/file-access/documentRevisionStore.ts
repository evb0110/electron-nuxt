import { randomUUID } from 'node:crypto';
import {
    existsSync,
    statSync,
} from 'fs';
import {
    basename,
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from 'path';
import type {
    IDocumentRevisionChangedEvent,
    IDocumentRevisionInfo,
    TDocumentRevisionChangeReason,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { createWorkingCopySyncRequiredError } from '@contracts/documentMutationErrors';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    assertWorkingCopyRevisionSidecarCurrent,
    getWorkingCopyRevisionSidecarPath,
    readWorkingCopyRevisionSidecar,
    writeWorkingCopyRevisionSidecar,
    type IWorkingCopyRevisionSidecar,
} from '@electron/file-access/documentRevisionSidecar';
import {
    getWorkingCopyOwnerWebContentsId,
    getWorkingCopyRegistrationId,
    normalizePathForLookup,
    workingCopyMap,
} from '@electron/file-access/workingCopyStore';
import { isWorkingCopyDirectoryName } from '@electron/file-access/workingCopyDirectory';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { clearWorkingCopyOcrArtifacts } from '@electron/file-access/workingCopyMutationQueue';

const log = createLogger('documentRevisionStore');
const revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();
const generatedRegistrationIds = new Map<string, string>();
const workingCopySyncRequired = new Map<string, string>();
let nextGeneratedRegistrationId = 0;

function getRevisionQueueKey(workingCopyPath: string) {
    return normalizePathForLookup(workingCopyPath) || workingCopyPath;
}

function isExistingFile(workingCopyPath: string) {
    try {
        return statSync(workingCopyPath).isFile();
    } catch {
        return false;
    }
}

function isUnregisteredWorkingCopyPath(workingCopyPath: string) {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingPath || !isAbsolute(normalizedWorkingPath) || !isExistingFile(normalizedWorkingPath)) {
        return false;
    }

    const tempDir = resolve(getAppTempDir());
    const parentDir = resolve(dirname(normalizedWorkingPath));
    const relativePath = relative(tempDir, parentDir);
    return (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
        && isWorkingCopyDirectoryName(basename(parentDir))
    );
}

function assertCanUseWorkingCopyRevision(workingCopyPath: string, senderId?: number) {
    const ownerWebContentsId = getWorkingCopyOwnerWebContentsId(workingCopyPath);
    if (typeof ownerWebContentsId === 'number' && ownerWebContentsId !== senderId) {
        throw new Error('Working copy path is owned by another sender');
    }
    if (workingCopyMap.has(workingCopyPath) || isUnregisteredWorkingCopyPath(workingCopyPath)) {
        return;
    }
    if (existsSync(getWorkingCopyRevisionSidecarPath(workingCopyPath))) {
        return;
    }

    throw new Error('Working copy path is not managed');
}

function getTokenRegistrationId(workingCopyPath: string, senderId?: number) {
    const registrationId = getWorkingCopyRegistrationId(workingCopyPath, senderId);
    if (registrationId !== null) {
        return String(registrationId);
    }

    const queueKey = getRevisionQueueKey(workingCopyPath);
    const existing = generatedRegistrationIds.get(queueKey);
    if (existing) {
        return existing;
    }

    const generated = `generated-${nextGeneratedRegistrationId += 1}`;
    generatedRegistrationIds.set(queueKey, generated);
    return generated;
}

function createRevisionSidecar(
    workingCopyPath: string,
    contentRevision: number,
    senderId?: number,
): IWorkingCopyRevisionSidecar {
    const mintedAt = Date.now();
    return {
        sidecarVersion: 1,
        version: 1,
        documentRef: workingCopyPath,
        authority: 'electron-working-copy',
        token: `drt1:${getTokenRegistrationId(workingCopyPath, senderId)}:${contentRevision}:${randomUUID()}`,
        contentRevision,
        mintedAt,
        updatedAt: mintedAt,
    };
}

function toRevisionInfo(sidecar: IWorkingCopyRevisionSidecar): IDocumentRevisionInfo {
    return {
        version: 1,
        documentRef: sidecar.documentRef,
        authority: sidecar.authority,
        token: sidecar.token,
        contentRevision: sidecar.contentRevision,
        mintedAt: sidecar.mintedAt,
    };
}

function notifyRevisionChanged(event: IDocumentRevisionChangedEvent) {
    for (const listener of revisionListeners) {
        try {
            listener(event);
        } catch (error) {
            log.debug(`Failed to notify document revision listener: ${getErrorMessage(error)}`);
        }
    }
}

export async function ensureWorkingCopyRevision(
    workingCopyPath: string,
    senderId?: number,
): Promise<IDocumentRevisionInfo> {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    assertCanUseWorkingCopyRevision(normalizedWorkingPath, senderId);

    const existing = await readWorkingCopyRevisionSidecar(normalizedWorkingPath);
    if (existing) {
        return toRevisionInfo(existing);
    }

    const sidecar = createRevisionSidecar(normalizedWorkingPath, 1, senderId);
    await writeWorkingCopyRevisionSidecar(normalizedWorkingPath, sidecar);
    return toRevisionInfo(sidecar);
}

export function getWorkingCopyRevision(workingCopyPath: string, senderId?: number) {
    return ensureWorkingCopyRevision(workingCopyPath, senderId);
}

export async function markWorkingCopyRevisionChanged(
    workingCopyPath: string,
    reason: TDocumentRevisionChangeReason,
    senderId?: number,
): Promise<IDocumentRevisionChangedEvent> {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    assertCanUseWorkingCopyRevision(normalizedWorkingPath, senderId);

    const previous = await readWorkingCopyRevisionSidecar(normalizedWorkingPath);
    const contentRevision = (previous?.contentRevision ?? 0) + 1;
    const sidecar = createRevisionSidecar(normalizedWorkingPath, contentRevision, senderId);
    await writeWorkingCopyRevisionSidecar(normalizedWorkingPath, sidecar);

    const event: IDocumentRevisionChangedEvent = {
        ...toRevisionInfo(sidecar),
        ...(previous?.token ? {previousToken: previous.token} : {}),
        reason,
    };
    notifyRevisionChanged(event);
    return event;
}

export async function markWorkingCopyContentChanged(
    workingCopyPath: string,
    reason: TDocumentRevisionChangeReason,
    senderId?: number,
): Promise<IDocumentRevisionChangedEvent> {
    const event = await markWorkingCopyRevisionChanged(workingCopyPath, reason, senderId);
    await clearWorkingCopyOcrArtifacts(workingCopyPath);
    return event;
}

export function isWorkingCopyRevisionCurrent(
    workingCopyPath: string,
    token: TDocumentRevisionToken,
): Promise<boolean> {
    return readWorkingCopyRevisionSidecar(workingCopyPath)
        .then(sidecar => sidecar?.token === token);
}

export async function assertWorkingCopyRevisionCurrent(
    workingCopyPath: string,
    token: TDocumentRevisionToken,
): Promise<void> {
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, token);
}

export function assertWorkingCopyMutationAllowed(workingCopyPath: string) {
    const reason = workingCopySyncRequired.get(getRevisionQueueKey(workingCopyPath));
    if (reason !== undefined) {
        throw createWorkingCopySyncRequiredError({
            documentRef: workingCopyPath,
            message: reason,
        });
    }
}

export function markWorkingCopySyncRequired(workingCopyPath: string, reason: string) {
    workingCopySyncRequired.set(
        getRevisionQueueKey(workingCopyPath),
        reason,
    );
}

export function clearWorkingCopySyncRequired(workingCopyPath: string) {
    workingCopySyncRequired.delete(getRevisionQueueKey(workingCopyPath));
}

export function onWorkingCopyRevisionChanged(listener: (event: IDocumentRevisionChangedEvent) => void) {
    revisionListeners.add(listener);
    return () => {
        revisionListeners.delete(listener);
    };
}
