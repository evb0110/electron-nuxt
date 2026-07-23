import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IScanCleanupOptions,
    IScanCleanupPreviewResult,
} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPreviewCacheKey} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';
import {createScanCleanupPreviewCache} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewCache';

const previewOptions: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'bw',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckle: true,
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

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
    it('keys every document and page option that changes preview placement or order', () => {
        const base = createScanCleanupPreviewCacheKey(1, previewOptions, '/tmp/source.pdf');
        const withAlignment = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            pageAlignment: 'bottom-right',
        }, '/tmp/source.pdf');
        const withReadingOrder = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            readingOrder: 'rtl',
        }, '/tmp/source.pdf');
        const withPlacementOverride = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            pageOverrides: {1: {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                placementOverrides: {left: 'center-left'},
            }},
        }, '/tmp/source.pdf');
        const withBinarization = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            binarization: 'sauvola',
        }, '/tmp/source.pdf');
        const withoutIlluminationNormalization = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            normalizeIllumination: false,
        }, '/tmp/source.pdf');
        const withCautiousDespeckle = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            despeckleLevel: 'cautious',
        }, '/tmp/source.pdf');
        const withAutoDewarp = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            autoDewarp: true,
        }, '/tmp/source.pdf');
        const withManualZones = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            pageOverrides: {1: {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                manualZones: {
                    picture: [{
                        layer: 'painter2',
                        polygon: {
                            points: [
                                {
                                    xNormalized: 0.1,
                                    yNormalized: 0.1,
                                },
                                {
                                    xNormalized: 0.4,
                                    yNormalized: 0.1,
                                },
                                {
                                    xNormalized: 0.4,
                                    yNormalized: 0.4,
                                },
                                {
                                    xNormalized: 0.1,
                                    yNormalized: 0.4,
                                },
                            ],
                            rotationDegrees: 0,
                        },
                    }],
                    fill: [],
                },
            }},
        }, '/tmp/source.pdf');

        expect(new Set([
            base,
            withAlignment,
            withReadingOrder,
            withPlacementOverride,
            withBinarization,
            withoutIlluminationNormalization,
            withCautiousDespeckle,
            withAutoDewarp,
            withManualZones,
        ])).toHaveLength(9);
    });

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
