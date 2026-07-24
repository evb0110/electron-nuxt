/* eslint-disable custom/file-naming -- Filename is prescribed by the WP6 contract. */
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import {
    parseBoundedEnvInt,
    type ISearchWorkerResourcePolicy,
} from '@contracts/resourcePolicies';

const MIB = 1024 * 1024;

export interface ISearchResourcePolicy {
    maxActiveSenderWorkers: number;
    workerIdleTtlMs: number;
    nativeServiceIdleTimeoutMs: number;
    workerResourcePolicy: ISearchWorkerResourcePolicy;
}

export function resolveSearchResourcePolicy(
    profile: IHostResourceProfileSnapshot,
    env: NodeJS.ProcessEnv,
): ISearchResourcePolicy {
    const isLowTier = profile.tier === 'low';
    const maxActiveSenderWorkers = parseBoundedEnvInt(env.EVB_SEARCH_WORKER_MAX_ACTIVE, {
        fallback: isLowTier ? 1 : 2,
        min: 1,
        max: 256,
    });
    const workerIdleTtlMs = parseBoundedEnvInt(env.EVB_SEARCH_WORKER_IDLE_TTL_MS, {
        fallback: 30_000,
        min: 10_000,
    });
    const nativeServiceIdleTimeoutMs = parseBoundedEnvInt(env.EVB_PDF_SEARCH_SERVICE_IDLE_TIMEOUT_MS, {
        fallback: isLowTier ? 60_000 : 5 * 60_000,
        min: 1,
    });
    const indexCacheMaxEntries = parseBoundedEnvInt(env.EVB_SEARCH_INDEX_CACHE_MAX_ENTRIES, {
        fallback: isLowTier ? 1 : 2,
        min: 1,
        max: 128,
    });
    const indexCacheTtlMs = parseBoundedEnvInt(env.EVB_SEARCH_INDEX_CACHE_TTL_MS, {
        fallback: 2 * 60_000,
        min: 30_000,
    });
    const maxPageTextBytes = parseBoundedEnvInt(env.EVB_SEARCH_MAX_PAGE_TEXT_BYTES, {
        fallback: 2 * MIB,
        min: 16 * 1024,
        max: 32 * MIB,
    });
    const maxTotalTextBytes = parseBoundedEnvInt(env.EVB_SEARCH_MAX_TOTAL_TEXT_BYTES, {
        fallback: isLowTier ? 48 * MIB : 96 * MIB,
        min: 256 * 1024,
        max: 1024 * MIB,
    });

    return {
        maxActiveSenderWorkers,
        workerIdleTtlMs,
        nativeServiceIdleTimeoutMs,
        workerResourcePolicy: {
            indexCacheMaxEntries,
            indexCacheTtlMs,
            maxPageTextBytes,
            maxTotalTextBytes,
        },
    };
}
