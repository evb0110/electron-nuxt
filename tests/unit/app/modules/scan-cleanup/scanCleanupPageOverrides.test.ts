import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createScanCleanupPageOverride,
    estimateScanCleanupOutputPages,
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupOutputPlacement,
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
