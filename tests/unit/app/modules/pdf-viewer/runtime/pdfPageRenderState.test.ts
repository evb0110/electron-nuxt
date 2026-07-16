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
        });
    });

    it('removes empty idle slots', () => {
        const state = createPdfPageRenderState();
        state.renderedPages.add(2);
        expect(state.getSlot(2).visual).toBe('ready');
        state.renderedPages.delete(2);
        expect(state.slots.has(2)).toBe(false);
    });
});
