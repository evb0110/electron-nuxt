import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';

describe('pdfPageRenderState', () => {
    it('represents stale content while a replacement render is active', () => {
        const state = createPdfPageRenderState();

        state.renderedPages.add(4);
        state.staleRenderedPages.add(4);
        state.renderingPages.set(4, 8);
        state.renderingPageRequestIds.set(4, 12);

        expect(state.getSlot(4)).toEqual({
            visual: 'stale',
            job: 'rendering',
            version: 8,
            requestId: 12,
            documentToken: null,
            targetScale: null,
        });
        expect(state.renderedPages.has(4)).toBe(true);
        expect(state.staleRenderedPages.has(4)).toBe(true);
    });

    it('promotes a completed page atomically and removes empty idle slots', () => {
        const state = createPdfPageRenderState();
        state.renderingPages.set(2, 3);
        state.renderingPageRequestIds.set(2, 7);
        state.renderedPages.add(2);
        state.staleRenderedPages.delete(2);
        state.renderingPages.delete(2);

        expect(state.getSlot(2)).toEqual({
            visual: 'fresh',
            job: 'idle',
            version: null,
            requestId: null,
            documentToken: null,
            targetScale: null,
        });

        state.renderedPages.delete(2);
        expect(state.slots.has(2)).toBe(false);
    });

    it('retains failed jobs independently from visual availability', () => {
        const state = createPdfPageRenderState();
        state.renderedPages.add(6);
        state.staleRenderedPages.add(6);
        state.markRenderFailed(6, 11, 15);

        expect(state.getSlot(6)).toEqual({
            visual: 'stale',
            job: 'failed',
            version: 11,
            requestId: 15,
            documentToken: null,
            targetScale: null,
        });
        expect(state.renderingPages.has(6)).toBe(false);
    });

    it('keeps stale pixels until the matching replacement canvas commits', () => {
        const state = createPdfPageRenderState();
        state.beginRender(1, 1, 10, 'document-a', 1);
        expect(state.commitCanvas(1, 1, 10)).toBe(true);

        state.beginRender(1, 2, 11, 'document-a', 2);
        expect(state.getSlot(1).visual).toBe('stale');
        expect(state.commitCanvas(1, 1, 10)).toBe(false);
        expect(state.commitCanvas(1, 2, 11)).toBe(true);
        expect(state.getSlot(1).visual).toBe('fresh');
    });

    it('never preserves a previous document canvas as current', () => {
        const state = createPdfPageRenderState();
        state.beginRender(1, 1, 1, 'document-a', 1);
        state.commitCanvas(1, 1, 1);
        state.beginRender(1, 2, 2, 'document-b', 1);
        expect(state.getSlot(1).visual).toBe('none');
    });
});
