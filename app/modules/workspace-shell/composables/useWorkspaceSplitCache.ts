import type { TSplitPayload } from '@contracts/windowTabs';
import type { Ref } from 'vue';
import { omit } from 'es-toolkit/object';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot';

interface IWorkspaceSplitCacheEntry {
    id: string;
    payload: TSplitPayload;
    createdAt: number;
}

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
let nextCacheEntryId = 0;

function createCacheEntryId() {
    nextCacheEntryId += 1;
    return `split-cache-entry:${Date.now()}:${nextCacheEntryId}`;
}

function useSplitPayloadCache() {
    return useState<Record<string, IWorkspaceSplitCacheEntry>>(
        'workspace-split:cache',
        () => ({}),
    );
}

function useSplitPayloadCacheRevision() {
    return useState<number>(
        'workspace-split:cache-revision',
        () => 0,
    );
}

function bumpCacheRevision(cacheRevision: Ref<number>) {
    cacheRevision.value += 1;
}

function isEntryExpired(entry: IWorkspaceSplitCacheEntry, now = Date.now()) {
    return now - entry.createdAt > CACHE_TTL_MS;
}

function clonePayload(payload: TSplitPayload): TSplitPayload {
    if (payload.kind === 'empty') {
        return { kind: 'empty' };
    }

    if (payload.kind === 'djvu') {
        return {
            kind: 'djvu',
            sourcePath: payload.sourcePath,
        };
    }

    return {
        kind: 'pdfSnapshot',
        fileName: payload.fileName,
        originalPath: payload.originalPath,
        snapshotPath: payload.snapshotPath,
        isDirty: payload.isDirty,
        ...(payload.currentPage !== undefined ? { currentPage: payload.currentPage } : {}),
        ...(payload.totalPages !== undefined ? { totalPages: payload.totalPages } : {}),
    };
}

function omitCacheEntry(
    entries: Record<string, IWorkspaceSplitCacheEntry>,
    tabId: string,
) {
    return omit(entries, [tabId]);
}

function pruneCache(
    cache: Ref<Record<string, IWorkspaceSplitCacheEntry>>,
    cacheRevision: Ref<number>,
    now = Date.now(),
) {
    let changed = false;
    let nextEntries = { ...cache.value };
    const removedEntries: Array<[string, IWorkspaceSplitCacheEntry]> = [];

    for (const [
        tabId,
        entry,
    ] of Object.entries(nextEntries)) {
        if (isEntryExpired(entry, now)) {
            removedEntries.push([
                tabId,
                entry,
            ]);
            nextEntries = omitCacheEntry(nextEntries, tabId);
            changed = true;
        }
    }

    const entries = Object.entries(nextEntries);
    if (entries.length > MAX_CACHE_ENTRIES) {
        const overflowCount = entries.length - MAX_CACHE_ENTRIES;
        const sorted = entries
            .sort((left, right) => left[1].createdAt - right[1].createdAt);

        for (let index = 0; index < overflowCount; index += 1) {
            const item = sorted[index];
            if (!item) {
                break;
            }
            removedEntries.push(item);
            nextEntries = omitCacheEntry(nextEntries, item[0]);
            changed = true;
        }
    }

    if (!changed) {
        return;
    }

    cache.value = nextEntries;
    bumpCacheRevision(cacheRevision);
    removedEntries.forEach(([
        tabId,
        entry,
    ]) => {
        void cleanupSplitPayloadSnapshot(entry.payload, {
            logSection: 'split-cache',
            context: 'prune-cache',
            metadata: { tabId },
        });
    });
}

export const useWorkspaceSplitCache = () => {
    const splitPayloadCache = useSplitPayloadCache();
    const splitPayloadCacheRevision = useSplitPayloadCacheRevision();

    function set(tabId: string, payload: TSplitPayload | null | undefined) {
        const previousEntry = splitPayloadCache.value[tabId];

        if (!payload || payload.kind === 'empty') {
            if (!(tabId in splitPayloadCache.value)) {
                return null;
            }

            splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
            bumpCacheRevision(splitPayloadCacheRevision);
            if (previousEntry) {
                void cleanupSplitPayloadSnapshot(previousEntry.payload, {
                    logSection: 'split-cache',
                    context: 'clear-entry',
                    metadata: { tabId },
                });
            }
            return null;
        }

        const id = createCacheEntryId();
        splitPayloadCache.value = {
            ...splitPayloadCache.value,
            [tabId]: {
                id,
                payload: clonePayload(payload),
                createdAt: Date.now(),
            },
        };
        bumpCacheRevision(splitPayloadCacheRevision);
        if (
            previousEntry
            && (
                previousEntry.payload.kind !== 'pdfSnapshot'
                || payload.kind !== 'pdfSnapshot'
                || previousEntry.payload.snapshotPath !== payload.snapshotPath
            )
        ) {
            void cleanupSplitPayloadSnapshot(previousEntry.payload, {
                logSection: 'split-cache',
                context: 'replace-entry',
                metadata: { tabId },
            });
        }
        pruneCache(splitPayloadCache, splitPayloadCacheRevision);
        return id;
    }

    function peek(tabId: string): {
        id: string;
        payload: TSplitPayload;
    } | null {
        pruneCache(splitPayloadCache, splitPayloadCacheRevision);

        const entry = splitPayloadCache.value[tabId];
        if (!entry) {
            return null;
        }

        return {
            id: entry.id,
            payload: clonePayload(entry.payload),
        };
    }

    function consume(tabId: string, entryId?: string | null): TSplitPayload | null {
        pruneCache(splitPayloadCache, splitPayloadCacheRevision);

        const entry = splitPayloadCache.value[tabId];
        if (!entry || (entryId && entry.id !== entryId)) {
            return null;
        }

        splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
        bumpCacheRevision(splitPayloadCacheRevision);
        return clonePayload(entry.payload);
    }

    function has(tabId: string) {
        void splitPayloadCacheRevision.value;
        const entry = splitPayloadCache.value[tabId];
        if (!entry) {
            return false;
        }

        if (!isEntryExpired(entry)) {
            return true;
        }

        splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
        bumpCacheRevision(splitPayloadCacheRevision);
        void cleanupSplitPayloadSnapshot(entry.payload, {
            logSection: 'split-cache',
            context: 'has-expired-entry',
            metadata: { tabId },
        });
        return false;
    }

    function clear(tabId: string, entryId?: string | null) {
        const entry = splitPayloadCache.value[tabId];
        if (!entry) {
            return;
        }
        if (entryId && entry.id !== entryId) {
            return;
        }

        splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
        bumpCacheRevision(splitPayloadCacheRevision);
        void cleanupSplitPayloadSnapshot(entry.payload, {
            logSection: 'split-cache',
            context: 'clear-tab',
            metadata: { tabId },
        });
    }

    return {
        set,
        peek,
        consume,
        has,
        clear,
    };
};
