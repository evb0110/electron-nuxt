import {
    BROWSER_CHUNK_WRITE_YIELD_EVERY,
    BROWSER_DOCUMENT_CHUNK_SIZE,
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
    deleteRecord,
    loadAllRecordKeysAvailability,
    loadRecordAvailability,
} from '@app/platform/browser/browserDocumentIdb';
import {
    deleteChunkRecord,
    loadAllChunkKeys,
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
    const {
        available,
        records,
    } = await loadBrowserPersistedDocumentRecordsResult();
    if (!available) {
        return;
    }
    if (records.length === 0) {
        return;
    }

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
    const pendingRefs = new Set(Array.from(entries.values())
        .filter((entry) => Boolean(entry.pendingLoad))
        .map((entry) => entry.ref));
    const refsToRemove = records
        .filter((record) => shouldRemovePersistedRecord(
            record,
            recentRefs,
            nonWorkingDependentCounts,
        ))
        .filter((record) => !pendingRefs.has(record.ref))
        .map(record => record.ref);

    const recordsByRef = new Map(records.map((record) => [
        record.ref,
        record,
    ]));
    const rawChunkKeys = await loadAllChunkKeys();
    const chunkKeys = Array.isArray(rawChunkKeys)
        ? rawChunkKeys.flatMap((key) => {
            const parsedKey = typeof key === 'string' ? parseChunkKey(key) : null;
            return parsedKey ? [parsedKey] : [];
        })
        : [];
    const chunkIndicesByRef = collectChunkIndicesByRef(chunkKeys);
    const brokenChunkRefs = records
        .filter((record) => isBrokenChunkedRecord(record, chunkIndicesByRef))
        .filter((record) => !pendingRefs.has(record.ref))
        .map((record) => record.ref);
    const refsToRemoveSet = new Set([
        ...refsToRemove,
        ...brokenChunkRefs,
    ]);
    const chunkDeletes = chunkKeys
        .filter((chunkKey) => {
            const record = recordsByRef.get(chunkKey.ref);
            if (pendingRefs.has(chunkKey.ref)) {
                return false;
            }
            if (!record || refsToRemoveSet.has(chunkKey.ref)) {
                return true;
            }

            if (record.storageMode !== 'chunked') {
                return true;
            }

            return (
                chunkKey.generation !== (record.chunkGeneration ?? undefined)
                || chunkKey.index >= (record.chunkCount ?? 0)
            );
        })
        .map((chunkKey) => deleteChunkRecord(chunkKey.ref, chunkKey.index, chunkKey.generation));

    if (refsToRemoveSet.size === 0 && chunkDeletes.length === 0) {
        return;
    }

    refsToRemoveSet.forEach((ref) => {
        entries.delete(ref);
    });
    await Promise.all([
        ...chunkDeletes,
        ...Array.from(refsToRemoveSet, async (ref) => {
            await deleteRecord(ref);
        }),
    ]);
    if (refsToRemoveSet.size > 0) {
        const remainingRecentFiles = readRecentFilesFromStorage().filter(
            (candidate) => !refsToRemoveSet.has(candidate.originalPath),
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
