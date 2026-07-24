import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveBrowserDjvuCompactExportPlan,
    resolveBrowserDjvuConversionPreflight,
    resolveBrowserDjvuPdfRenderConcurrency,
    resolveBrowserDjvuPdfRenderSettings,
} from '@app/platform/browser-api/browserDjvuCapability';

describe('browserDjvuCapability', () => {
    it('keeps direct raster exports at the requested source detail', () => {
        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'direct',
            subsample: 1,
        })).toEqual({
            strategy: 'direct',
            subsample: 1,
            jpegQuality: 0.92,
        });

        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'auto',
            subsample: 4,
        })).toEqual({
            strategy: 'direct',
            subsample: 4,
            jpegQuality: 0.92,
        });
    });

    it('uses a bounded compact raster fallback for compact DjVu-aware web exports', () => {
        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'compact-djvu-aware',
            subsample: 1,
        })).toEqual({
            strategy: 'compact-djvu-aware',
            subsample: 1,
            jpegQuality: 85,
        });

        expect(resolveBrowserDjvuPdfRenderSettings({
            pdfStrategy: 'compact-djvu-aware',
            subsample: 4,
        })).toEqual({
            strategy: 'compact-djvu-aware',
            subsample: 4,
            jpegQuality: 85,
        });
    });

    it('caps browser DjVu page rendering concurrency by cores and page size', () => {
        const ordinaryPages = Array.from({ length: 10 }, () => ({
            width: 2_400,
            height: 3_200,
        }));

        expect(resolveBrowserDjvuPdfRenderConcurrency(ordinaryPages, 8)).toBe(3);
        expect(resolveBrowserDjvuPdfRenderConcurrency(ordinaryPages, 2)).toBe(1);
        expect(resolveBrowserDjvuPdfRenderConcurrency([ordinaryPages[0]!], 8)).toBe(1);
        expect(resolveBrowserDjvuPdfRenderConcurrency([
            {
                width: 4_500,
                height: 4_000,
            },
            {
                width: 4_500,
                height: 4_000,
            },
        ], 8)).toBe(2);
        expect(resolveBrowserDjvuPdfRenderConcurrency([
            {
                width: 6_000,
                height: 6_000,
            },
            {
                width: 6_000,
                height: 6_000,
            },
        ], 8)).toBe(1);
    });

    it.each([
        [
            'low',
            1,
        ],
        [
            'medium',
            3,
        ],
        [
            'high',
            3,
        ],
    ] as const)('clamps %s-tier browser DjVu conversion concurrency to %i', (tier, expectedConcurrency) => {
        const ordinaryPages = Array.from({length: 10}, () => ({
            width: 2_400,
            height: 3_200,
        }));

        expect(resolveBrowserDjvuPdfRenderConcurrency(
            ordinaryPages,
            8,
            0,
            tier,
        )).toBe(expectedConcurrency);
    });

    it('falls compact web export back to streaming direct export when page specs exceed the memory budget', () => {
        expect(resolveBrowserDjvuCompactExportPlan([{
            width: 100,
            height: 100,
            dpi: 300,
        }], 40_000)).toEqual({
            strategy: 'compact-djvu-aware',
            estimatedPageSpecBytes: 30_256,
            maxPageSpecBytes: 40_000,
        });

        expect(resolveBrowserDjvuCompactExportPlan([{
            width: 1_000,
            height: 1_000,
            dpi: 300,
        }], 1_000_000)).toEqual({
            strategy: 'direct-fallback',
            estimatedPageSpecBytes: 3_000_256,
            maxPageSpecBytes: 1_000_000,
            fallbackReason: 'memory-budget',
        });
    });

    it('uses the bookmark-capable streaming path when compact export must preserve bookmarks', () => {
        expect(resolveBrowserDjvuCompactExportPlan([{
            width: 100,
            height: 100,
            dpi: 300,
        }], 40_000, true)).toEqual({
            strategy: 'direct-fallback',
            estimatedPageSpecBytes: 30_256,
            maxPageSpecBytes: 40_000,
            fallbackReason: 'bookmarks',
        });
    });

    it('reports browser conversion boundaries before raster rendering starts', () => {
        expect(resolveBrowserDjvuConversionPreflight(Array.from({length: 500}, () => ({
            width: 8_000,
            height: 10_000,
            dpi: 300,
        })))).toMatchObject({
            allowed: true,
            maxPagePixels: 80_000_000,
            maxPages: 500,
        });
        expect(resolveBrowserDjvuConversionPreflight(Array.from({length: 501}, () => ({
            width: 100,
            height: 100,
            dpi: 300,
        })))).toMatchObject({
            allowed: false,
            reason: 'page-count',
        });
        expect(resolveBrowserDjvuConversionPreflight([{
            width: 10_000,
            height: 8_001,
            dpi: 300,
        }])).toMatchObject({
            allowed: false,
            reason: 'page-pixels',
        });
    });
});
