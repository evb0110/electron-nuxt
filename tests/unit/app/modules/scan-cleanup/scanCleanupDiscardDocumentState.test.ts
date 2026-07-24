// @vitest-environment happy-dom
import {
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/runtime/discardScanCleanupDocumentState';
import {
    scanCleanupAutoDetectionCanceledDocuments,
    scanCleanupDetectionSessionCache,
} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import {
    loadScanCleanupDocumentMargins,
    loadScanCleanupDocumentOverrides,
    saveScanCleanupDocumentMargins,
    saveScanCleanupDocumentOverrides,
} from '@app/modules/scan-cleanup/persistence/preferencesRepository';

const DOCUMENT_KEY = '/docs/discard-me.pdf';
const LIFECYCLE_KEY = `${DOCUMENT_KEY}\u0000revision-1`;

function cacheEntry() {
    return {
        ownerId: 'owner-1',
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

describe('discardScanCleanupDocumentState', () => {
    beforeEach(() => {
        localStorage.clear();
        scanCleanupDetectionSessionCache.clear();
        scanCleanupAutoDetectionCanceledDocuments.clear();
    });

    it('drops detection restore state and persisted overrides but keeps document margins', () => {
        scanCleanupDetectionSessionCache.set(LIFECYCLE_KEY, cacheEntry());
        scanCleanupAutoDetectionCanceledDocuments.add(LIFECYCLE_KEY);
        saveScanCleanupDocumentOverrides(DOCUMENT_KEY, {'1': {
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: null,
        }});
        saveScanCleanupDocumentMargins(DOCUMENT_KEY, {
            leftMm: 19,
            topMm: 6,
            rightMm: 18,
            bottomMm: 18,
        });

        discardScanCleanupDocumentState(DOCUMENT_KEY);
        discardScanCleanupDocumentState(DOCUMENT_KEY);

        expect(scanCleanupDetectionSessionCache.size).toBe(0);
        expect(scanCleanupAutoDetectionCanceledDocuments.size).toBe(0);
        expect(loadScanCleanupDocumentOverrides(DOCUMENT_KEY)).toEqual({});
        expect(loadScanCleanupDocumentMargins(DOCUMENT_KEY)).toEqual({
            leftMm: 19,
            topMm: 6,
            rightMm: 18,
            bottomMm: 18,
        });
    });

    it('leaves other documents untouched and tolerates missing keys', () => {
        scanCleanupDetectionSessionCache.set(`${DOCUMENT_KEY}-other\u0000rev`, cacheEntry());
        discardScanCleanupDocumentState(DOCUMENT_KEY);
        discardScanCleanupDocumentState(null);
        expect(scanCleanupDetectionSessionCache.size).toBe(1);
    });
});
