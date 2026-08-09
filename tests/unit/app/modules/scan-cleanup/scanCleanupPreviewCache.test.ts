import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    IScanCleanupPreviewResult,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';
import {scanCleanupMatchedCanvasOverridesSignature} from '@contracts/scanCleanupPageOverrides';
import {
    resolveScanCleanupDocumentCanvas,
    scanCleanupDocumentCanvasSignature,
} from '@scan-cleanup-core/policy/documentCanvas';
import {
    createScanCleanupDetailTileCacheKey,
    createScanCleanupPreviewCacheKey,
} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';
import {
    createScanCleanupPreviewCache,
    SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR,
} from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';

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

function override(value: Partial<IScanCleanupPageOverride>): IScanCleanupPageOverride {
    return {
        rotationDegrees: 0,
        layoutOverride: 'auto',
        excluded: false,
        manualSplit: null,
        ...value,
    };
}

// An entry the way it can actually arrive from disk or across the bridge:
// carrying only the fields it was ever given, while the type says it is whole.
function sparse(value: Partial<IScanCleanupPageOverride>): IScanCleanupPageOverride {
    return value as IScanCleanupPageOverride;
}

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

    it('invalidates an automatic preview when detection resolves its output mode', () => {
        const keyFor = (recommendation: 'bw' | 'color' | null) => createScanCleanupPreviewCacheKey(
            1,
            previewOptions,
            '/tmp/source.pdf',
            'rev',
            null,
            '',
            '',
            recommendation,
        );

        expect(keyFor('color')).not.toBe(keyFor(null));
        expect(keyFor('color')).not.toBe(keyFor('bw'));
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
        const keyFor = (pageNumber: number, detected: boolean) => createScanCleanupPreviewCacheKey(
            pageNumber,
            previewOptions,
            '/tmp/source.pdf',
            'rev',
            detected ? prior : null,
        );

        const cache = createScanCleanupPreviewCache();
        for (const pageNumber of pages) cache.set(keyFor(pageNumber, false), result(new Uint8Array(1024), []));
        expect(cache.size).toBe(pages.length);
        const bytesBeforeDetection = cache.byteLength;

        // Detection completes: the document prior lands for the whole
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

    it('revalidates a matched preview only when its resolved canvas plan moves', () => {
        const changedCanvas = scanCleanupDocumentCanvasSignature({
            widthPoints: 600,
            heightPoints: 800,
            widthPx: 1250,
            heightPx: 1667,
        });
        const unclassified = createScanCleanupPreviewCacheKey(1, previewOptions, '/tmp/source.pdf', 'rev', null);
        const classified = createScanCleanupPreviewCacheKey(
            1,
            previewOptions,
            '/tmp/source.pdf',
            'rev',
            null,
            changedCanvas,
        );
        const separator = SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR;

        // Learning that the document is spreads halves the sheet every page is
        // presented on, so a preview drawn before that is no longer current —
        // but it is the same page, so it is revalidated rather than orphaned.
        expect(classified).not.toBe(unclassified);
        expect(classified.split(separator)[0]).toBe(unclassified.split(separator)[0]);
        expect(createScanCleanupPreviewCacheKey(
            1,
            previewOptions,
            '/tmp/source.pdf',
            'rev',
            null,
            changedCanvas,
        )).toBe(classified);
        // Without matching there is no canvas for a layout to move.
        const unmatched = {
            ...previewOptions,
            matchPageSize: false,
        };
        expect(createScanCleanupPreviewCacheKey(1, unmatched, '/tmp/source.pdf', 'rev', null, changedCanvas))
            .toBe(createScanCleanupPreviewCacheKey(1, unmatched, '/tmp/source.pdf', 'rev', null));
    });

    it('keeps a homogeneous-spread preview stable until the computed canvas actually changes', () => {
        const pages = Array.from({length: 4}, (_, index) => ({
            pageNumber: index + 1,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 1_200,
            heightPoints: 800,
            rotation: 0,
        }));
        const baselinePlanSignature = scanCleanupDocumentCanvasSignature(
            resolveScanCleanupDocumentCanvas(pages, 150, previewOptions),
        );
        const signatureFor = (spreadPages: readonly number[]) => {
            const layouts = Object.fromEntries(spreadPages.map(pageNumber => [
                String(pageNumber),
                'two-page-spread' as const,
            ]));
            const signature = scanCleanupDocumentCanvasSignature(
                resolveScanCleanupDocumentCanvas(pages, 150, previewOptions, layouts),
            );
            return signature === baselinePlanSignature ? '' : signature;
        };
        const keyFor = (spreadPages: readonly number[]) => createScanCleanupPreviewCacheKey(
            1,
            previewOptions,
            '/tmp/source.pdf',
            'rev',
            null,
            signatureFor(spreadPages),
            '',
            null,
            null,
            'two-page-spread',
        );

        // Unknown pages remain full sheets. Incremental spread results do not
        // move the largest output rectangle until the last unknown page lands.
        const provisional = keyFor([1]);
        expect(keyFor([
            1,
            2,
        ])).toBe(provisional);
        expect(keyFor([
            1,
            2,
            3,
        ])).toBe(provisional);
        expect(keyFor([
            1,
            2,
            3,
            4,
        ])).not.toBe(provisional);
    });

    it('revalidates when the visible page itself is newly reclassified', () => {
        const keyFor = (classification: 'two-page-spread' | null) => createScanCleanupPreviewCacheKey(
            1,
            previewOptions,
            '/tmp/source.pdf',
            'rev',
            null,
            '',
            '',
            null,
            null,
            classification,
        );
        expect(keyFor('two-page-spread')).not.toBe(keyFor(null));
    });

    it('revalidates a matched preview against every page\'s canvas inputs, not just its own', () => {
        // The canvas is one rectangle measured over the whole document, so an
        // edit on page 40 changes the sheet page 1 was drawn on. Page 1's own
        // key carries page 1's override alone, which is why the document-wide
        // inputs are reduced separately and folded in here.
        const keyFor = (overrides: TScanCleanupPageOverrides) => createScanCleanupPreviewCacheKey(
            1,
            previewOptions,
            '/tmp/source.pdf',
            'rev',
            null,
            '',
            scanCleanupMatchedCanvasOverridesSignature(overrides),
        );
        const untouched = keyFor({});
        const separator = SCAN_CLEANUP_PREVIEW_CACHE_KEY_SEPARATOR;

        // Excluding another page takes it off the sheet, so the largest
        // rectangle the document produces can be a different one.
        const excludedElsewhere = keyFor({'40': override({excluded: true})});
        expect(excludedElsewhere).not.toBe(untouched);
        // Still page 1, so its entry is revalidated rather than orphaned.
        expect(excludedElsewhere.split(separator)[0]).toBe(untouched.split(separator)[0]);

        // The other inputs the canvas reads on another page: how many outputs
        // its sheet is cut into, and whether it can leave the bilevel budget.
        for (const canvasInput of [
            {layoutOverride: 'spread' as const},
            {layoutOverride: 'keep-left' as const},
            {layoutOverride: 'keep-right' as const},
            {layoutOverride: 'single' as const},
            {manualSplit: {
                xNormalized: 0.5,
                rotationDegrees: 0 as const,
            }},
            {outputModeOverride: 'color' as const},
        ]) {
            expect(keyFor({'40': override(canvasInput)})).not.toBe(untouched);
        }
        // Every distinct layout choice is a distinct canvas: keeping the left
        // half and forcing a spread cut the same sheet, but declaring the sheet
        // a single page does not.
        expect(keyFor({'40': override({layoutOverride: 'keep-left'})}))
            .not.toBe(keyFor({'40': override({layoutOverride: 'single'})}));

        // What the canvas cannot read stays cached: where a split falls, an
        // output mode that is still bilevel, and everything that is not a
        // canvas input at all.
        expect(keyFor({'40': override({manualSplit: {
            xNormalized: 0.5,
            rotationDegrees: 0,
        }})})).toBe(keyFor({'40': override({manualSplit: {
            xNormalized: 0.31,
            rotationDegrees: 0,
        }})}));
        expect(keyFor({'40': override({outputModeOverride: 'bw'})})).not.toBe(untouched);
        expect(keyFor({'40': override({outputModeOverride: 'color'})}))
            .toBe(keyFor({'40': override({outputModeOverride: 'grayscale'})}));
        expect(keyFor({'40': override({rotationDegrees: 90})})).toBe(untouched);

        // The same document answers the same key whatever order its overrides
        // were recorded in.
        expect(keyFor({
            '40': override({excluded: true}),
            '7': override({layoutOverride: 'spread'}),
        })).toBe(keyFor({
            '7': override({layoutOverride: 'spread'}),
            '40': override({excluded: true}),
        }));

        // And without matching there is no shared canvas for any of it to move.
        const unmatched = {
            ...previewOptions,
            matchPageSize: false,
        };
        expect(createScanCleanupPreviewCacheKey(
            1,
            unmatched,
            '/tmp/source.pdf',
            'rev',
            null,
            '',
            scanCleanupMatchedCanvasOverridesSignature({'40': override({excluded: true})}),
        )).toBe(createScanCleanupPreviewCacheKey(1, unmatched, '/tmp/source.pdf', 'rev', null));
    });

    it('reads a partially written override the way the canvas reads it', () => {
        // The record also arrives from disk and across the bridge, where an
        // entry can be missing the fields it was never given. The canvas fills
        // those in from the defaults, so a signature that read the raw entry
        // would answer a different key for a document the canvas measures
        // identically — and throw away every cached page of it.
        expect(scanCleanupMatchedCanvasOverridesSignature({'40': sparse({excluded: true})}))
            .toBe(scanCleanupMatchedCanvasOverridesSignature({'40': override({excluded: true})}));
        // An entry with nothing the canvas reads still reduces away entirely,
        // whether it is written whole or not at all.
        expect(scanCleanupMatchedCanvasOverridesSignature({'40': sparse({rotationDegrees: 90})})).toBe('');
        expect(scanCleanupMatchedCanvasOverridesSignature({'40': sparse({})})).toBe('');
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
