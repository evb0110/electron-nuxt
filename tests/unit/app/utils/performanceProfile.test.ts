import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
    PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY,
    PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION,
    PDF_BUFFER_PAGES_WORKSTATION,
    PDF_PAGE_PROXY_CACHE_DEFAULT,
    PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
    PDF_PAGE_PROXY_CACHE_WORKSTATION,
    PDF_RENDER_CONCURRENCY_DEFAULT,
    PDF_RENDER_CONCURRENCY_LOW_CPU,
    PDF_RENDER_CONCURRENCY_LOW_MEMORY,
    PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
    PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
    PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION,
    PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
    PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE,
    PDF_THUMBNAIL_CONCURRENCY_WORKSTATION,
    resolvePerformanceProfile,
} from '@app/utils/performanceProfile';

describe('resolvePerformanceProfile', () => {
    it('uses the conservative low profile when memory and CPU are unknown', () => {
        expect(resolvePerformanceProfile({})).toMatchObject({
            lowMemory: true,
            lowCpu: true,
            pdfBufferPages: 1,
            concurrentPdfRenders: 1,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY,
        });
        expect(PDF_RENDER_CONCURRENCY_LOW_CPU).toBe(1);
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
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
        });
    });

    it('does not trust clamped 8 GB deviceMemory as real high memory when total RAM is available', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 8,
            hardwareConcurrency: 8,
            totalMemoryBytes: 8 * 1024 ** 3,
        })).toMatchObject({
            lowMemory: true,
            lowCpu: false,
            pdfBufferPages: 1,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_MEMORY,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY,
        });
    });

    it('scales render, prefetch, proxy, thumbnail, and raster budgets upward on workstations', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 8,
            hardwareConcurrency: 24,
            totalMemoryBytes: 32 * 1024 ** 3,
        })).toMatchObject({
            lowMemory: false,
            lowCpu: false,
            pdfBufferPages: PDF_BUFFER_PAGES_WORKSTATION,
            concurrentPdfRenders: 6,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_WORKSTATION,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_WORKSTATION,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION,
        });
    });

    it('requires both workstation memory and CPU before widening concurrent work', () => {
        expect(resolvePerformanceProfile({
            hardwareConcurrency: 8,
            totalMemoryBytes: 64 * 1024 ** 3,
        })).toMatchObject({
            pdfBufferPages: 2,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_DEFAULT,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_DEFAULT,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
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
            concurrentPdfRenders: 1,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
        });
        expect(PDF_RENDER_CONCURRENCY_LOW_CPU).toBe(1);
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
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY,
        });
    });
});
