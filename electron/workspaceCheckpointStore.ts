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
    getWorkingCopyOriginalPath,
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

function canonicalizeCheckpointSources(
    checkpoint: IWorkspaceCheckpoint,
    ownerWebContentsId: number,
    options: {rejectUnmappedWorkingCopy: boolean},
) {
    return {
        ...checkpoint,
        tabs: checkpoint.tabs.map((tab) => {
            const workingCopySourceRef = tab.workingCopyRef
                ? getWorkingCopyOriginalPath(tab.workingCopyRef, ownerWebContentsId)?.originalPath
                : null;
            const sourceMapping = tab.sourceRef
                ? getWorkingCopyOriginalPath(tab.sourceRef, ownerWebContentsId)?.originalPath
                : null;
            const canonicalSourceRef = workingCopySourceRef ?? sourceMapping ?? tab.sourceRef;
            if (tab.workingCopyRef && !workingCopySourceRef && canonicalSourceRef === tab.workingCopyRef) {
                if (options.rejectUnmappedWorkingCopy) {
                    throw new Error('Workspace checkpoint working copy has no canonical source mapping');
                }
                return {
                    ...tab,
                    sourceRef: null,
                    workingCopyRef: null,
                };
            }
            return canonicalSourceRef === tab.sourceRef
                ? tab
                : {
                    ...tab,
                    sourceRef: canonicalSourceRef,
                };
        }),
    } satisfies IWorkspaceCheckpoint;
}

export async function saveWorkspaceCheckpoint(checkpoint: IWorkspaceCheckpoint, ownerWebContentsId: number) {
    for (const tab of checkpoint.tabs) {
        if (tab.workingCopyRef && getWorkingCopyOwnerWebContentsId(tab.workingCopyRef) !== ownerWebContentsId) {
            throw new Error('Workspace checkpoint contains an unowned working copy');
        }
    }
    const canonicalCheckpoint = canonicalizeCheckpointSources(
        checkpoint,
        ownerWebContentsId,
        {rejectUnmappedWorkingCopy: true},
    );
    const storagePath = getStoragePath();
    const tempPath = makeSiblingTempPath(storagePath);
    const stored: IStoredWorkspaceCheckpoint = {
        version: 1,
        ownerWebContentsId,
        checkpoint: canonicalCheckpoint,
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
    const canonicalCheckpoint = canonicalizeCheckpointSources(
        stored.checkpoint,
        stored.ownerWebContentsId,
        {rejectUnmappedWorkingCopy: false},
    );
    for (const tab of canonicalCheckpoint.tabs) {
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
    return canonicalCheckpoint;
}

export function clearWorkspaceCheckpoint() {
    return rm(getStoragePath(), {force: true});
}
