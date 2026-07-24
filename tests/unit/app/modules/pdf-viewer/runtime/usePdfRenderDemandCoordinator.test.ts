import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolvePdfViewportRasterPolicy } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderDemandCoordinator';

describe('PDF viewport raster demand policy', () => {
    it('keeps required mounted pages ahead of a distance-ordered buffer', () => {
        const output = resolvePdfViewportRasterPolicy({
            bufferRadius: 3,
            estimatePagePixels: () => 10,
            maxBufferPixels: 100,
            mountedPages: [
                39,
                40,
                41,
                42,
                43,
                44,
                45,
                46,
                47,
            ],
            visibleRange: {
                start: 43,
                end: 44,
            },
        });

        expect(output.requiredPages).toEqual([
            43,
            44,
        ]);
        expect(output.bufferPages).toEqual([
            45,
            42,
            46,
            41,
            47,
            40,
        ]);
        expect(output.residentPages).toEqual([
            43,
            44,
            45,
            42,
            46,
            41,
            47,
            40,
        ]);
    });

    it('renders only the viewport-centered raster window inside broader geometry', () => {
        const output = resolvePdfViewportRasterPolicy({
            bufferRadius: 3,
            estimatePagePixels: () => 10,
            maxBufferPixels: 100,
            mountedPages: Array.from({length: 15}, (_, index) => 36 + index),
            visibleRange: {
                start: 43,
                end: 43,
            },
        });

        expect(output.residentPages).toEqual([
            43,
            44,
            42,
            45,
            41,
            46,
            40,
        ]);
        expect(output.residentPages).not.toContain(36);
        expect(output.residentPages).not.toContain(50);
    });

    it('does not rasterize a far disjoint mounted segment', () => {
        const output = resolvePdfViewportRasterPolicy({
            bufferRadius: 2,
            estimatePagePixels: () => 10,
            maxBufferPixels: 100,
            mountedPages: [
                1,
                2,
                3,
                98,
                99,
                100,
            ],
            visibleRange: {
                start: 1,
                end: 1,
            },
        });

        expect(output.residentPages).toEqual([
            1,
            2,
            3,
        ]);
    });

    it('enforces the shared buffer pixel budget without dropping required pages', () => {
        const output = resolvePdfViewportRasterPolicy({
            bufferRadius: 4,
            estimatePagePixels: pageNumber => pageNumber === 43 ? 1_000 : 40,
            maxBufferPixels: 80,
            mountedPages: [
                39,
                40,
                41,
                42,
                43,
                44,
                45,
                46,
                47,
            ],
            visibleRange: {
                start: 43,
                end: 43,
            },
        });

        expect(output.requiredPages).toEqual([43]);
        expect(output.bufferPages).toEqual([
            44,
            42,
        ]);
        expect(output.residentPages).toEqual([
            43,
            44,
            42,
        ]);
    });

    it('never admits an unmounted required or buffer page', () => {
        const output = resolvePdfViewportRasterPolicy({
            bufferRadius: 2,
            estimatePagePixels: () => 1,
            maxBufferPixels: 100,
            mountedPages: [
                42,
                44,
            ],
            visibleRange: {
                start: 43,
                end: 44,
            },
        });

        expect(output.requiredPages).toEqual([44]);
        expect(output.bufferPages).toEqual([42]);
        expect(output.residentPages).toEqual([
            44,
            42,
        ]);
    });
});
