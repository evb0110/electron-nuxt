import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    BROWSER_DJVU_CONVERSION_MAX_PAGES,
    estimateDjvuPdfEffectivePixels,
    evaluateDjvuPdfConversionPolicy,
    resolveBrowserDjvuConversionPreflight,
    resolveDjvuPdfExportStrategy,
    resolveRecommendedDjvuPdfSubsample,
} from '@contracts/djvuConversionPolicy';

describe('djvuConversionPolicy', () => {
    it('blocks full-quality direct PDF export for high-DPI book scans', () => {
        const metrics = {
            pageCount: 564,
            sourceDpi: 600,
            pageSizes: Array.from({length: 564}, () => ({
                width: 5100,
                height: 6600,
            })),
        };

        expect(Math.round(estimateDjvuPdfEffectivePixels(metrics, 1) / 1_000_000_000)).toBe(19);
        expect(resolveRecommendedDjvuPdfSubsample(metrics)).toBe(2);
        expect(evaluateDjvuPdfConversionPolicy(metrics, 1)).toMatchObject({
            recommendedSubsample: 2,
            isAllowed: false,
        });
        expect(evaluateDjvuPdfConversionPolicy(metrics, 2)).toMatchObject({
            recommendedSubsample: 2,
            isAllowed: true,
        });
    });

    it('falls back to page count and DPI when page sizes are unavailable', () => {
        const metrics = {
            pageCount: 10,
            sourceDpi: 300,
        };

        expect(resolveRecommendedDjvuPdfSubsample(metrics)).toBe(1);
        expect(evaluateDjvuPdfConversionPolicy(metrics, 1).isAllowed).toBe(true);
    });

    it('allows browser conversion at the page-count limit and blocks above it', () => {
        const pageSize = {
            width: 2550,
            height: 3300,
        };

        expect(resolveBrowserDjvuConversionPreflight(
            Array.from({length: BROWSER_DJVU_CONVERSION_MAX_PAGES}, () => pageSize),
        )).toMatchObject({
            allowed: true,
            pageCount: 500,
        });
        expect(resolveBrowserDjvuConversionPreflight(
            Array.from({length: BROWSER_DJVU_CONVERSION_MAX_PAGES + 1}, () => pageSize),
        )).toMatchObject({
            allowed: false,
            reason: 'page-count',
            pageCount: 501,
        });
    });

    it('blocks browser conversion for oversized pages', () => {
        expect(resolveBrowserDjvuConversionPreflight([{
            width: 10_000,
            height: 9_000,
        }])).toMatchObject({
            allowed: false,
            reason: 'page-pixels',
            observedMaxPagePixels: 90_000_000,
        });
    });

    it('checks the page-count limit from pageCount alone when page sizes are unavailable', () => {
        expect(resolveBrowserDjvuConversionPreflight([], 564)).toMatchObject({
            allowed: false,
            reason: 'page-count',
            pageCount: 564,
        });
        expect(resolveBrowserDjvuConversionPreflight([], 120)).toMatchObject({
            allowed: true,
            pageCount: 120,
        });
    });

    it('resolves Stage A PDF export strategies without changing default direct conversion', () => {
        expect(resolveDjvuPdfExportStrategy(undefined)).toBe('direct');
        expect(resolveDjvuPdfExportStrategy('direct')).toBe('direct');
        expect(resolveDjvuPdfExportStrategy('auto')).toBe('direct');
        expect(resolveDjvuPdfExportStrategy('compact-djvu-aware')).toBe('compact-djvu-aware');
    });
});
