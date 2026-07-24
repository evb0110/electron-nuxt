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
            job: 'rendering',
            version: 2,
            requestId: 11,
            documentToken: 'document-a',
            targetScale: 2,
            targetOutputScale: 1,
            committedRasterQuality: null,
            pendingDocumentToken: 'document-a',
            pendingTargetScale: 2,
            pendingTargetOutputScale: 1,
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
            job: 'failed',
            version: 11,
            requestId: 15,
            documentToken: 'document-a',
            targetScale: 2,
            targetOutputScale: 1,
            committedRasterQuality: null,
            pendingDocumentToken: 'document-a',
            pendingTargetScale: 2,
            pendingTargetOutputScale: 1,
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

    it('removes empty idle slots', () => {
        const state = createPdfPageRenderState();
        state.renderedPages.add(2);
        expect(state.getSlot(2).visual).toBe('ready');
        state.renderedPages.delete(2);
        expect(state.slots.has(2)).toBe(false);
    });
});
