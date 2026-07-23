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

interface IWorkspaceCheckpointSaveWaiter {
    resolve(): void;
    reject(error: unknown): void;
}

interface IPendingWorkspaceCheckpointSave {
    stored: IStoredWorkspaceCheckpoint;
    waiters: IWorkspaceCheckpointSaveWaiter[];
}

let checkpointWriteInFlight: Promise<void> | null = null;
let pendingLatestCheckpointSave: IPendingWorkspaceCheckpointSave | null = null;
let checkpointBarrierQueue: Promise<unknown> = Promise.resolve();

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

async function writeStoredWorkspaceCheckpoint(stored: IStoredWorkspaceCheckpoint) {
    const storagePath = getStoragePath();
    const tempPath = makeSiblingTempPath(storagePath);
    await writeFile(tempPath, JSON.stringify(stored, null, 2), 'utf-8');
    await atomicReplace(tempPath, storagePath);
}

function settleCheckpointSave(
    save: IPendingWorkspaceCheckpointSave,
    error?: unknown,
) {
    for (const waiter of save.waiters) {
        if (error === undefined) {
            waiter.resolve();
        } else {
            waiter.reject(error);
        }
    }
}

function startCheckpointWriteDrain(initialSave: IPendingWorkspaceCheckpointSave) {
    checkpointWriteInFlight = (async () => {
        let currentSave: IPendingWorkspaceCheckpointSave | null = initialSave;
        while (currentSave) {
            try {
                await writeStoredWorkspaceCheckpoint(currentSave.stored);
                settleCheckpointSave(currentSave);
            } catch (error) {
                settleCheckpointSave(currentSave, error);
            }
            currentSave = pendingLatestCheckpointSave;
            pendingLatestCheckpointSave = null;
        }
    })().finally(() => {
        checkpointWriteInFlight = null;
        if (pendingLatestCheckpointSave) {
            const nextSave = pendingLatestCheckpointSave;
            pendingLatestCheckpointSave = null;
            startCheckpointWriteDrain(nextSave);
        }
    });
}

function enqueueWorkspaceCheckpointSave(stored: IStoredWorkspaceCheckpoint) {
    return new Promise<void>((resolve, reject) => {
        const waiter = {
            resolve,
            reject,
        };
        if (!checkpointWriteInFlight) {
            startCheckpointWriteDrain({
                stored,
                waiters: [waiter],
            });
            return;
        }
        if (pendingLatestCheckpointSave) {
            pendingLatestCheckpointSave = {
                stored,
                waiters: [
                    ...pendingLatestCheckpointSave.waiters,
                    waiter,
                ],
            };
            return;
        }
        pendingLatestCheckpointSave = {
            stored,
            waiters: [waiter],
        };
    });
}

async function drainWorkspaceCheckpointWrites() {
    while (checkpointWriteInFlight) {
        await checkpointWriteInFlight;
    }
}

function enqueueWorkspaceCheckpointBarrier<T>(operation: () => Promise<T>) {
    const barrier = checkpointBarrierQueue.then(async () => {
        await drainWorkspaceCheckpointWrites();
        return operation();
    });
    checkpointBarrierQueue = barrier.then(() => undefined, () => undefined);
    return barrier;
}

export async function saveWorkspaceCheckpoint(checkpoint: IWorkspaceCheckpoint, ownerWebContentsId: number) {
    const validatedCheckpoint = decodeWorkspaceCheckpoint(checkpoint);
    if (!validatedCheckpoint) {
        throw new Error('Invalid workspace checkpoint');
    }
    for (const tab of validatedCheckpoint.tabs) {
        if (tab.workingCopyRef && getWorkingCopyOwnerWebContentsId(tab.workingCopyRef) !== ownerWebContentsId) {
            throw new Error('Workspace checkpoint contains an unowned working copy');
        }
    }
    const canonicalCheckpoint = canonicalizeCheckpointSources(
        validatedCheckpoint,
        ownerWebContentsId,
        {rejectUnmappedWorkingCopy: true},
    );
    const stored: IStoredWorkspaceCheckpoint = {
        version: 1,
        ownerWebContentsId,
        checkpoint: canonicalCheckpoint,
    };
    await checkpointBarrierQueue;
    return enqueueWorkspaceCheckpointSave(stored);
}

export async function claimWorkspaceCheckpoint(newOwnerWebContentsId: number) {
    return enqueueWorkspaceCheckpointBarrier(async () => {
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
    });
}

export function clearWorkspaceCheckpoint() {
    return enqueueWorkspaceCheckpointBarrier(() => rm(getStoragePath(), {force: true}));
}
