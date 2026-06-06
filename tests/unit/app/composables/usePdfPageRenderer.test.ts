import {
    describe,
    expect,
    it,
} from 'vitest';
import { collectPreservedRenderPageNumbers } from '@app/utils/pdf-viewer/pdf-page-render-preservation/collectPreservedRenderPageNumbers';
import { shouldRenderPageWithPreservedState } from '@app/utils/pdf-viewer/pdf-page-render-preservation/shouldRenderPageWithPreservedState';

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

describe('shouldRenderPageWithPreservedState', () => {
    it('forces a render when bookkeeping says rendered but the mounted canvas is missing', () => {
        expect(shouldRenderPageWithPreservedState({
            pageNumber: 100,
            renderedPages: new Set([100]),
            staleRenderedPages: new Set(),
            forceRerender: false,
            hasMountedCanvas: () => false,
        })).toBe(true);
    });

    it('skips only when rendered bookkeeping and mounted canvas agree', () => {
        expect(shouldRenderPageWithPreservedState({
            pageNumber: 100,
            renderedPages: new Set([100]),
            staleRenderedPages: new Set(),
            forceRerender: false,
            hasMountedCanvas: () => true,
        })).toBe(false);
    });
});
