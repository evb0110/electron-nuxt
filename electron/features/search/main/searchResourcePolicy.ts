/* eslint-disable custom/file-naming -- Filename is prescribed by the WP6 contract. */
import { clamp } from 'es-toolkit/math';
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import type { ISearchWorkerResourcePolicy } from '@contracts/resourcePolicies';

const MIB = 1024 * 1024;

export interface ISearchResourcePolicy {
    maxActiveSenderWorkers: number;
    workerIdleTtlMs: number;
    nativeServiceIdleTimeoutMs: number;
    workerResourcePolicy: ISearchWorkerResourcePolicy;
}

function parseInteger(value: string | undefined) {
    return Number.parseInt(value ?? '', 10);
}

function resolveMinimum(
    value: string | undefined,
    fallback: number,
    minimum: number,
) {
    const parsed = parseInteger(value);
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function resolveClamped(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
) {
    const parsed = parseInteger(value);
    return Number.isFinite(parsed)
        ? clamp(parsed, minimum, maximum)
        : fallback;
}

function resolveMinimumCapped(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
) {
    const parsed = parseInteger(value);
    return Number.isFinite(parsed) && parsed >= minimum
        ? Math.min(parsed, maximum)
        : fallback;
}

export function resolveSearchResourcePolicy(
    profile: IHostResourceProfileSnapshot,
    env: NodeJS.ProcessEnv,
): ISearchResourcePolicy {
    const isLowTier = profile.tier === 'low';
    const maxActiveSenderWorkers = resolveClamped(
        env.EVB_SEARCH_WORKER_MAX_ACTIVE,
        isLowTier ? 1 : 2,
        1,
        256,
    );
    const workerIdleTtlMs = resolveMinimum(
        env.EVB_SEARCH_WORKER_IDLE_TTL_MS,
        30_000,
        10_000,
    );
    const configuredNativeServiceIdleTimeoutMs = parseInteger(
        env.EVB_PDF_SEARCH_SERVICE_IDLE_TIMEOUT_MS,
    );
    const nativeServiceIdleTimeoutMs = Number.isSafeInteger(
        configuredNativeServiceIdleTimeoutMs,
    ) && configuredNativeServiceIdleTimeoutMs > 0
        ? configuredNativeServiceIdleTimeoutMs
        : isLowTier ? 60_000 : 5 * 60_000;
    const indexCacheMaxEntries = resolveMinimumCapped(
        env.EVB_SEARCH_INDEX_CACHE_MAX_ENTRIES,
        isLowTier ? 1 : 2,
        1,
        128,
    );
    const indexCacheTtlMs = resolveMinimum(
        env.EVB_SEARCH_INDEX_CACHE_TTL_MS,
        2 * 60_000,
        30_000,
    );
    const maxPageTextBytes = resolveMinimumCapped(
        env.EVB_SEARCH_MAX_PAGE_TEXT_BYTES,
        2 * MIB,
        16 * 1024,
        32 * MIB,
    );
    const maxTotalTextBytes = resolveMinimumCapped(
        env.EVB_SEARCH_MAX_TOTAL_TEXT_BYTES,
        isLowTier ? 48 * MIB : 96 * MIB,
        256 * 1024,
        1024 * MIB,
    );

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
