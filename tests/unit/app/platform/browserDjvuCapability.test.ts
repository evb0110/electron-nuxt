import {
    describe,
    expect,
    it,
} from 'vitest';
import {
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
});
