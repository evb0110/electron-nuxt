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
    decodeSearchWorkerData,
    decodeSearchWorkerResourcePolicy,
    parseBoundedEnvInt,
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

describe('parseBoundedEnvInt', () => {
    it('parses a valid override and applies the ceiling only when max is set', () => {
        expect(parseBoundedEnvInt('42', {
            fallback: 1,
            min: 1,
        })).toBe(42);
        expect(parseBoundedEnvInt('999', {
            fallback: 1,
            min: 1,
            max: 256,
        })).toBe(256);
        expect(parseBoundedEnvInt('10', {
            fallback: 1,
            min: 1,
            max: 256,
        })).toBe(10);
    });

    it('falls back for undefined, non-numeric, and below-minimum values', () => {
        expect(parseBoundedEnvInt(undefined, {
            fallback: 7,
            min: 2,
        })).toBe(7);
        expect(parseBoundedEnvInt('nope', {
            fallback: 7,
            min: 2,
        })).toBe(7);
        expect(parseBoundedEnvInt('1', {
            fallback: 7,
            min: 2,
        })).toBe(7);
        expect(parseBoundedEnvInt('2', {
            fallback: 7,
            min: 2,
        })).toBe(2);
    });
});

describe('decodeSearchWorkerData', () => {
    const validEnvelope = {
        nativeServiceIdleTimeoutMs: 60_000,
        resourcePolicy: {
            indexCacheMaxEntries: 1,
            indexCacheTtlMs: 2 * 60_000,
            maxPageTextBytes: 2 * MIB,
            maxTotalTextBytes: 48 * MIB,
        },
    };

    it('accepts a well-formed envelope and returns the typed value', () => {
        expect(decodeSearchWorkerData(validEnvelope)).toEqual(validEnvelope);
    });

    it('rejects a non-record, a bad idle timeout, and a malformed resource policy', () => {
        expect(decodeSearchWorkerData(null)).toBeNull();
        expect(decodeSearchWorkerData({
            ...validEnvelope,
            nativeServiceIdleTimeoutMs: 0,
        })).toBeNull();
        expect(decodeSearchWorkerData({
            ...validEnvelope,
            resourcePolicy: {
                ...validEnvelope.resourcePolicy,
                maxTotalTextBytes: 0,
            },
        })).toBeNull();
    });
});
