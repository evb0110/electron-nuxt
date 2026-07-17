import {
    describe,
    expect,
    it,
} from 'vitest';
import {
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
});
