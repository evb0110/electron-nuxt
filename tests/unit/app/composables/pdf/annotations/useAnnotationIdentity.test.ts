import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';

vi.stubGlobal('DOMMatrix', class {
    a = 1;
    d = 1;
});

const { likelyEditorPdfMirror } = await import('@app/composables/pdf/annotations/annotationIdentityMatching');

function makeRect(
    left: number,
    top: number,
    width: number,
    height: number,
): IAnnotationMarkerRect {
    return {
        left,
        top,
        width,
        height,
    };
}

function makeSummary(
    overrides: Partial<IAnnotationCommentSummary> = {},
): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'id-default',
        stableKey: overrides.stableKey ?? 'stable-default',
        sortIndex: overrides.sortIndex ?? null,
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? '',
        kindLabel: overrides.kindLabel ?? null,
        subtype: overrides.subtype ?? 'FreeText',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        uid: overrides.uid ?? null,
        annotationId: overrides.annotationId ?? null,
        source: overrides.source ?? 'editor',
        hasNote: overrides.hasNote ?? true,
        markerRect: overrides.markerRect ?? makeRect(0.1, 0.1, 0.2, 0.05),
    };
}

describe('likelyEditorPdfMirror', () => {
    describe('early returns', () => {
        it('returns false when pageIndex differs', () => {
            const left = makeSummary({
                source: 'editor',
                pageIndex: 0,
            });
            const right = makeSummary({
                source: 'pdf',
                pageIndex: 1,
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });

        it('returns false when source is identical', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'a-1',
            });
            const right = makeSummary({
                source: 'editor',
                annotationId: 'a-2',
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });

        it('returns false when either side has no note', () => {
            const left = makeSummary({
                source: 'editor',
                hasNote: true,
            });
            const right = makeSummary({
                source: 'pdf',
                hasNote: false,
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);

            const left2 = makeSummary({
                source: 'editor',
                hasNote: false,
            });
            const right2 = makeSummary({
                source: 'pdf',
                hasNote: true,
            });
            expect(likelyEditorPdfMirror(left2, right2)).toBe(false);
        });

        it('returns false when both texts are non-empty and differ', () => {
            const left = makeSummary({
                source: 'editor',
                text: 'hello',
                annotationId: 'shared',
            });
            const right = makeSummary({
                source: 'pdf',
                text: 'world',
                annotationId: 'shared',
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });
    });

    describe('subtype gate', () => {
        it('returns false when left subtype is not text-like', () => {
            const left = makeSummary({
                source: 'editor',
                subtype: 'Square',
                annotationId: 'shared',
            });
            const right = makeSummary({
                source: 'pdf',
                subtype: 'FreeText',
                annotationId: 'shared',
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });

        it('returns false when right subtype is not text-like', () => {
            const left = makeSummary({
                source: 'editor',
                subtype: 'FreeText',
                annotationId: 'shared',
            });
            const right = makeSummary({
                source: 'pdf',
                subtype: 'Circle',
                annotationId: 'shared',
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });

        it('accepts text markup subtypes (highlight) as text-like', () => {
            const left = makeSummary({
                source: 'editor',
                subtype: 'Highlight',
                annotationId: 'shared',
            });
            const right = makeSummary({
                source: 'pdf',
                subtype: 'Highlight',
                annotationId: 'shared',
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });

        it('accepts underline subtype as text-like', () => {
            const left = makeSummary({
                source: 'editor',
                subtype: 'Underline',
                uid: 'shared-uid',
            });
            const right = makeSummary({
                source: 'pdf',
                subtype: 'Underline',
                uid: 'shared-uid',
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });

        it('accepts subtype containing "popup" as text-like', () => {
            const left = makeSummary({
                source: 'editor',
                subtype: 'Popup',
                annotationId: 'shared',
            });
            const right = makeSummary({
                source: 'pdf',
                subtype: 'Popup',
                annotationId: 'shared',
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });
    });

    describe('shared identity short-circuits', () => {
        it('returns true when annotationIds match (no geometry needed)', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'shared',
                markerRect: makeRect(0, 0, 0.001, 0.001),
            });
            const right = makeSummary({
                source: 'pdf',
                annotationId: 'shared',
                markerRect: makeRect(0.9, 0.9, 0.05, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });

        it('returns true when uids match (no geometry needed)', () => {
            const left = makeSummary({
                source: 'editor',
                uid: 'shared-uid',
                markerRect: makeRect(0, 0, 0.001, 0.001),
            });
            const right = makeSummary({
                source: 'pdf',
                uid: 'shared-uid',
                markerRect: makeRect(0.9, 0.9, 0.05, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });
    });

    describe('zero stable refs', () => {
        it('returns false when neither side has annotationId or uid', () => {
            const left = makeSummary({
                source: 'editor',
                markerRect: makeRect(0.1, 0.1, 0.2, 0.05),
            });
            const right = makeSummary({
                source: 'pdf',
                markerRect: makeRect(0.1, 0.1, 0.2, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });
    });

    describe('both sides with stable refs', () => {
        it('returns true with both texts present, IoU above 0.18', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: 'note',
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            const right = makeSummary({
                source: 'pdf',
                uid: 'right-uid',
                text: 'note',
                markerRect: makeRect(0.12, 0.10, 0.20, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });

        it('returns true with both texts present and modifiedClose only', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: 'note',
                modifiedAt: 1000,
                markerRect: makeRect(0.10, 0.10, 0.05, 0.02),
            });
            const right = makeSummary({
                source: 'pdf',
                uid: 'right-uid',
                text: 'note',
                modifiedAt: 2500,
                markerRect: makeRect(0.85, 0.85, 0.05, 0.02),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });

        it('returns false with both texts present and weak geometry, far modifiedAt', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: 'note',
                modifiedAt: 1000,
                markerRect: makeRect(0.10, 0.10, 0.05, 0.02),
            });
            const right = makeSummary({
                source: 'pdf',
                uid: 'right-uid',
                text: 'note',
                modifiedAt: 100000,
                markerRect: makeRect(0.85, 0.85, 0.05, 0.02),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });

        it('returns true with empty text on both sides via modifiedClose AND IoU >= 0.28', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: '',
                modifiedAt: 1000,
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            const right = makeSummary({
                source: 'pdf',
                uid: 'right-uid',
                text: '',
                modifiedAt: 2000,
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });

        it('returns false with empty texts when modifiedClose holds but IoU/centerDistance fail', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: '',
                modifiedAt: 1000,
                markerRect: makeRect(0.10, 0.10, 0.05, 0.02),
            });
            const right = makeSummary({
                source: 'pdf',
                uid: 'right-uid',
                text: '',
                modifiedAt: 2000,
                markerRect: makeRect(0.85, 0.85, 0.05, 0.02),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });
    });

    describe('single-side stable ref (one missing)', () => {
        it('returns true when one has annotationId, both texts equal, and IoU >= 0.62', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: 'foo',
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            const right = makeSummary({
                source: 'pdf',
                annotationId: null,
                uid: null,
                text: 'foo',
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });

        it('returns false when geometry is weak (no strong overlap)', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: 'foo',
                markerRect: makeRect(0.10, 0.10, 0.05, 0.02),
            });
            const right = makeSummary({
                source: 'pdf',
                annotationId: null,
                uid: null,
                text: 'foo',
                markerRect: makeRect(0.85, 0.85, 0.05, 0.02),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });

        it('returns false when both texts are present but unequal', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: 'foo',
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            const right = makeSummary({
                source: 'pdf',
                annotationId: null,
                uid: null,
                text: 'bar',
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });

        it('returns true with empty text and modifiedClose with strong geometry', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: '',
                modifiedAt: 1000,
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            const right = makeSummary({
                source: 'pdf',
                annotationId: null,
                uid: null,
                text: '',
                modifiedAt: 2500,
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });

        it('returns true via centerDistance <= 0.018 even without modifiedClose', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: '',
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            const right = makeSummary({
                source: 'pdf',
                annotationId: null,
                uid: null,
                text: '',
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });
    });

    describe('text similarity edge cases', () => {
        it('treats empty + non-empty text as not contradictory (one side missing text)', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: 'note',
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            const right = makeSummary({
                source: 'pdf',
                uid: 'right-uid',
                text: '',
                modifiedAt: null,
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            // both stable refs path: no modifiedClose, IoU=1 >= 0.28 -> false (needs modifiedClose)
            expect(likelyEditorPdfMirror(left, right)).toBe(false);
        });

        it('treats whitespace-only text as empty', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'left-ann',
                text: '   ',
                modifiedAt: 1000,
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            const right = makeSummary({
                source: 'pdf',
                uid: 'right-uid',
                text: '   ',
                modifiedAt: 2500,
                markerRect: makeRect(0.10, 0.10, 0.20, 0.05),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });
    });

    describe('author handling', () => {
        it('does not consider author equality (mirror works regardless of author)', () => {
            const left = makeSummary({
                source: 'editor',
                annotationId: 'shared',
                author: 'Alice',
            });
            const right = makeSummary({
                source: 'pdf',
                annotationId: 'shared',
                author: 'Bob',
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });
    });
});
