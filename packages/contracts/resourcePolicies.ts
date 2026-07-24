import { isRecord } from '@contracts/runtimeGuards';

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
        fallback,
        min,
        max,
    }: {
        fallback: number;
        min: number;
        max?: number;
    },
): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed) || parsed < min) {
        return fallback;
    }
    return max === undefined ? parsed : Math.min(parsed, max);
}

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

export function decodeSearchWorkerData(
    value: unknown,
): ISearchWorkerData | null {
    if (!isRecord(value)) {
        return null;
    }

    const resourcePolicy = decodeSearchWorkerResourcePolicy(value.resourcePolicy);
    if (
        resourcePolicy === null
        || !isPositiveSafeInteger(value.nativeServiceIdleTimeoutMs)
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
