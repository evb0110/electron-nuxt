import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createScanCleanupDetectionSessionCache,
    retireSupersededScanCleanupDetectionState,
    scanCleanupAutoDetectionCanceledDocuments,
    scanCleanupDetectionSessionCache,
} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';

function entry(ownerId = 'owner') {
    return {
        ownerId,
        results: [],
        signatures: new Map<number, string>(),
        state: {
            jobId: 'detect-1',
            status: 'completed' as const,
            progress: {
                stage: 'detecting' as const,
                completedUnits: 1,
                totalUnits: 1,
                percent: 100,
                completedPageNumbers: [1],
            },
            results: [],
            updatedAtMs: 0,
        },
        totalPages: 1,
    };
}

afterEach(() => {
    scanCleanupDetectionSessionCache.clear();
    scanCleanupAutoDetectionCanceledDocuments.clear();
});

describe('scan cleanup detection session cache', () => {
    it('uses reads as LRU touches before enforcing the entry count budget', () => {
        const cache = createScanCleanupDetectionSessionCache({
            maxEntries: 2,
            maxBytes: 10_000,
        });
        cache.set('/one.pdf\u0000rev', entry());
        cache.set('/two.pdf\u0000rev', entry());
        expect(cache.get('/one.pdf\u0000rev')).toBeDefined();

        cache.set('/three.pdf\u0000rev', entry());

        expect([...cache.keys()]).toEqual([
            '/one.pdf\u0000rev',
            '/three.pdf\u0000rev',
        ]);
        expect(cache.bytes).toBeGreaterThan(0);
    });

    it('does not retain an entry that exceeds the byte budget', () => {
        const cache = createScanCleanupDetectionSessionCache({
            maxEntries: 2,
            maxBytes: 128,
        });
        cache.set('/large.pdf\u0000rev', entry('x'.repeat(1_024)));

        expect(cache.size).toBe(0);
        expect(cache.bytes).toBe(0);
    });

    it('keeps only the current revision for a document', () => {
        const cache = createScanCleanupDetectionSessionCache({
            maxEntries: 2,
            maxBytes: 10_000,
        });
        cache.set('/revision.pdf\u0000old', entry());
        cache.set('/revision.pdf\u0000new', entry());

        expect([...cache.keys()]).toEqual(['/revision.pdf\u0000new']);
    });

    it('retires prior revisions and their canceled-auto-detection state', () => {
        scanCleanupDetectionSessionCache.set('/revision.pdf\u0000old', entry());
        scanCleanupDetectionSessionCache.set('/other.pdf\u0000old', entry());
        scanCleanupAutoDetectionCanceledDocuments.add('/revision.pdf\u0000old');
        scanCleanupAutoDetectionCanceledDocuments.add('/other.pdf\u0000old');

        retireSupersededScanCleanupDetectionState('/revision.pdf\u0000new');

        expect(scanCleanupDetectionSessionCache.has('/revision.pdf\u0000old')).toBe(false);
        expect(scanCleanupDetectionSessionCache.has('/other.pdf\u0000old')).toBe(true);
        expect(scanCleanupAutoDetectionCanceledDocuments).toEqual(new Set(['/other.pdf\u0000old']));
    });
});
