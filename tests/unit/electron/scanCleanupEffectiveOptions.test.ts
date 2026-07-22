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
});
