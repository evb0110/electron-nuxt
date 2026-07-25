import { isRecord } from '@contracts/runtimeGuards';

export interface ISearchWorkerResourcePolicy {
    indexCacheMaxEntries: number;
    indexCacheTtlMs: number;
    maxPageTextBytes: number;
    maxTotalTextBytes: number;
}

export interface IScanCleanupRuntimePolicy {rasterConcurrency: 1 | 2 | 3;}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}

export function decodeSearchWorkerResourcePolicy(
    value: unknown,
): ISearchWorkerResourcePolicy | null {
    if (
        !isRecord(value)
        || !isPositiveSafeInteger(value.indexCacheMaxEntries)
        || !isPositiveSafeInteger(value.indexCacheTtlMs)
        || !isPositiveSafeInteger(value.maxPageTextBytes)
        || !isPositiveSafeInteger(value.maxTotalTextBytes)
    ) {
        return null;
    }

    return {
        indexCacheMaxEntries: value.indexCacheMaxEntries,
        indexCacheTtlMs: value.indexCacheTtlMs,
        maxPageTextBytes: value.maxPageTextBytes,
        maxTotalTextBytes: value.maxTotalTextBytes,
    };
}

export function decodeScanCleanupRuntimePolicy(
    value: unknown,
): IScanCleanupRuntimePolicy | null {
    if (
        !isRecord(value)
        || (
            value.rasterConcurrency !== 1
            && value.rasterConcurrency !== 2
            && value.rasterConcurrency !== 3
        )
    ) {
        return null;
    }

    return {rasterConcurrency: value.rasterConcurrency};
}
