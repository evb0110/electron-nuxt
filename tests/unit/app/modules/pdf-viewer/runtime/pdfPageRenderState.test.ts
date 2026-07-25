import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';

describe('pdfPageRenderState', () => {
    it('makes a page not ready as soon as a replacement render begins', () => {
        const state = createPdfPageRenderState();
        state.beginRender(4, 1, 10, 'document-a', 1);
        expect(state.commitCanvas(4, 1, 10)).toBe(true);
        expect(state.getSlot(4).visual).toBe('ready');

        state.beginRender(4, 2, 11, 'document-a', 2);

        expect(state.getSlot(4)).toEqual({
            visual: 'none',
            canvasReadiness: 'none',
            layerReadiness: 'none',
            job: 'rendering',
            version: 2,
            contentVersion: 2,
            requestId: 11,
            documentToken: 'document-a',
            targetScale: 2,
            targetOutputScale: 1,
            container: null,
            committedRasterQuality: null,
            pendingDocumentToken: 'document-a',
            pendingTargetScale: 2,
            pendingTargetOutputScale: 1,
            pendingContainer: null,
        });
        expect(state.renderedPages.has(4)).toBe(false);
    });

    it('commits only the matching canonical replacement', () => {
        const state = createPdfPageRenderState();
        state.beginRender(1, 1, 10, 'document-a', 1);
        expect(state.commitCanvas(1, 1, 10)).toBe(true);

        state.beginRender(1, 2, 11, 'document-a', 2);
        expect(state.commitCanvas(1, 1, 10)).toBe(false);
        expect(state.getSlot(1).visual).toBe('none');
        expect(state.commitCanvas(1, 2, 11)).toBe(true);
        expect(state.getSlot(1).visual).toBe('ready');
    });

    it('keeps a failed replacement not ready for skeleton or error presentation', () => {
        const state = createPdfPageRenderState();
        state.beginRender(6, 10, 14, 'document-a', 1);
        state.commitCanvas(6, 10, 14);
        state.beginRender(6, 11, 15, 'document-a', 2);
        state.markRenderFailed(6, 11, 15);

        expect(state.getSlot(6)).toEqual({
            visual: 'none',
            canvasReadiness: 'none',
            layerReadiness: 'none',
            job: 'failed',
            version: 11,
            contentVersion: 11,
            requestId: 15,
            documentToken: 'document-a',
            targetScale: 2,
            targetOutputScale: 1,
            container: null,
            committedRasterQuality: null,
            pendingDocumentToken: 'document-a',
            pendingTargetScale: 2,
            pendingTargetOutputScale: 1,
            pendingContainer: null,
        });
    });

    it('keeps a clamped buffer visual ready until its settled replacement commits', () => {
        const state = createPdfPageRenderState();
        state.beginRender(8, 1, 10, 'document-a', 1, 2);
        expect(state.commitCanvas(8, 1, 10, {
            requestedPixels: 8_000_000,
            grantedPixels: 2_000_000,
            pixelScaleFactor: 0.5,
            wasClamped: true,
            intent: 'buffer-preview',
        })).toBe(true);

        state.beginQualityRefine(8, 2, 11, 'document-a', 1, 2);

        expect(state.getSlot(8).visual).toBe('ready');
        expect(state.getSlot(8).committedRasterQuality).toEqual({
            requestedPixels: 8_000_000,
            grantedPixels: 2_000_000,
            pixelScaleFactor: 0.5,
            wasClamped: true,
            intent: 'buffer-preview',
        });

        expect(state.commitCanvas(8, 2, 11, {
            requestedPixels: 8_000_000,
            grantedPixels: 6_000_000,
            pixelScaleFactor: Math.sqrt(0.75),
            wasClamped: true,
            intent: 'settled',
        })).toBe(true);
        expect(state.getSlot(8).committedRasterQuality?.intent).toBe('settled');
        expect(state.getSlot(8).visual).toBe('ready');
    });

    it('does not let a stale quality refine replace the current committed visual', () => {
        const state = createPdfPageRenderState();
        state.beginRender(3, 1, 10, 'document-a', 1, 1);
        state.commitCanvas(3, 1, 10);
        state.beginQualityRefine(3, 2, 11, 'document-a', 1, 1);
        state.beginQualityRefine(3, 3, 12, 'document-a', 1, 1);

        expect(state.commitVisual(3, 2, 11, {
            requestedPixels: 4,
            grantedPixels: 4,
            pixelScaleFactor: 1,
            wasClamped: false,
            intent: 'settled',
        })).toBe(false);
        expect(state.getSlot(3).requestId).toBe(12);
        expect(state.getSlot(3).visual).toBe('ready');
    });

    it('tracks canvas and layer readiness independently for the current mounted slot', () => {
        const state = createPdfPageRenderState();
        const container = {} as HTMLElement;
        state.beginRender(3, 8, 21, 'document-a', 1.25, 2, container);
        const bufferQuality = {
            requestedPixels: 8_000_000,
            grantedPixels: 2_000_000,
            pixelScaleFactor: 0.5,
            wasClamped: true,
            intent: 'buffer-preview' as const,
        };
        expect(state.commitVisual(3, 8, 21, bufferQuality)).toBe(true);
        expect(state.markCanvasOnly(3, 8, 21)).toBe(true);
        expect(state.completeRender(3, 8, 21)).toBe(true);

        expect(state.getSlot(3)).toEqual(expect.objectContaining({
            canvasReadiness: 'ready',
            layerReadiness: 'canvas-only',
            contentVersion: 8,
            container,
        }));
        expect(state.beginLayerHydration(3, 8, 22, 'document-a', 1.25, 2, container)).toBe(true);
        expect(state.getSlot(3).layerReadiness).toBe('hydrating');
        expect(state.markLayersReady(3, 8, container)).toBe(true);
        expect(state.completeRender(3, 8, 22)).toBe(true);
        expect(state.getSlot(3).layerReadiness).toBe('ready');
        expect(state.getSlot(3).committedRasterQuality).toEqual(bufferQuality);
        expect(state.adoptCommittedCanvasVersion(3, 9)).toBe(true);
        expect(state.getSlot(3)).toEqual(expect.objectContaining({
            canvasReadiness: 'ready',
            committedRasterQuality: bufferQuality,
            contentVersion: 9,
            documentToken: 'document-a',
            job: 'idle',
            layerReadiness: 'ready',
        }));

        expect(state.beginLayerHydration(
            3,
            8,
            23,
            'document-a',
            1.25,
            2,
            {} as HTMLElement,
        )).toBe(false);
    });

    it('re-authorizes a committed canvas without letting old-token work commit afterward', () => {
        const state = createPdfPageRenderState();
        const container = {} as HTMLElement;
        state.beginRender(3, 8, 21, 'document-a', 1.25, 2, container);
        expect(state.commitCanvas(3, 8, 21)).toBe(true);
        state.beginQualityRefine(3, 9, 22, 'document-a', 1.25, 2, container);

        expect(state.adoptCommittedCanvasVersion(3, 10, 'document-b')).toBe(true);
        expect(state.getSlot(3)).toEqual(expect.objectContaining({
            canvasReadiness: 'ready',
            contentVersion: 10,
            documentToken: 'document-b',
            job: 'idle',
            layerReadiness: 'none',
        }));
        expect(state.commitCanvas(3, 9, 22)).toBe(false);
        expect(state.getSlot(3).documentToken).toBe('document-b');
    });

    it('removes empty idle slots', () => {
        const state = createPdfPageRenderState();
        state.renderedPages.add(2);
        expect(state.getSlot(2).visual).toBe('ready');
        state.renderedPages.delete(2);
        expect(state.slots.has(2)).toBe(false);
    });
});
