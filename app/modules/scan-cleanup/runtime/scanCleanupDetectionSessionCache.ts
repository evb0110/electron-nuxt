import type {
    IScanCleanupDetectionResult,
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';

export interface IScanCleanupDetectionSessionCacheEntry {
    ownerId: string;
    results: IScanCleanupDetectionResult[];
    signatures: Map<number, string>;
    state: TScanCleanupDetectionJobState;
    totalPages: number;
}

export interface IScanCleanupDetectionSessionCacheLimits {
    maxBytes: number;
    maxEntries: number;
}

export const SCAN_CLEANUP_DETECTION_SESSION_CACHE_LIMITS: Readonly<IScanCleanupDetectionSessionCacheLimits> = {
    // A handful of recently visited documents makes back/forward restoration
    // instant without allowing full-page detection evidence to accumulate for
    // an unbounded renderer lifetime.
    maxEntries: 8,
    maxBytes: 8 * 1024 * 1024,
};

function documentKeyFor(key: string) {
    return key.split('\u0000', 1)[0] ?? key;
}

function estimateEntryBytes(entry: IScanCleanupDetectionSessionCacheEntry) {
    try {
        return new TextEncoder().encode(JSON.stringify({
            ownerId: entry.ownerId,
            results: entry.results,
            signatures: [...entry.signatures],
            state: entry.state,
            totalPages: entry.totalPages,
        })).byteLength;
    } catch {
        // Detection results are bridge-safe data. If a future result violates
        // that contract, do not keep an entry whose retained size is unknown.
        return Number.POSITIVE_INFINITY;
    }
}

export class ScanCleanupDetectionSessionCache extends Map<string, IScanCleanupDetectionSessionCacheEntry> {
    private readonly entryBytes = new Map<string, number>();
    private retainedBytes = 0;

    constructor(private readonly limits: Readonly<IScanCleanupDetectionSessionCacheLimits>) {
        super();
    }

    get bytes() {
        return this.retainedBytes;
    }

    override get(key: string) {
        const entry = super.get(key);
        if (entry === undefined) {
            return undefined;
        }
        // Map insertion order is the LRU order. A restore counts as use.
        super.delete(key);
        super.set(key, entry);
        return entry;
    }

    override set(key: string, entry: IScanCleanupDetectionSessionCacheEntry) {
        const documentKey = documentKeyFor(key);
        for (const existingKey of [...this.keys()]) {
            if (existingKey !== key && documentKeyFor(existingKey) === documentKey) {
                this.delete(existingKey);
            }
        }
        this.delete(key);
        const bytes = estimateEntryBytes(entry);
        if (!Number.isFinite(bytes) || bytes > this.limits.maxBytes) {
            return this;
        }
        super.set(key, entry);
        this.entryBytes.set(key, bytes);
        this.retainedBytes += bytes;
        this.evictToBudget();
        return this;
    }

    override delete(key: string) {
        const bytes = this.entryBytes.get(key);
        if (bytes !== undefined) {
            this.entryBytes.delete(key);
            this.retainedBytes -= bytes;
        }
        return super.delete(key);
    }

    override clear() {
        super.clear();
        this.entryBytes.clear();
        this.retainedBytes = 0;
    }

    private evictToBudget() {
        while (
            this.size > this.limits.maxEntries
            || this.retainedBytes > this.limits.maxBytes
        ) {
            const oldestKey = this.keys().next().value;
            if (oldestKey === undefined) {
                return;
            }
            this.delete(oldestKey);
        }
    }
}

export function createScanCleanupDetectionSessionCache(
    limits: Readonly<IScanCleanupDetectionSessionCacheLimits> = SCAN_CLEANUP_DETECTION_SESSION_CACHE_LIMITS,
) {
    return new ScanCleanupDetectionSessionCache(limits);
}

/** Session-restore caches keyed by lifecycle document key (documentKey + NUL + revision). */
export const scanCleanupDetectionSessionCache = createScanCleanupDetectionSessionCache();
export const scanCleanupAutoDetectionCanceledDocuments = new Set<string>();

function matchesDocument(key: string, documentKey: string) {
    return key === documentKey || key.startsWith(`${documentKey}\u0000`);
}

/** Retires stale revisions when the source lifecycle identity advances. */
export function retireSupersededScanCleanupDetectionState(lifecycleKey: string | null | undefined) {
    if (!lifecycleKey) {
        return;
    }
    const documentKey = documentKeyFor(lifecycleKey);
    for (const key of [...scanCleanupDetectionSessionCache.keys()]) {
        if (matchesDocument(key, documentKey) && key !== lifecycleKey) {
            scanCleanupDetectionSessionCache.delete(key);
        }
    }
    for (const key of [...scanCleanupAutoDetectionCanceledDocuments]) {
        if (matchesDocument(key, documentKey) && key !== lifecycleKey) {
            scanCleanupAutoDetectionCanceledDocuments.delete(key);
        }
    }
}

/**
 * Drops every in-memory detection restore entry for a document. Closing the
 * scan-cleanup surface discards the split session; the next entry starts from
 * a fresh detection pass.
 */
export function discardScanCleanupDetectionState(documentKey: string | null | undefined) {
    if (!documentKey) {
        return;
    }
    for (const key of [...scanCleanupDetectionSessionCache.keys()]) {
        if (matchesDocument(key, documentKey)) {
            scanCleanupDetectionSessionCache.delete(key);
        }
    }
    for (const key of [...scanCleanupAutoDetectionCanceledDocuments]) {
        if (matchesDocument(key, documentKey)) {
            scanCleanupAutoDetectionCanceledDocuments.delete(key);
        }
    }
}
