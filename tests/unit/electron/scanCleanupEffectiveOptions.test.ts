import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {resolveEffectiveScanCleanupOptions} from '@electron/features/scan-cleanup/policy/effectiveOptions';

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'bw',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 1,
        topMm: 2,
        rightMm: 3,
        bottomMm: 4,
    },
    despeckle: true,
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

function resolve(pageOverride = createScanCleanupPageOverride()) {
    return resolveEffectiveScanCleanupOptions({
        options,
        pageOverride,
        dpi: 300,
        qualityPath: 'raster',
    });
}

describe('effective scan cleanup options', () => {
    it('maps the existing despeckle boolean to the native level contract', () => {
        expect(resolve().despeckleLevel).toBe('normal');
        expect(resolveEffectiveScanCleanupOptions({
            options: {
                ...options,
                despeckle: false,
            },
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            qualityPath: 'raster',
        }).despeckleLevel).toBe('off');
    });

    it('passes asymmetric document margins through unchanged', () => {
        expect(resolve().margins).toEqual(options.marginsMm);
    });

    it('gives a page margin override precedence over document margins', () => {
        const pageMargins = {
            leftMm: 8,
            topMm: 7,
            rightMm: 6,
            bottomMm: 5,
        };
        expect(resolve(createScanCleanupPageOverride({marginsMm: pageMargins})).margins)
            .toEqual(pageMargins);
    });

    it('disables crop and margins while automatic dewarp uses source-region coordinates', () => {
        const effective = resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride({manualContentBoxes: {full: {
                xNormalized: 0.1,
                yNormalized: 0.1,
                widthNormalized: 0.8,
                heightNormalized: 0.8,
                rotationDegrees: 0,
            }}}),
            dpi: 300,
            qualityPath: 'raster',
            experimental: {autoDewarp: true},
        });

        expect(effective.cropContent).toBe(false);
        expect(effective.manualContentBoxes).toEqual({});
        expect(effective.margins).toEqual({
            leftMm: 0,
            topMm: 0,
            rightMm: 0,
            bottomMm: 0,
        });
        expect(effective.experimental.autoDewarp).toBe(true);
    });

    it('keeps preserve-original-quality analysis free of raster normalization', () => {
        const effective = resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            qualityPath: 'lossless',
            experimental: {autoDewarp: true},
        });

        expect(effective.normalizeIllumination).toBe(false);
        expect(effective.despeckleLevel).toBe('off');
        expect(effective.experimental.autoDewarp).toBe(false);
    });
});
