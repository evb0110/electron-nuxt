import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { decodeWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { WORKSPACE_RECOVERY_STORE } from '@app/platform/browser/browserDocumentConstants';
import {
    runObjectStoreTransaction,
    withObjectStoreReadResult,
} from '@app/platform/browser/browserDocumentIdb';

interface IBrowserWorkspaceRecoveryRecord {
    id: string;
    ownerId: string;
    generation: number;
    checkpoint: IWorkspaceCheckpoint;
    snapshotRefs: string[];
    updatedAt: number;
}

interface IBrowserWorkspaceRecoverySnapshot {
    ownerId: string;
    generation: number;
    checkpoint: IWorkspaceCheckpoint;
    snapshotRefs: string[];
    updatedAt: number;
}

export type TBrowserWorkspaceRecoveryMutationResult =
    | {
        saved: true;
        generation: number
    }
    | {
        saved: false;
        generation: number
    };

export type TBrowserWorkspaceRecoveryClaimResult =
    | {
        claimed: true;
        generation: number
    }
    | {
        claimed: false;
        generation: number
    };

function getRecoveryRecordId(ownerId: string) {
    return `owner:${ownerId}`;
}

function isValidOwnerId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function decodeRecoveryRecord(value: unknown): IBrowserWorkspaceRecoverySnapshot | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const checkpoint = decodeWorkspaceCheckpoint(record.checkpoint);
    const snapshotRefs = record.snapshotRefs;
    if (
        !isValidOwnerId(record.ownerId)
        || record.id !== getRecoveryRecordId(record.ownerId)
        || typeof record.generation !== 'number'
        || !Number.isSafeInteger(record.generation)
        || record.generation <= 0
        || !checkpoint
        || !Array.isArray(snapshotRefs)
        || snapshotRefs.some((ref: unknown) => typeof ref !== 'string')
        || typeof record.updatedAt !== 'number'
        || !Number.isFinite(record.updatedAt)
    ) {
        return null;
    }
    const checkpointRefs = new Set(checkpoint.tabs.flatMap(tab => (
        tab.workingCopyRef ? [tab.workingCopyRef] : []
    )));
    return {
        ownerId: record.ownerId,
        generation: record.generation,
        checkpoint,
        snapshotRefs: Array.from(new Set(snapshotRefs.filter(
            (ref: unknown): ref is string => typeof ref === 'string' && checkpointRefs.has(ref),
        ))),
        updatedAt: record.updatedAt,
    };
}

export async function loadBrowserWorkspaceRecoveries() {
    const result = await withObjectStoreReadResult<unknown[]>(
        WORKSPACE_RECOVERY_STORE,
        store => store.getAll(),
    );
    if (!result.available || !Array.isArray(result.value)) {
        return [];
    }
    return result.value.flatMap((value) => {
        const decoded = decodeRecoveryRecord(value);
        return decoded ? [decoded] : [];
    });
}

export async function loadBrowserWorkspaceRecovery(ownerId: string) {
    if (!isValidOwnerId(ownerId)) {
        return null;
    }
    const result = await withObjectStoreReadResult<unknown>(
        WORKSPACE_RECOVERY_STORE,
        store => store.get(getRecoveryRecordId(ownerId)),
    );
    return result.available ? decodeRecoveryRecord(result.value) : null;
}

export async function loadBrowserWorkspaceRecoveryLeasedRefs() {
    return new Set((await loadBrowserWorkspaceRecoveries()).flatMap(record => record.snapshotRefs));
}

async function mutateBrowserWorkspaceRecovery(
    ownerId: string,
    expectedGeneration: number,
    mutate: (
        store: IDBObjectStore,
        id: string,
        current: IBrowserWorkspaceRecoverySnapshot | null,
        currentGeneration: number,
    ) => number,
) {
    if (!isValidOwnerId(ownerId) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
        throw new TypeError('Browser recovery owner and generation must be valid.');
    }
    const id = getRecoveryRecordId(ownerId);
    const outcome = await runObjectStoreTransaction<TBrowserWorkspaceRecoveryMutationResult>(
        WORKSPACE_RECOVERY_STORE,
        'readwrite',
        (store, setResult) => {
            const read = store.get(id);
            read.onsuccess = () => {
                const current = decodeRecoveryRecord(read.result);
                const currentGeneration = current?.generation ?? 0;
                if (currentGeneration !== expectedGeneration) {
                    setResult({
                        saved: false,
                        generation: currentGeneration,
                    });
                    return;
                }
                setResult({
                    saved: true,
                    generation: mutate(store, id, current, currentGeneration),
                });
            };
        },
    );
    if (!outcome) {
        throw new Error('IndexedDB browser recovery mutation did not commit.');
    }
    return outcome;
}

export async function saveBrowserWorkspaceRecovery(
    ownerId: string,
    expectedGeneration: number,
    checkpoint: IWorkspaceCheckpoint,
    snapshotRefs: string[],
): Promise<TBrowserWorkspaceRecoveryMutationResult> {
    return mutateBrowserWorkspaceRecovery(ownerId, expectedGeneration, (store, id, _current, currentGeneration) => {
        const generation = currentGeneration + 1;
        const record: IBrowserWorkspaceRecoveryRecord = {
            id,
            ownerId,
            generation,
            checkpoint,
            snapshotRefs: Array.from(new Set(snapshotRefs)),
            updatedAt: Date.now(),
        };
        store.put(record);
        return generation;
    });
}

export async function clearBrowserWorkspaceRecovery(
    ownerId: string,
    expectedGeneration: number,
): Promise<TBrowserWorkspaceRecoveryMutationResult> {
    return mutateBrowserWorkspaceRecovery(ownerId, expectedGeneration, (store, id, current) => {
        if (current) store.delete(id);
        return 0;
    });
}

export async function claimBrowserWorkspaceRecoveryOwner(
    sourceOwnerId: string,
    targetOwnerId: string,
    expectedGeneration: number,
): Promise<TBrowserWorkspaceRecoveryClaimResult> {
    if (
        !isValidOwnerId(sourceOwnerId)
        || !isValidOwnerId(targetOwnerId)
        || sourceOwnerId === targetOwnerId
        || !Number.isSafeInteger(expectedGeneration)
        || expectedGeneration <= 0
    ) {
        throw new TypeError('Browser recovery claim owners and generation must be valid.');
    }
    const sourceId = getRecoveryRecordId(sourceOwnerId);
    const targetId = getRecoveryRecordId(targetOwnerId);
    const outcome = await runObjectStoreTransaction<TBrowserWorkspaceRecoveryClaimResult>(
        WORKSPACE_RECOVERY_STORE,
        'readwrite',
        (store, setResult) => {
            const recordsRead = store.getAll();
            recordsRead.onsuccess = () => {
                const records = Array.isArray(recordsRead.result) ? recordsRead.result : [];
                const source = records
                    .map(decodeRecoveryRecord)
                    .find(record => record?.ownerId === sourceOwnerId) ?? null;
                if (!source || source.generation !== expectedGeneration) {
                    setResult({
                        claimed: false,
                        generation: source?.generation ?? 0,
                    });
                    return;
                }
                const target = records
                    .map(decodeRecoveryRecord)
                    .find(record => record?.ownerId === targetOwnerId) ?? null;
                if (target) {
                    setResult({
                        claimed: false,
                        generation: target.generation,
                    });
                    return;
                }
                const generation = source.generation + 1;
                store.delete(sourceId);
                store.put({
                    id: targetId,
                    ownerId: targetOwnerId,
                    generation,
                    checkpoint: source.checkpoint,
                    snapshotRefs: source.snapshotRefs,
                    updatedAt: Date.now(),
                } satisfies IBrowserWorkspaceRecoveryRecord);
                setResult({
                    claimed: true,
                    generation,
                });
            };
        },
    );
    if (!outcome) throw new Error('IndexedDB browser recovery owner claim did not commit.');
    return outcome;
}
