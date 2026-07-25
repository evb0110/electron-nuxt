import { isRecord } from '@contracts/runtimeGuards';

export const SEARCH_NATIVE_SERVICE_IDLE_TIMEOUT_MAX_MS = 2_147_483_647;
export const SEARCH_INDEX_CACHE_MAX_ENTRIES = 128;
export const SEARCH_MAX_PAGE_TEXT_BYTES = 32 * 1024 * 1024;
export const SEARCH_MAX_TOTAL_TEXT_BYTES = 1024 * 1024 * 1024;

export interface ISearchWorkerResourcePolicy {
    indexCacheMaxEntries: number;
    indexCacheTtlMs: number;
    maxPageTextBytes: number;
    maxTotalTextBytes: number;
}

export interface ISearchWorkerData {
    nativeServiceIdleTimeoutMs: number;
    resourcePolicy: ISearchWorkerResourcePolicy;
}

export interface IScanCleanupRuntimePolicy {rasterConcurrency: 1 | 2 | 3;}

export function parseBoundedEnvInt(
    value: string | undefined,
    {
        clampBelowMin = false,
        fallback,
        min,
        max,
        requireSafeInteger = false,
    }: {
        clampBelowMin?: boolean;
        fallback: number;
        min: number;
        max?: number;
        requireSafeInteger?: boolean;
    },
): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (
        !Number.isFinite(parsed)
        || (requireSafeInteger && !Number.isSafeInteger(parsed))
    ) {
        return fallback;
    }
    if (parsed < min) {
        return clampBelowMin ? min : fallback;
    }
    return max === undefined ? parsed : Math.min(parsed, max);
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}

function isPositiveSafeIntegerAtMost(
    value: unknown,
    max: number,
): value is number {
    return isPositiveSafeInteger(value) && value <= max;
}

export function decodeSearchWorkerResourcePolicy(
    value: unknown,
): ISearchWorkerResourcePolicy | null {
    if (
        !isRecord(value)
        || !isPositiveSafeIntegerAtMost(
            value.indexCacheMaxEntries,
            SEARCH_INDEX_CACHE_MAX_ENTRIES,
        )
        || !isPositiveSafeInteger(value.indexCacheTtlMs)
        || !isPositiveSafeIntegerAtMost(
            value.maxPageTextBytes,
            SEARCH_MAX_PAGE_TEXT_BYTES,
        )
        || !isPositiveSafeIntegerAtMost(
            value.maxTotalTextBytes,
            SEARCH_MAX_TOTAL_TEXT_BYTES,
        )
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

export function decodeSearchWorkerData(
    value: unknown,
): ISearchWorkerData | null {
    if (!isRecord(value)) {
        return null;
    }

    const resourcePolicy = decodeSearchWorkerResourcePolicy(value.resourcePolicy);
    if (
        resourcePolicy === null
        || !isPositiveSafeIntegerAtMost(
            value.nativeServiceIdleTimeoutMs,
            SEARCH_NATIVE_SERVICE_IDLE_TIMEOUT_MAX_MS,
        )
    ) {
        return null;
    }

    return {
        nativeServiceIdleTimeoutMs: value.nativeServiceIdleTimeoutMs,
        resourcePolicy,
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
