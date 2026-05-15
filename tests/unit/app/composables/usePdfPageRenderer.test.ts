import {
    describe,
    expect,
    it,
} from 'vitest';
import { collectPreservedRenderPageNumbers } from '@app/composables/pdf/pdfPageRenderPreservation';

describe('collectPreservedRenderPageNumbers', () => {
    it('preserves finalized pages and pages with mounted canvases during rerender handoff', () => {
        const renderedPages = new Set([
            1,
            3,
        ]);
        const pageCanvases = new Map<number, unknown>([
            [
                1,
                {},
            ],
            [
                2,
                {},
            ],
        ]);

        const preservedPages = collectPreservedRenderPageNumbers({
            renderedPages,
            pageCanvases,
        });

        expect([...preservedPages]).toEqual([
            1,
            3,
            2,
        ]);
    });
});
