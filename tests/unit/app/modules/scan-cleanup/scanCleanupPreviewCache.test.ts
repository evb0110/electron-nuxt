import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IScanCleanupOptions,
    IScanCleanupPreviewResult,
} from '@contracts/electronApiScanCleanup';
import {
    createScanCleanupDetailTileCacheKey,
    createScanCleanupPreviewCacheKey,
} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';
import {createScanCleanupPreviewCache} from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';

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
    it('keeps high-detail pans distinct and canonicalizes half-key insertion order', () => {
        const firstPan = {
            xNormalized: 0.1,
            yNormalized: 0.2,
            widthNormalized: 0.4,
            heightNormalized: 0.5,
            rotationDegrees: 0 as const,
        };
        const secondPan = {
            ...firstPan,
            xNormalized: 0.25,
        };

        expect(createScanCleanupDetailTileCacheKey('page-1:bw', {
            left: firstPan,
            right: secondPan,
        })).toBe(createScanCleanupDetailTileCacheKey('page-1:bw', {
            right: {...secondPan},
            left: {...firstPan},
        }));
        expect(createScanCleanupDetailTileCacheKey('page-1:bw', {left: firstPan}))
            .not.toBe(createScanCleanupDetailTileCacheKey('page-1:bw', {left: secondPan}));
        expect(createScanCleanupDetailTileCacheKey('page-1:bw', {full: firstPan}))
            .not.toBe(createScanCleanupDetailTileCacheKey('page-1:bw', {left: firstPan}));
    });

    it('keys sidecar-rendered placement and order options but ignores renderer-only placement overrides', () => {
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
        const withFixedDewarpDepth = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            autoDewarp: true,
            autoDewarpDepth: 1.8,
        }, '/tmp/source.pdf');
        const withManualSkew = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            pageOverrides: {1: {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                manualSkewDegrees: -2.3,
            }},
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
            withBinarization,
            withoutIlluminationNormalization,
            withCautiousDespeckle,
            withAutoDewarp,
            withFixedDewarpDepth,
            withManualSkew,
            withManualZones,
        ])).toHaveLength(10);
        expect(withPlacementOverride).toBe(base);
    });

    it('invalidates a page when its output-mode override changes', () => {
        const base = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            outputMode: 'auto',
        }, '/tmp/source.pdf');
        const withOutputModeOverride = createScanCleanupPreviewCacheKey(1, {
            ...previewOptions,
            outputMode: 'auto',
            pageOverrides: {'1': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                outputModeOverride: 'color',
            }},
        }, '/tmp/source.pdf');
        expect(withOutputModeOverride).not.toBe(base);
    });

    it('leaves a plan the render cannot consume out of the key', () => {
        const plan = {
            widthPoints: 595,
            heightPoints: 842,
        };
        const withoutMatchedPages = {
            ...previewOptions,
            matchPageSize: false,
        };
        expect(createScanCleanupPreviewCacheKey(1, withoutMatchedPages, '/tmp/source.pdf', 'rev', null, plan))
            .toBe(createScanCleanupPreviewCacheKey(1, withoutMatchedPages, '/tmp/source.pdf', 'rev', null, null));
        expect(createScanCleanupPreviewCacheKey(1, previewOptions, '/tmp/source.pdf', 'rev', null, plan))
            .not.toBe(createScanCleanupPreviewCacheKey(1, previewOptions, '/tmp/source.pdf', 'rev', null, null));
    });

    it('revalidates every cached page across the detection-completed transition instead of orphaning it', () => {
        const pages = [
            200,
            201,
            202,
            203,
            204,
            205,
            206,
            207,
        ];
        const prior = {
            dominantLayout: 'single-uncut-page' as const,
            cutterRatioMedian: null,
            clusterDims: {
                widthPx: 2119,
                heightPx: 3204,
            },
            agreementStrength: 0.74,
        };
        const plan = {
            widthPoints: 595,
            heightPoints: 842,
        };
        const keyFor = (pageNumber: number, detected: boolean) => createScanCleanupPreviewCacheKey(
            pageNumber,
            previewOptions,
            '/tmp/source.pdf',
            'rev',
            detected ? prior : null,
            detected ? plan : null,
        );

        const cache = createScanCleanupPreviewCache();
        for (const pageNumber of pages) cache.set(keyFor(pageNumber, false), result(new Uint8Array(1024), []));
        expect(cache.size).toBe(pages.length);
        const bytesBeforeDetection = cache.byteLength;

        // Detection completes: the prior and the plan land for the whole
        // document in one burst, so every key changes at once.
        for (const pageNumber of pages) {
            expect(cache.has(keyFor(pageNumber, true))).toBe(false);
        }
        expect(cache.size).toBe(pages.length);
        expect(cache.byteLength).toBe(bytesBeforeDetection);

        // Revisiting a page reclaims its superseded entry rather than adding a
        // second generation beside it.
        expect(cache.get(keyFor(pages[0]!, true))).toBeUndefined();
        expect(cache.size).toBe(pages.length - 1);
        for (const pageNumber of pages) cache.set(keyFor(pageNumber, true), result(new Uint8Array(1024), []));
        expect(cache.size).toBe(pages.length);
        expect(cache.byteLength).toBe(bytesBeforeDetection);
        for (const pageNumber of pages) {
            expect(cache.has(keyFor(pageNumber, true))).toBe(true);
            expect(cache.has(keyFor(pageNumber, false))).toBe(false);
        }
    });

    it('lets the byte budget bind before the entry count', () => {
        const cache = createScanCleanupPreviewCache();
        const pageBytes = 1_056_837; // An interior page of the 392-page reference scan.
        const pages = Array.from({length: 96}, (_unused, index) => 100 + index);
        for (const pageNumber of pages) {
            cache.set(`page-${pageNumber}`, result(new Uint8Array(pageBytes), []));
        }
        expect(cache.byteLength).toBeLessThanOrEqual(96 * 1024 * 1024);
        expect(cache.size).toBe(Math.floor(96 * 1024 * 1024 / pageBytes));
        expect(cache.size).toBeGreaterThan(10);
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
