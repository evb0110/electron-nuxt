import type { TSplitPayload } from '@contracts/window-tabs';
import type { Ref } from 'vue';

interface IWorkspaceSplitCacheEntry {
    payload: TSplitPayload;
    createdAt: number;
}

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;

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
        currentPage: payload.currentPage,
        totalPages: payload.totalPages,
    };
}

function omitCacheEntry(
    entries: Record<string, IWorkspaceSplitCacheEntry>,
    tabId: string,
) {
    const {
        [tabId]: _removed,
        ...rest
    } = entries;
    return rest;
}

function pruneCache(
    cache: Ref<Record<string, IWorkspaceSplitCacheEntry>>,
    cacheRevision: Ref<number>,
    now = Date.now(),
) {
    let changed = false;
    let nextEntries = { ...cache.value };

    for (const [
        tabId,
        entry,
    ] of Object.entries(nextEntries)) {
        if (isEntryExpired(entry, now)) {
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
            nextEntries = omitCacheEntry(nextEntries, item[0]);
            changed = true;
        }
    }

    if (!changed) {
        return;
    }

    cache.value = nextEntries;
    bumpCacheRevision(cacheRevision);
}

export function useWorkspaceSplitCache() {
    const splitPayloadCache = useSplitPayloadCache();
    const splitPayloadCacheRevision = useSplitPayloadCacheRevision();

    function set(tabId: string, payload: TSplitPayload | null | undefined) {
        if (!payload || payload.kind === 'empty') {
            if (!(tabId in splitPayloadCache.value)) {
                return;
            }

            splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
            bumpCacheRevision(splitPayloadCacheRevision);
            return;
        }

        splitPayloadCache.value = {
            ...splitPayloadCache.value,
            [tabId]: {
                payload: clonePayload(payload),
                createdAt: Date.now(),
            },
        };
        bumpCacheRevision(splitPayloadCacheRevision);
        pruneCache(splitPayloadCache, splitPayloadCacheRevision);
    }

    function consume(tabId: string): TSplitPayload | null {
        pruneCache(splitPayloadCache, splitPayloadCacheRevision);

        const entry = splitPayloadCache.value[tabId];
        if (!entry) {
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
        return false;
    }

    function clear(tabId: string) {
        if (!(tabId in splitPayloadCache.value)) {
            return;
        }

        splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
        bumpCacheRevision(splitPayloadCacheRevision);
    }

    return {
        set,
        consume,
        has,
        clear,
    };
}
