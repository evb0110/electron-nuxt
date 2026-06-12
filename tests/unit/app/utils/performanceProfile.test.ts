import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_PAGE_PROXY_CACHE_DEFAULT,
    PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
    PDF_RENDER_CONCURRENCY_DEFAULT,
    PDF_RENDER_CONCURRENCY_LOW_CPU,
    PDF_RENDER_CONCURRENCY_LOW_MEMORY,
    PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
    PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
    PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
    PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE,
    resolvePerformanceProfile,
} from '@app/utils/performanceProfile';

describe('resolvePerformanceProfile', () => {
    it('uses the conservative low profile when memory and CPU are unknown', () => {
        expect(resolvePerformanceProfile({})).toMatchObject({
            lowMemory: true,
            lowCpu: true,
            pdfBufferPages: 1,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_CPU,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
        });
    });

    it('keeps full counts on capable hardware and raises the settled canvas budget', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 8,
            hardwareConcurrency: 8,
        })).toMatchObject({
            lowMemory: false,
            lowCpu: false,
            pdfBufferPages: 2,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_DEFAULT,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_DEFAULT,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
        });
    });

    it('serializes PDF renders on low-CPU machines without lowering the canvas budget', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 8,
            hardwareConcurrency: 4,
        })).toMatchObject({
            lowMemory: false,
            lowCpu: true,
            pdfBufferPages: 2,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_CPU,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
        });
    });

    it('reduces off-screen counts on low-memory machines with enough CPU cores', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 4,
            hardwareConcurrency: 8,
        })).toMatchObject({
            lowMemory: true,
            lowCpu: false,
            pdfBufferPages: 1,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_MEMORY,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
        });
    });
});
