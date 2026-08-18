import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TScanCleanupOutputHalf} from '@contracts/electronApiScanCleanup';
import {
    clusterScanCleanupPlacementAnchors,
    createScanCleanupPageOverride,
    estimateScanCleanupOutputPages,
    getScanCleanupPageOverride,
    resolveScanCleanupInkAnchor,
    resolveScanCleanupPageLayout,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupOutputPlacement,
    resolveScanCleanupPlacementOffset,
    setScanCleanupPageOverride,
    shouldShowScanCleanupOutputEstimate,
} from '@contracts/scanCleanupPageOverrides';

describe('scan cleanup page overrides', () => {
    it('merges sparse page values over stable defaults and removes reset entries', () => {
        const overrides = {};
        expect(getScanCleanupPageOverride(overrides, 3)).toEqual({
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
        });
        setScanCleanupPageOverride(overrides, 3, createScanCleanupPageOverride({
            rotationDegrees: 90,
            manualSplit: {
                xNormalized: 0.5,
                rotationDegrees: 0,
            },
        }));
        expect(getScanCleanupPageOverride(overrides, 3)).toMatchObject({
            rotationDegrees: 90,
            manualSplit: {
                xNormalized: 0.5,
                rotationDegrees: 0,
            },
        });
        setScanCleanupPageOverride(overrides, 3, createScanCleanupPageOverride());
        expect(overrides).toEqual({});
    });

    it('preserves and resets a per-page manual deskew angle', () => {
        const overrides = {};
        setScanCleanupPageOverride(overrides, 2, createScanCleanupPageOverride({manualSkewDegrees: -2.3}));
        expect(getScanCleanupPageOverride(overrides, 2).manualSkewDegrees).toBe(-2.3);

        setScanCleanupPageOverride(overrides, 2, createScanCleanupPageOverride());
        expect(overrides).toEqual({});
    });

    it('maps authoritative layout overrides onto document defaults', () => {
        expect(resolveScanCleanupPageLayout('auto', 'spread')).toBe('force-two-page');
        expect(resolveScanCleanupPageLayout('force-two-page', 'single')).toBe('force-single');
        expect(resolveScanCleanupPageLayout('auto', 'keep-right')).toBe('keep-right');
        expect(resolveScanCleanupPageLayout('force-single', 'auto')).toBe('force-single');
    });

    it('resolves per-output placement over the document default', () => {
        const override = createScanCleanupPageOverride({placementOverrides: {right: 'bottom-right'}});
        expect(resolveScanCleanupOutputPlacement('top-left', override, 'left')).toBe('top-left');
        expect(resolveScanCleanupOutputPlacement('top-left', override, 'right')).toBe('bottom-right');
    });

    it('normalizes equal margin overrides away and preserves asymmetric overrides', () => {
        const documentMargins = {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        };
        const overrides = {};
        setScanCleanupPageOverride(overrides, 3, createScanCleanupPageOverride({marginsMm: {...documentMargins}}), documentMargins);
        expect(overrides).toEqual({});

        const asymmetricMargins = {
            leftMm: 2,
            topMm: 4,
            rightMm: 6,
            bottomMm: 8,
        };
        setScanCleanupPageOverride(overrides, 3, createScanCleanupPageOverride({marginsMm: asymmetricMargins}), documentMargins);
        expect(resolveScanCleanupMarginsMm(documentMargins, getScanCleanupPageOverride(overrides, 3)))
            .toEqual(asymmetricMargins);
    });

    it('accounts exactly for exclusions and forced output counts', () => {
        const classifications = new Map([
            [
                1,
                'two-page-spread' as const,
            ],
            [
                4,
                'single-uncut-page' as const,
            ],
        ]);
        const pageOverrides = {
            '2': createScanCleanupPageOverride({excluded: true}),
            '3': createScanCleanupPageOverride({layoutOverride: 'spread'}),
            '4': createScanCleanupPageOverride({layoutOverride: 'keep-left'}),
        };
        expect(estimateScanCleanupOutputPages(4, {
            layoutMode: 'auto',
            pageOverrides,
        }, classifications)).toEqual({
            exact: true,
            outputPages: 5,
        });
    });

    it('marks the estimate approximate when blank pages may be removed', () => {
        expect(estimateScanCleanupOutputPages(2, {
            layoutMode: 'force-single',
            pageOverrides: {},
            skipBlankPages: true,
        }, new Map())).toEqual({
            exact: false,
            outputPages: 2,
        });
    });

    it('hides an automatic estimate until it has classification evidence', () => {
        const options = {
            layoutMode: 'auto' as const,
            pageOverrides: {},
        };
        expect(shouldShowScanCleanupOutputEstimate(3, options, new Map())).toBe(false);
        expect(shouldShowScanCleanupOutputEstimate(3, options, new Map([[
            1,
            'single-uncut-page' as const,
        ]]))).toBe(true);
        expect(shouldShowScanCleanupOutputEstimate(3, {
            ...options,
            layoutMode: 'force-two-page',
        }, new Map())).toBe(true);
    });

    it('shows exact counts when overrides fully determine every included page', () => {
        const pageOverrides = {
            '1': createScanCleanupPageOverride({layoutOverride: 'spread'}),
            '2': createScanCleanupPageOverride({excluded: true}),
        };
        expect(shouldShowScanCleanupOutputEstimate(2, {
            layoutMode: 'auto',
            pageOverrides,
        }, new Map())).toBe(true);
        expect(estimateScanCleanupOutputPages(2, {
            layoutMode: 'auto',
            pageOverrides,
        }, new Map())).toEqual({
            exact: true,
            outputPages: 2,
        });
    });
});

describe('scan cleanup ink placement', () => {
    function sample(
        pageNumber: number,
        half: TScanCleanupOutputHalf,
        xNormalized: number,
        yNormalized: number,
    ) {
        return {
            pageNumber,
            half,
            xNormalized,
            yNormalized,
        };
    }

    it('expresses a content box in its own output leaf frame', () => {
        expect(resolveScanCleanupInkAnchor({
            xNormalized: 0.1,
            yNormalized: 0.2,
            widthNormalized: 0.4,
            heightNormalized: 0.5,
            rotationDegrees: 0,
        }, 'full')).toEqual({
            xNormalized: expect.closeTo(0.3, 10),
            yNormalized: 0.2,
        });
        // Both leaves of a spread carry page-normalized boxes, so the same
        // margin on either side has to answer the same leaf-relative anchor.
        expect(resolveScanCleanupInkAnchor({
            xNormalized: 0.1,
            yNormalized: 0.2,
            widthNormalized: 0.2,
            heightNormalized: 0.5,
            rotationDegrees: 0,
        }, 'left')).toEqual({
            xNormalized: 0.4,
            yNormalized: 0.2,
        });
        expect(resolveScanCleanupInkAnchor({
            xNormalized: 0.6,
            yNormalized: 0.2,
            widthNormalized: 0.2,
            heightNormalized: 0.5,
            rotationDegrees: 0,
        }, 'right')).toEqual({
            xNormalized: expect.closeTo(0.4, 10),
            yNormalized: 0.2,
        });
    });

    it('keeps an unusable content box inside the normalized frame', () => {
        expect(resolveScanCleanupInkAnchor({
            xNormalized: -1,
            yNormalized: 2,
            widthNormalized: 0,
            heightNormalized: 0,
            rotationDegrees: 0,
        }, 'full')).toEqual({
            xNormalized: 0,
            yNormalized: 1,
        });
        expect(resolveScanCleanupInkAnchor({
            xNormalized: Number.NaN,
            yNormalized: Number.NaN,
            widthNormalized: 0,
            heightNormalized: 0,
            rotationDegrees: 0,
        }, 'full')).toEqual({
            xNormalized: 0,
            yNormalized: 0,
        });
    });

    it('leaves a single page on its own measured position', () => {
        expect(clusterScanCleanupPlacementAnchors([sample(1, 'full', 0.5, 0.11)], {
            x: 0.02,
            y: 0.02,
        })).toEqual(new Map([[
            1,
            {full: {
                xNormalized: 0.5,
                yNormalized: 0.11,
            }},
        ]]));
    });

    it('snaps pages that agree within the tolerance onto the cluster median', () => {
        const anchors = clusterScanCleanupPlacementAnchors([
            sample(1, 'full', 0.5, 0.1),
            sample(2, 'full', 0.5, 0.12),
            sample(3, 'full', 0.5, 0.13),
        ], {
            x: 0.02,
            y: 0.05,
        });
        expect([...anchors.values()].map(entry => entry.full?.yNormalized)).toEqual([
            0.12,
            0.12,
            0.12,
        ]);
    });

    it('splits a run that drifts past the tolerance instead of chaining', () => {
        const anchors = clusterScanCleanupPlacementAnchors([
            sample(1, 'full', 0.5, 0.1),
            sample(2, 'full', 0.5, 0.14),
            sample(3, 'full', 0.5, 0.18),
        ], {
            x: 0.02,
            y: 0.05,
        });
        expect([...anchors.values()].map(entry => entry.full?.yNormalized)).toEqual([
            0.1,
            0.1,
            0.18,
        ]);
    });

    it('clusters each half and each axis independently', () => {
        const anchors = clusterScanCleanupPlacementAnchors([
            sample(1, 'left', 0.4, 0.1),
            sample(1, 'right', 0.6, 0.1),
            sample(2, 'left', 0.41, 0.3),
            sample(2, 'right', 0.61, 0.11),
        ], {
            x: 0.02,
            y: 0.02,
        });
        expect(anchors.get(1)).toEqual({
            left: {
                xNormalized: 0.4,
                yNormalized: 0.1,
            },
            right: {
                xNormalized: 0.6,
                yNormalized: 0.1,
            },
        });
        expect(anchors.get(2)).toEqual({
            left: {
                // The verso keeps its own column: only the recto agreed.
                xNormalized: 0.4,
                yNormalized: 0.3,
            },
            right: {
                xNormalized: 0.6,
                yNormalized: 0.1,
            },
        });
    });

    it('resolves the same anchors whatever order the evidence arrived in', () => {
        const samples = [
            sample(4, 'full', 0.5, 0.13),
            sample(1, 'full', 0.5, 0.1),
            sample(3, 'full', 0.52, 0.12),
            sample(2, 'full', 0.49, 0.11),
        ];
        const tolerance = {
            x: 0.05,
            y: 0.05,
        };
        const expected = clusterScanCleanupPlacementAnchors(samples, tolerance);
        expect(clusterScanCleanupPlacementAnchors([...samples].reverse(), tolerance))
            .toEqual(expected);
        expect(clusterScanCleanupPlacementAnchors([
            samples[2]!,
            samples[0]!,
            samples[3]!,
            samples[1]!,
        ], tolerance)).toEqual(expected);
    });

    it('places content at its anchor inside the free space', () => {
        expect(resolveScanCleanupPlacementOffset(100, 200, 'ink', {
            anchor: {
                xNormalized: 0.5,
                yNormalized: 0.25,
            },
            contentWidth: 50,
            contentHeight: 100,
        })).toEqual({
            x: 50,
            y: 75,
        });
    });

    it('never lets an anchor push content past the requested margins', () => {
        expect(resolveScanCleanupPlacementOffset(100, 200, 'ink', {
            anchor: {
                xNormalized: 1,
                yNormalized: 1,
            },
            contentWidth: 50,
            contentHeight: 100,
        })).toEqual({
            x: 100,
            y: 200,
        });
        expect(resolveScanCleanupPlacementOffset(100, 200, 'ink', {
            anchor: {
                xNormalized: 0,
                yNormalized: 0,
            },
            contentWidth: 50,
            contentHeight: 100,
        })).toEqual({
            x: 0,
            y: 0,
        });
    });

    it('falls back to top-center when a page has no resolved anchor', () => {
        expect(resolveScanCleanupPlacementOffset(100, 200, 'ink'))
            .toEqual(resolveScanCleanupPlacementOffset(100, 200, 'top-center'));
    });
});
