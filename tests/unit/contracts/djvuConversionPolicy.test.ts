import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    estimateDjvuPdfEffectivePixels,
    evaluateDjvuPdfConversionPolicy,
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
});
