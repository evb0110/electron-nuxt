import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { useAnnotationMarkerViewModel } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMarkerViewModel';
import { cast } from '@tests/helpers/cast';

const labels = {
    annotation: 'Annotation',
    note: 'Note',
    moreNotes: (count: number) => `${count} more`,
};

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
    it('renders marker for sticky-note anchors and excludes non-note drawing annotations', () => {
        const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([
            createComment({
                id: 'sticky-1',
                stableKey: 'ann:0:sticky-1',
                annotationId: 'sticky-1',
                hasNote: true,
                subtype: 'Typewriter',
                text: 'Sticky note text',
                markerRect: {
                    left: 0.1,
                    top: 0.1,
                    width: 0.0016,
                    height: 0.0016,
                },
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
            labels,
        });

        const pageMarkers = markersByPage.value.get(1) ?? [];
        expect(pageMarkers).toHaveLength(1);
        expect(pageMarkers[0]?.annotation.stableKey).toBe('ann:0:sticky-1');
    });

    it('excludes regular FreeText/Typewriter text annotations from marker layer', () => {
        const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([createComment({
            id: 'text-1',
            stableKey: 'ann:0:text-1',
            annotationId: 'text-1',
            hasNote: true,
            subtype: 'Typewriter',
            kindLabel: 'Inline Note',
            markerRect: {
                left: 0.24,
                top: 0.18,
                width: 0.22,
                height: 0.09,
            },
        })]);

        const { markersByPage } = useAnnotationMarkerViewModel({
            viewerContainer: ref<HTMLElement | null>(null),
            annotationCommentsCache,
            activeCommentStableKey: ref<string | null>(null),
            labels,
        });

        const pageMarkers = markersByPage.value.get(1) ?? [];
        expect(pageMarkers).toHaveLength(0);
    });

    it('recomputes marker placement when the marker geometry version changes', async () => {
        const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([createComment({
            hasNote: true,
            subtype: 'Highlight',
            markerRect: {
                left: 0,
                top: 0.1,
                width: 0.001,
                height: 0.001,
            },
        })]);
        const pageWidth = ref(100);
        const pageContainer = cast<HTMLElement>({getBoundingClientRect: () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: pageWidth.value,
            bottom: 100,
            width: pageWidth.value,
            height: 100,
            toJSON: () => ({}),
        })});
        const viewerContainer = ref(cast<HTMLElement>({querySelector: (selector: string) => (
            selector === '.page_container[data-page="1"]'
                ? pageContainer
                : null
        )}));
        const markerGeometryVersion = ref(0);

        const { markersByPage } = useAnnotationMarkerViewModel({
            viewerContainer,
            annotationCommentsCache,
            activeCommentStableKey: ref<string | null>(null),
            markerGeometryVersion,
            labels,
        });

        const initialLeft = markersByPage.value.get(1)?.[0]?.leftPercent;
        expect(initialLeft).toBe(10);

        pageWidth.value = 400;
        markerGeometryVersion.value += 1;
        await nextTick();

        expect(markersByPage.value.get(1)?.[0]?.leftPercent).toBe(2.5);
    });
});
