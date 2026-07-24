import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IHostResourceProfileSnapshot,
    THostResourceTier,
} from '@contracts/hostResourceProfile';
import {
    decodeScanCleanupRuntimePolicy,
    decodeSearchWorkerResourcePolicy,
} from '@contracts/resourcePolicies';
import { resolveSearchResourcePolicy } from '@electron/features/search/main/searchResourcePolicy';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function createResourceProfile(
    tier: THostResourceTier,
): IHostResourceProfileSnapshot {
    return {
        logicalCpus: tier === 'high' ? 12 : 4,
        totalRamBytes: tier === 'low' ? 8 * GIB : 16 * GIB,
        safeMode: false,
        detectedTier: tier,
        performanceMode: 'auto',
        tier,
    };
}

describe('resolveSearchResourcePolicy', () => {
    it.each([
        [
            'low',
            1,
            1,
            48 * MIB,
            60_000,
        ],
        [
            'medium',
            2,
            2,
            96 * MIB,
            5 * 60_000,
        ],
        [
            'high',
            2,
            2,
            96 * MIB,
            5 * 60_000,
        ],
    ] as const)(
        'resolves the %s tier policy table',
        (
            tier,
            maxActiveSenderWorkers,
            indexCacheMaxEntries,
            maxTotalTextBytes,
            nativeServiceIdleTimeoutMs,
        ) => {
            expect(resolveSearchResourcePolicy(
                createResourceProfile(tier),
                {},
            )).toEqual({
                maxActiveSenderWorkers,
                workerIdleTtlMs: 30_000,
                nativeServiceIdleTimeoutMs,
                workerResourcePolicy: {
                    indexCacheMaxEntries,
                    indexCacheTtlMs: 2 * 60_000,
                    maxPageTextBytes: 2 * MIB,
                    maxTotalTextBytes,
                },
            });
        },
    );

    it('gives valid overrides highest precedence and preserves their bounds', () => {
        expect(resolveSearchResourcePolicy(
            createResourceProfile('low'),
            {
                EVB_SEARCH_WORKER_MAX_ACTIVE: '999',
                EVB_SEARCH_WORKER_IDLE_TTL_MS: '45000',
                EVB_PDF_SEARCH_SERVICE_IDLE_TIMEOUT_MS: '90000',
                EVB_SEARCH_INDEX_CACHE_MAX_ENTRIES: '999',
                EVB_SEARCH_INDEX_CACHE_TTL_MS: '180000',
                EVB_SEARCH_MAX_PAGE_TEXT_BYTES: `${64 * MIB}`,
                EVB_SEARCH_MAX_TOTAL_TEXT_BYTES: `${2 * 1024 * MIB}`,
            },
        )).toEqual({
            maxActiveSenderWorkers: 256,
            workerIdleTtlMs: 45_000,
            nativeServiceIdleTimeoutMs: 90_000,
            workerResourcePolicy: {
                indexCacheMaxEntries: 128,
                indexCacheTtlMs: 180_000,
                maxPageTextBytes: 32 * MIB,
                maxTotalTextBytes: 1024 * MIB,
            },
        });
    });

    it('uses tier defaults for malformed or below-minimum overrides', () => {
        expect(resolveSearchResourcePolicy(
            createResourceProfile('low'),
            {
                EVB_SEARCH_WORKER_MAX_ACTIVE: 'invalid',
                EVB_SEARCH_WORKER_IDLE_TTL_MS: '9999',
                EVB_PDF_SEARCH_SERVICE_IDLE_TIMEOUT_MS: '0',
                EVB_SEARCH_INDEX_CACHE_MAX_ENTRIES: '0',
                EVB_SEARCH_INDEX_CACHE_TTL_MS: '29999',
                EVB_SEARCH_MAX_PAGE_TEXT_BYTES: '1',
                EVB_SEARCH_MAX_TOTAL_TEXT_BYTES: '1',
            },
        )).toEqual(resolveSearchResourcePolicy(
            createResourceProfile('low'),
            {},
        ));
    });

    it('decodes worker-boundary policies and rejects malformed values', () => {
        const workerPolicy = resolveSearchResourcePolicy(
            createResourceProfile('low'),
            {},
        ).workerResourcePolicy;

        expect(decodeSearchWorkerResourcePolicy(workerPolicy)).toEqual(workerPolicy);
        expect(decodeSearchWorkerResourcePolicy({
            ...workerPolicy,
            maxTotalTextBytes: 0,
        })).toBeNull();
        expect(decodeScanCleanupRuntimePolicy({rasterConcurrency: 2}))
            .toEqual({rasterConcurrency: 2});
        expect(decodeScanCleanupRuntimePolicy({rasterConcurrency: 4})).toBeNull();
    });
});
