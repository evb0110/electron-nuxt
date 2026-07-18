import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isDocumentPageSourceRasterCurrentForLayout,
    resolveDocumentPageSourceVisual,
    resolveDocumentPageSourceVisualPresentation,
} from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';

describe('document page-source visual presentation', () => {
    it.each([
        [
            'none',
            'pendingFrame',
        ],
        [
            'skeleton',
            'skeleton',
        ],
        [
            'fresh',
            'fresh',
        ],
        [
            'error',
            'error',
        ],
    ] as const)('maps %s to exactly one visible presentation', (visual, expectedFlag) => {
        const presentation = resolveDocumentPageSourceVisualPresentation(visual);
        const visibleFlags = Object.entries(presentation)
            .filter(([
                , visible,
            ]) => visible)
            .map(([flag]) => flag);

        expect(visibleFlags).toEqual([expectedFlag]);
    });

    it.each([
        'cold-shell',
        'prepared-shell',
    ] as const)('uses the canonical pending visual for %s viewport pages', (viewportPresentation) => {
        expect(resolveDocumentPageSourceVisual({
            pageNumber: 7,
            presentPendingAsSkeleton: true,
            viewportVisual: {
                kind: 'page',
                pageNumber: 7,
                presentation: viewportPresentation,
            },
        })).toBe('skeleton');
    });

    it('keys raster freshness to the current page layout width', () => {
        const metrics = {
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0 as const,
        };

        expect(isDocumentPageSourceRasterCurrentForLayout(
            {widthPx: 3960},
            metrics,
            6.47,
            1,
        )).toBe(true);
        expect(isDocumentPageSourceRasterCurrentForLayout(
            {widthPx: 2632},
            metrics,
            6.47,
            1,
        )).toBe(false);
    });
});
