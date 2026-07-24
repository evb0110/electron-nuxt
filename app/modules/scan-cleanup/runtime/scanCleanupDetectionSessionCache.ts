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

/** Session-restore caches keyed by lifecycle document key (documentKey + NUL + revision). */
export const scanCleanupDetectionSessionCache = new Map<string, IScanCleanupDetectionSessionCacheEntry>();
export const scanCleanupAutoDetectionCanceledDocuments = new Set<string>();

function matchesDocument(key: string, documentKey: string) {
    return key === documentKey || key.startsWith(`${documentKey}\u0000`);
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
