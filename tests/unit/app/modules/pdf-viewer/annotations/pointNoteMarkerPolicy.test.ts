// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    POINT_NOTE_MARKER_MAX_NORMALIZED_SIZE,
    POINT_NOTE_MARKER_SIZE_ROUNDING_TOLERANCE,
    isPointNoteMarkerSizedRect,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/pointNoteMarkerPolicy';
import {
    POINT_NOTE_MARKER_SIZE,
    toFreeTextNoteMarkerRect,
} from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shared/toFreeTextNoteMarkerRect';
import { toMarkerRectFromPdfRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import { toPdfRectFromMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfRectFromMarkerRect';
import { resolveEditorMarkerRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveEditorMarkerRect';
import { buildPdfAnnotationCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/buildPdfAnnotationCommentSummary';
import { useAnnotationMarkerViewModel } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMarkerViewModel';
import { mountEnrichmentHost } from '@tests/helpers/annotationEnrichmentNoticeHarness';
import PdfAnnotationCommentsList from '@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue';

vi.mock('@app/services/pdfjs/runtimeLib', () => ({PDFDateString: {toDateObject: () => null}}));

let unmountList: (() => void) | null = null;

afterEach(() => {
    unmountList?.();
    unmountList = null;
});

/**
 * The comments list has no exported predicate: a point-sized inline note drops
 * its colour chip, a page-sized one keeps it. That rendered difference is the
 * only way to observe the list's own classification.
 *
 * The mount goes through the shared annotations-panel harness, so this test and
 * the enrichment-notice tests agree on how the list is stubbed. The chip is a
 * plain element of the list's own template rather than a design-system
 * component, so the harness's stubs leave the classification observable.
 */
async function mountCommentsListChip(size: number) {
    const {
        host,
        unmount,
    } = await mountEnrichmentHost(PdfAnnotationCommentsList, () => ({
        comments: [{
            ...createMarkerComment(size),
            hasNote: false,
            color: '#ef4444',
        }],
        status: 'ready',
    }));
    unmountList = unmount;
    return host;
}

const THRESHOLD = POINT_NOTE_MARKER_MAX_NORMALIZED_SIZE;
const TOLERANCE = POINT_NOTE_MARKER_SIZE_ROUNDING_TOLERANCE;

/**
 * One table for every production classification site. `size` is the normalized
 * width and height of the anchor rect; `isPointNote` is the single answer all
 * sites must agree on.
 *
 * `survivesPageDivision` marks the sizes that keep their answer after a round
 * trip through PDF-rect arithmetic. The two tolerance-edge sizes differ from
 * the threshold by less than the error that dividing a PDF rect by a page box
 * introduces, so only the sites that receive an already-normalized rect can be
 * asked about them.
 */
const SIZE_CASES = [
    {
        label: 'the app anchor size',
        size: POINT_NOTE_MARKER_SIZE,
        isPointNote: true,
        survivesPageDivision: true,
    },
    {
        label: 'just below the threshold',
        size: 0.019_999,
        isPointNote: true,
        survivesPageDivision: true,
    },
    {
        label: 'exactly at the threshold',
        size: THRESHOLD,
        isPointNote: true,
        survivesPageDivision: true,
    },
    {
        label: 'at the rounding-tolerance edge',
        size: THRESHOLD + TOLERANCE,
        isPointNote: true,
        survivesPageDivision: false,
    },
    {
        label: 'one tolerance step past the edge',
        size: THRESHOLD + TOLERANCE * 2,
        isPointNote: false,
        survivesPageDivision: false,
    },
    {
        label: 'just above the threshold',
        size: 0.020_001,
        isPointNote: false,
        survivesPageDivision: true,
    },
    {
        label: 'an editor-sized FreeText block',
        size: 0.2,
        isPointNote: false,
        survivesPageDivision: true,
    },
    {
        // Degenerate geometry is not a very small marker. It cannot be drawn,
        // hit-tested or dragged, so every site must reject it and the save
        // pipeline must rewrite it to a usable anchor.
        label: 'a zero-sized rect',
        size: 0,
        isPointNote: false,
        survivesPageDivision: false,
    },
    {
        label: 'a negative-sized rect',
        size: -0.01,
        isPointNote: false,
        survivesPageDivision: false,
    },
] as const;

const DOCUMENT_RECT_CASES = SIZE_CASES.filter(testCase => testCase.survivesPageDivision);

function squareRect(size: number, left = 0.25, top = 0.4): IAnnotationMarkerRect {
    return {
        left,
        top,
        width: size,
        height: size,
    };
}

const computeStableKey = vi.fn((params: {
    pageIndex: number;
    id: string;
    source: 'editor' | 'pdf' | 'shape';
}) => `src:${params.source}:${params.pageIndex}:${params.id}` as const);

const summaryDeps = {
    computeStableKey,
    resolveKindLabel: (subtype: string | null | undefined) => `kind:${subtype ?? 'null'}`,
};

function buildFreeTextNoteSummary(size: number) {
    // A unit page turns PDF-rect arithmetic into page fractions directly, so
    // the summary sees the offset-and-subtract rounding a real document
    // produces rather than a hand-written exact fraction.
    return buildPdfAnnotationCommentSummary(
        {
            id: '12R0',
            subtype: 'FreeText',
            rect: [
                0.5,
                0.25,
                0.5 + size,
                0.25 + size,
            ],
            popupRef: '13R0',
            contentsObj: {str: 'Sticky note'},
        },
        null,
        1,
        0,
        [
            0,
            0,
            1,
            1,
        ],
        0,
        summaryDeps,
    );
}

function createMarkerComment(size: number): IAnnotationCommentSummary {
    return {
        id: 'note-1',
        stableKey: 'ann:0:note-1',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Sticky note',
        kindLabel: null,
        subtype: 'FreeText',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: 'note-1',
        source: 'pdf',
        hasNote: true,
        markerRect: squareRect(size),
    };
}

describe('point-note marker threshold policy', () => {
    it('documents the threshold and its coordinate meaning', () => {
        expect(POINT_NOTE_MARKER_MAX_NORMALIZED_SIZE).toBe(0.02);
        expect(POINT_NOTE_MARKER_SIZE_ROUNDING_TOLERANCE).toBe(Number.EPSILON * 16);
    });

    it.each([
        {
            width: 0,
            height: 0.001,
        },
        {
            width: 0.001,
            height: 0,
        },
        {
            width: -0.001,
            height: 0.001,
        },
        {
            width: 0.001,
            height: -0.001,
        },
        {
            width: 0,
            height: 0,
        },
    ])('rejects the non-positive rect %j', (rect) => {
        expect(isPointNoteMarkerSizedRect(rect)).toBe(false);
    });

    it('rejects absent and non-finite rects', () => {
        expect(isPointNoteMarkerSizedRect(null)).toBe(false);
        expect(isPointNoteMarkerSizedRect(undefined)).toBe(false);
        expect(isPointNoteMarkerSizedRect({
            width: Number.NaN,
            height: 0.001,
        })).toBe(false);
        expect(isPointNoteMarkerSizedRect({
            width: 0.001,
            height: Number.POSITIVE_INFINITY,
        })).toBe(false);
    });

    it('classifies a rect by its larger side', () => {
        expect(isPointNoteMarkerSizedRect({
            width: 0.001,
            height: 0.2,
        })).toBe(false);
        expect(isPointNoteMarkerSizedRect({
            width: 0.2,
            height: 0.001,
        })).toBe(false);
    });

    describe.each(SIZE_CASES)('$label ($size)', ({
        size,
        isPointNote,
    }) => {
        it('matches the shared predicate', () => {
            expect(isPointNoteMarkerSizedRect(squareRect(size))).toBe(isPointNote);
        });

        it('agrees in the save pipeline', () => {
            const rect = squareRect(size);
            const saved = toFreeTextNoteMarkerRect(rect);

            expect(saved).toEqual(isPointNote
                ? rect
                : {
                    left: rect.left,
                    top: rect.top,
                    width: POINT_NOTE_MARKER_SIZE,
                    height: POINT_NOTE_MARKER_SIZE,
                });
        });

        it('agrees in the editor marker resolver', () => {
            const editor: IPdfjsEditor = {
                x: 0.2,
                y: 0.3,
                width: 0.1,
                height: 0.1,
                __evbPendingAnchorRect: squareRect(size, 0.21, 0.31),
            };

            expect(resolveEditorMarkerRect(editor).shouldUsePendingAnchor).toBe(isPointNote);
        });

        it('agrees in the comments list', async () => {
            const host = await mountCommentsListChip(size);

            expect(host.querySelectorAll('.note-item-color-chip'))
                .toHaveLength(isPointNote ? 0 : 1);
        });

        it('agrees in the page marker view model', () => {
            const { markersByPage } = useAnnotationMarkerViewModel({
                viewerContainer: ref<HTMLElement | null>(null),
                annotationCommentsCache: ref([createMarkerComment(size)]),
                activeCommentStableKey: ref<string | null>(null),
                labels: {
                    annotation: 'Annotation',
                    note: 'Note',
                    moreNotes: (count: number) => `${count} more`,
                },
            });

            expect(markersByPage.value.get(1) ?? []).toHaveLength(isPointNote ? 1 : 0);
        });
    });

    describe.each(DOCUMENT_RECT_CASES)('$label ($size) as a document rect', ({
        size,
        isPointNote,
    }) => {
        it('agrees in the comment-summary classifier', () => {
            expect(buildFreeTextNoteSummary(size).hasNote).toBe(isPointNote);
        });
    });

    describe.each([
        0,
        90,
        180,
        270,
    ] as const)('page rotation %s', (pageRotation) => {
        // A4 in points. A non-square page is the only way to catch a rotation
        // that swaps the axes without swapping the divisors.
        const PAGE_VIEW = [
            0,
            0,
            595,
            842,
        ];
        const POINT_NOTE_PDF_RECT = [
            100,
            200,
            101,
            202,
        ];
        const EDITOR_BLOCK_PDF_RECT = [
            100,
            200,
            160,
            240,
        ];

        function importRect(rect: number[]) {
            const imported = toMarkerRectFromPdfRect(rect, PAGE_VIEW, pageRotation);
            expect(imported).not.toBeNull();
            return imported!;
        }

        it('classifies an imported point-note anchor the same way at every rotation', () => {
            expect(isPointNoteMarkerSizedRect(importRect(POINT_NOTE_PDF_RECT))).toBe(true);
            expect(isPointNoteMarkerSizedRect(importRect(EDITOR_BLOCK_PDF_RECT))).toBe(false);
        });

        it('round-trips an imported point-note anchor back to its PDF rect', () => {
            const imported = importRect(POINT_NOTE_PDF_RECT);
            const saved = toFreeTextNoteMarkerRect(imported);

            // The save pipeline must leave a real marker alone, or the
            // annotation would drift a little on every save.
            expect(saved).toEqual(imported);

            const savedPdfRect = toPdfRectFromMarkerRect(saved, PAGE_VIEW, pageRotation);
            expect(savedPdfRect).not.toBeNull();
            savedPdfRect!.forEach((value, index) => {
                expect(value).toBeCloseTo(POINT_NOTE_PDF_RECT[index]!, 6);
            });
        });

        it('shrinks an imported editor-sized block to the anchor size at every rotation', () => {
            const imported = importRect(EDITOR_BLOCK_PDF_RECT);
            const saved = toFreeTextNoteMarkerRect(imported);

            expect(saved).toEqual({
                left: imported.left,
                top: imported.top,
                width: POINT_NOTE_MARKER_SIZE,
                height: POINT_NOTE_MARKER_SIZE,
            });
        });

        it('agrees with the comment-summary classifier at every rotation', () => {
            const summarize = (rect: number[]) => buildPdfAnnotationCommentSummary(
                {
                    id: '12R0',
                    subtype: 'FreeText',
                    rect,
                    popupRef: '13R0',
                    contentsObj: {str: 'Sticky note'},
                },
                null,
                1,
                0,
                PAGE_VIEW,
                pageRotation,
                summaryDeps,
            );

            expect(summarize(POINT_NOTE_PDF_RECT).hasNote).toBe(true);
            expect(summarize(EDITOR_BLOCK_PDF_RECT).hasNote).toBe(false);
        });

        it('turns a degenerate imported rect into a usable anchor instead of dropping it', () => {
            // A FreeText annotation serialized with a zero-area rect is
            // malformed, not a tiny marker. Import expands it, the shared
            // predicate then accepts the expanded anchor, and the save writes
            // that anchor back unchanged.
            const degenerate = importRect([
                100,
                200,
                100,
                200,
            ]);

            expect(degenerate.width).toBeGreaterThan(0);
            expect(degenerate.height).toBeGreaterThan(0);
            expect(isPointNoteMarkerSizedRect(degenerate)).toBe(true);
            expect(toFreeTextNoteMarkerRect(degenerate)).toEqual(degenerate);
        });
    });

    it('keeps a threshold-sized document rect a marker despite division rounding', () => {
        // (0.5 + 0.02) - 0.5 lands one step above 0.02 in binary floating point.
        // Without the shared rounding tolerance this rect would be reclassified
        // as page content and shrunk on save.
        const roundedSide = (0.5 + THRESHOLD) - 0.5;

        expect(roundedSide).toBeGreaterThan(THRESHOLD);
        expect(isPointNoteMarkerSizedRect(squareRect(roundedSide))).toBe(true);
        expect(toFreeTextNoteMarkerRect(squareRect(roundedSide))).toEqual(squareRect(roundedSide));
    });
});
