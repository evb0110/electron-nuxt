import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupPreviewResult} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPreviewCache} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewCache';

function result(raw: Uint8Array, outputs: Uint8Array[]): IScanCleanupPreviewResult {
    return {
        pageNumber: 1,
        totalPages: 1,
        rawImageData: raw,
        rawWidthPx: 1,
        rawHeightPx: 1,
        pageMetadata: {
            layoutClassification: 'single-uncut-page',
            layoutConfidence: 1,
            cutterXPx: null,
            rotationDegrees: 0,
            canvasScope: 'page',
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: 'single-uncut-page',
            reconciled: false,
            clusterAgreement: 0,
        },
        outputs: outputs.map(imageData => ({
            imageData,
            metadata: {
                half: 'full',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 1,
                sourceRegion: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1,
                    heightPx: 1,
                },
                contentBox: null,
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                outputWidthPx: 1,
                outputHeightPx: 1,
                canvasWidthPx: 1,
                canvasHeightPx: 1,
                placementOffsetXPx: 0,
                placementOffsetYPx: 0,
                forwardTransform: null,
                cutterXPx: null,
                inputWidthPx: 1,
                inputHeightPx: 1,
                rotationDegrees: 0,
                canvasScope: 'page',
                resamplePasses: 0,
                warnings: [],
            },
        })),
    };
}

describe('scan cleanup renderer preview cache', () => {
    it('evicts by bytes and count while accounting for derivable shared input bytes once', () => {
        const cache = createScanCleanupPreviewCache({
            maxEntries: 2,
            maxBytes: 9,
        });
        const shared = new Uint8Array(4);
        cache.set('shared', result(shared, [shared]));
        expect(cache.byteLength).toBe(4);
        expect(cache.get('shared')?.rawImageData).toBe(shared);

        cache.set('five-bytes', result(new Uint8Array(2), [new Uint8Array(3)]));
        expect(cache.has('shared')).toBe(true);
        expect(cache.byteLength).toBe(9);

        cache.set('three-bytes', result(new Uint8Array(3), []));
        expect(cache.has('shared')).toBe(false);
        expect(cache.byteLength).toBe(8);
        expect(cache.size).toBe(2);
        cache.get('five-bytes');
        cache.set('four-bytes', result(new Uint8Array(4), []));
        expect(cache.has('three-bytes')).toBe(false);
        expect(cache.has('five-bytes')).toBe(true);
        expect(cache.has('four-bytes')).toBe(true);
    });
});
