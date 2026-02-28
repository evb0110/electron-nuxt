import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { useAnnotationMarkerViewModel } from '@app/composables/pdf/annotations/useAnnotationMarkerViewModel';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'ann-1',
        stableKey: 'ann:0:ann-1',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        kindLabel: null,
        subtype: null,
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: 'ann-1',
        source: 'editor',
        hasNote: false,
        markerRect: {
            left: 0.1,
            top: 0.1,
            width: 0.05,
            height: 0.05,
        },
        ...overrides,
    };
}

describe('useAnnotationMarkerViewModel', () => {
    it('renders markers for note annotations and excludes non-note drawing annotations', () => {
        const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([
            createComment({
                id: 'sticky-1',
                stableKey: 'ann:0:sticky-1',
                annotationId: 'sticky-1',
                hasNote: true,
                subtype: 'Typewriter',
                text: 'Sticky note text',
            }),
            createComment({
                id: 'draw-1',
                stableKey: 'ann:0:draw-1',
                annotationId: 'draw-1',
                hasNote: false,
                subtype: 'Ink',
                kindLabel: 'Freehand Line',
                markerRect: {
                    left: 0.6,
                    top: 0.2,
                    width: 0.15,
                    height: 0.04,
                },
            }),
        ]);

        const { markersByPage } = useAnnotationMarkerViewModel({
            viewerContainer: ref<HTMLElement | null>(null),
            annotationCommentsCache,
            activeCommentStableKey: ref<string | null>(null),
        });

        const pageMarkers = markersByPage.value.get(1) ?? [];
        expect(pageMarkers).toHaveLength(1);
        expect(pageMarkers[0]?.annotation.stableKey).toBe('ann:0:sticky-1');
    });
});
