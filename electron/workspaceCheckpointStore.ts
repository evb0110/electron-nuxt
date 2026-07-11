import { app } from 'electron';
import {
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
    decodeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
} from '@contracts/workspaceCheckpoint';
import { isRecord } from '@contracts/runtimeGuards';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    claimWorkingCopyOwnership,
    getWorkingCopyOwnerWebContentsId,
    setWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';

interface IStoredWorkspaceCheckpoint {
    version: 1;
    ownerWebContentsId: number;
    checkpoint: IWorkspaceCheckpoint;
}

function getStoragePath() {
    return join(app.getPath('userData'), 'workspace-checkpoint.json');
}

function decodeStoredCheckpoint(value: unknown): IStoredWorkspaceCheckpoint | null {
    if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.ownerWebContentsId)) {
        return null;
    }
    const checkpoint = decodeWorkspaceCheckpoint(value.checkpoint);
    return checkpoint
        ? {
            version: 1,
            ownerWebContentsId: value.ownerWebContentsId as number,
            checkpoint,
        }
        : null;
}

export async function saveWorkspaceCheckpoint(checkpoint: IWorkspaceCheckpoint, ownerWebContentsId: number) {
    for (const tab of checkpoint.tabs) {
        if (tab.workingCopyRef && getWorkingCopyOwnerWebContentsId(tab.workingCopyRef) !== ownerWebContentsId) {
            throw new Error('Workspace checkpoint contains an unowned working copy');
        }
    }
    const storagePath = getStoragePath();
    const tempPath = makeSiblingTempPath(storagePath);
    const stored: IStoredWorkspaceCheckpoint = {
        version: 1,
        ownerWebContentsId,
        checkpoint,
    };
    await writeFile(tempPath, JSON.stringify(stored, null, 2), 'utf-8');
    await atomicReplace(tempPath, storagePath);
}

export async function claimWorkspaceCheckpoint(newOwnerWebContentsId: number) {
    let stored: IStoredWorkspaceCheckpoint | null = null;
    try {
        stored = decodeStoredCheckpoint(JSON.parse(await readFile(getStoragePath(), 'utf-8')));
    } catch {
        return null;
    }
    if (!stored) {
        return null;
    }
    for (const tab of stored.checkpoint.tabs) {
        if (tab.workingCopyRef) {
            const transferred = claimWorkingCopyOwnership(
                tab.workingCopyRef,
                stored.ownerWebContentsId,
                newOwnerWebContentsId,
            );
            if (!transferred && tab.sourceRef) {
                await setWorkingCopyOriginalPath(tab.workingCopyRef, tab.sourceRef, newOwnerWebContentsId);
            }
        }
    }
    await rm(getStoragePath(), {force: true});
    return stored.checkpoint;
}

export function clearWorkspaceCheckpoint() {
    return rm(getStoragePath(), {force: true});
}
