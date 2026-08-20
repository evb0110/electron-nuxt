import {
    BROWSER_CHUNK_WRITE_YIELD_EVERY,
    BROWSER_DOCUMENT_CHUNK_SIZE,
    DOCUMENTS_STORE,
    DOCUMENT_CHUNKS_STORE,
    WORKSPACE_RECOVERY_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import { uniq } from 'es-toolkit/array';
import { buildRecentFilesFromPersistedRecords } from '@app/platform/browser/buildRecentFilesFromPersistedRecords';
import {
    collectChunkIndicesByRef,
    countNonWorkingDependents,
    isChunkedRecordMissingChunks,
    shouldRemovePersistedRecord,
    toPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentRecords';
import {
    loadAllRecordKeysAvailability,
    loadRecordAvailability,
    runObjectStoresTransaction,
} from '@app/platform/browser/browserDocumentIdb';
import {
    createChunkKey,
    loadAllChunkKeysAvailability,
    parseChunkKey,
} from '@app/platform/browser/browserDocumentChunks';
import {
    hasRecentFilesStorageSnapshot,
    pruneRecentFiles,
    readRecentFilesFromStorage,
    writeRecentFilesToStorage,
} from '@app/platform/browser/browserRecentFilesStore';
import type {
    IBrowserDocumentEntry,
    IBrowserPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentTypes';
import type { IBrowserPersistedDocumentRecordsLoadResult } from '@app/platform/browser/browserPersistedDocumentRecordsLoadResult';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import { loadBrowserWorkspaceRecoveryLeasedRefs } from '@app/platform/browser/browserWorkspaceRecoveryStore';

export async function loadBrowserPersistedDocumentRecordsResult(): Promise<IBrowserPersistedDocumentRecordsLoadResult> {
    const rawKeysResult = await loadAllRecordKeysAvailability();
    if (!rawKeysResult.available) {
        return {
            available: false,
            records: [],
        };
    }

    const rawKeys = rawKeysResult.value;
    if (!Array.isArray(rawKeys)) {
        return {
            available: true,
            records: [],
        };
    }

    const records: IBrowserPersistedDocumentRecord[] = [];
    for (const key of rawKeys) {
        if (typeof key !== 'string') {
            continue;
        }
        const recordResult = await loadRecordAvailability(key);
        if (!recordResult.available) {
            return {
                available: false,
                records: [],
            };
        }
        const record = toPersistedDocumentRecord(recordResult.value);
        if (!record) {
            continue;
        }
        records.push({
            ...record,
            data: new Uint8Array(),
        });
        if (records.length % BROWSER_CHUNK_WRITE_YIELD_EVERY === 0) {
            await yieldToBrowser();
        }
    }

    return {
        available: true,
        records,
    };
}

export async function loadBrowserPersistedDocumentRecords(): Promise<IBrowserPersistedDocumentRecord[]> {
    return (await loadBrowserPersistedDocumentRecordsResult()).records;
}

function isBrokenChunkedRecord(
    record: IBrowserPersistedDocumentRecord,
    chunkIndicesByRef: Map<string, Set<number>>,
) {
    return (
        record.storageMode === 'chunked'
        && record.fileSize > 0
        && (
            (record.chunkCount ?? 0) <= 0
            || (record.chunkCount ?? 0) !== Math.ceil(record.fileSize / Math.max(1, record.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE))
            || isChunkedRecordMissingChunks(record, chunkIndicesByRef)
        )
    );
}

export function isBrowserRecentFileRef(ref: string) {
    return readRecentFilesFromStorage().some(
        (candidate) => candidate.originalPath === ref,
    );
}

export async function sweepBrowserDocumentMaintenance(
    entries: Map<string, IBrowserDocumentEntry>,
) {
    const recoveryLeasedRefs = await loadBrowserWorkspaceRecoveryLeasedRefs();
    const {
        available,
        records,
    } = await loadBrowserPersistedDocumentRecordsResult();
    if (!available) {
        return;
    }
    const pendingRefs = new Set(Array.from(entries.values())
        .filter((entry) => Boolean(entry.pendingLoad))
        .map((entry) => entry.ref));
    const recordsByRef = new Map(records.map((record) => [
        record.ref,
        record,
    ]));
    const rawChunkKeysResult = await loadAllChunkKeysAvailability();
    if (!rawChunkKeysResult.available) {
        return;
    }
    const rawChunkKeys = rawChunkKeysResult.value;
    const chunkKeys = Array.isArray(rawChunkKeys)
        ? rawChunkKeys.flatMap((key) => {
            const parsedKey = typeof key === 'string' ? parseChunkKey(key) : null;
            return parsedKey ? [parsedKey] : [];
        })
        : [];
    const currentRecentFiles = hasRecentFilesStorageSnapshot()
        ? readRecentFilesFromStorage()
        : buildRecentFilesFromPersistedRecords(records);
    const {
        recentFiles,
        evictedRefs,
    } = pruneRecentFiles(currentRecentFiles);
    if (
        evictedRefs.length > 0
        || recentFiles.length !== currentRecentFiles.length
    ) {
        writeRecentFilesToStorage(recentFiles);
    }
    const recentRefs = new Set<string>(recentFiles.map((file) => file.originalPath));
    const nonWorkingDependentCounts = countNonWorkingDependents(records);
    const refsToRemove = records
        .filter((record) => shouldRemovePersistedRecord(
            record,
            recentRefs,
            nonWorkingDependentCounts,
        ))
        .filter(record => !recoveryLeasedRefs.has(record.ref))
        .filter((record) => !pendingRefs.has(record.ref))
        .map(record => record.ref);
    const chunkIndicesByRef = collectChunkIndicesByRef(chunkKeys);
    const brokenChunkRefs = records
        .filter((record) => isBrokenChunkedRecord(record, chunkIndicesByRef))
        .filter((record) => !pendingRefs.has(record.ref))
        .map((record) => record.ref);
    const refsToRemoveSet = new Set([
        ...refsToRemove,
        ...brokenChunkRefs,
    ]);
    if (refsToRemoveSet.size === 0 && chunkKeys.length === 0) {
        return;
    }

    // Include the recovery journal in the destructive transaction. IndexedDB
    // serializes this with checkpoint publication, so the lease read and the
    // corresponding document/chunk deletes cannot race each other.
    const deletedRefs = await runObjectStoresTransaction<Set<string>>(
        [
            WORKSPACE_RECOVERY_STORE,
            DOCUMENTS_STORE,
            DOCUMENT_CHUNKS_STORE,
        ],
        'readwrite',
        (transaction, setResult) => {
            const recoveryStore = transaction.objectStore(WORKSPACE_RECOVERY_STORE);
            const recoveriesRead = recoveryStore.getAll();
            recoveriesRead.onsuccess = () => {
                const leasedRefs = new Set<string>();
                if (Array.isArray(recoveriesRead.result)) {
                    for (const record of recoveriesRead.result) {
                        if (!record || typeof record !== 'object') {
                            continue;
                        }
                        const snapshotRefs = (record as {snapshotRefs?: unknown}).snapshotRefs;
                        if (!Array.isArray(snapshotRefs)) {
                            continue;
                        }
                        for (const ref of snapshotRefs) {
                            if (typeof ref === 'string') {
                                leasedRefs.add(ref);
                            }
                        }
                    }
                }
                const finalRefs = new Set(Array.from(refsToRemoveSet).filter(
                    ref => !leasedRefs.has(ref),
                ));
                const documentsStore = transaction.objectStore(DOCUMENTS_STORE);
                const chunksStore = transaction.objectStore(DOCUMENT_CHUNKS_STORE);
                finalRefs.forEach(ref => documentsStore.delete(ref));
                for (const chunkKey of chunkKeys) {
                    if (pendingRefs.has(chunkKey.ref)) continue;
                    const record = recordsByRef.get(chunkKey.ref);
                    const shouldDelete = !record
                        || finalRefs.has(chunkKey.ref)
                        || record.storageMode !== 'chunked'
                        || chunkKey.generation !== (record.chunkGeneration ?? undefined)
                        || chunkKey.index >= (record.chunkCount ?? 0);
                    if (shouldDelete) {
                        chunksStore.delete(createChunkKey(
                            chunkKey.ref,
                            chunkKey.index,
                            chunkKey.generation,
                        ));
                    }
                }
                setResult(finalRefs);
            };
        },
    );
    if (!deletedRefs) {
        return;
    }
    deletedRefs.forEach(ref => entries.delete(ref));
    if (deletedRefs.size > 0) {
        const remainingRecentFiles = readRecentFilesFromStorage().filter(
            (candidate) => !deletedRefs.has(candidate.originalPath),
        );
        writeRecentFilesToStorage(remainingRecentFiles);
    }
}

export async function cleanupBrowserEvictedRecentRefs(
    refs: string[],
    cleanupRef: (ref: string) => Promise<void>,
) {
    const uniqueRefs = uniq(refs.filter(ref => ref.length > 0));
    if (uniqueRefs.length === 0) {
        return;
    }

    await Promise.allSettled(
        uniqueRefs.map(async (ref) => {
            await cleanupRef(ref);
        }),
    );
}
