import {
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

vi.stubGlobal('DOMMatrix', class {
    a = 1;
    d = 1;
});

const { areTextMarkupCommentsLikelySame } = await import('@app/utils/pdf-viewer/annotations/annotation-identity-matching/areTextMarkupCommentsLikelySame');
const { commentsAreSameLogicalAnnotation } = await import('@app/utils/pdf-viewer/annotations/annotation-identity-matching/commentsAreSameLogicalAnnotation');
const { likelyEditorPdfMirror } = await import('@app/utils/pdf-viewer/annotations/annotation-identity-matching/likelyEditorPdfMirror');
const { mergeCommentSummaries } = await import('@app/utils/pdf-viewer/annotations/annotation-identity-matching/mergeCommentSummaries');
const { mergeDuplicateCommentSummary } = await import('@app/utils/pdf-viewer/annotations/annotation-identity-matching/mergeDuplicateCommentSummary');
const { selectPreferredAnnotationComment } = await import('@app/utils/pdf-viewer/annotation-comment-matching/selectPreferredAnnotationComment');
const { useAnnotationIdentity } = await import('@app/modules/pdf-viewer/runtime/annotations/useAnnotationIdentity');

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
        displayText: overrides.displayText ?? null,
        previewText: overrides.previewText ?? null,
        kindLabel: overrides.kindLabel ?? null,
        subtype: overrides.subtype ?? 'FreeText',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        colorEdited: overrides.colorEdited,
        uid: overrides.uid ?? null,
        annotationId: overrides.annotationId ?? null,
        annotationName: overrides.annotationName ?? null,
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

        it('returns true when PDF annotation names match (no geometry needed)', () => {
            const left = makeSummary({
                source: 'editor',
                annotationName: 'evb-markup:stable',
                markerRect: makeRect(0, 0, 0.001, 0.001),
            });
            const right = makeSummary({
                source: 'pdf',
                annotationName: 'evb-markup:stable',
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
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
        });

        it('matches a reloaded PDF sticky note when the editor-side text is temporarily empty', () => {
            const left = makeSummary({
                source: 'editor',
                uid: 'pdfjs_internal_editor_0',
                text: '',
                modifiedAt: null,
                markerRect: makeRect(0.10, 0.10, 0.01, 0.01),
            });
            const right = makeSummary({
                source: 'pdf',
                annotationId: '3856R',
                text: 'note',
                modifiedAt: null,
                markerRect: makeRect(0.10, 0.10, 0.01, 0.01),
            });
            expect(likelyEditorPdfMirror(left, right)).toBe(true);
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

describe('areTextMarkupCommentsLikelySame', () => {
    it('does not merge overlapping highlight and underline comments', () => {
        const markerRect = makeRect(0.1, 0.1, 0.2, 0.05);
        const highlight = makeSummary({
            source: 'editor',
            hasNote: false,
            subtype: 'Highlight',
            markerRect,
        });
        const underline = makeSummary({
            source: 'editor',
            hasNote: false,
            subtype: 'Underline',
            markerRect,
        });

        expect(areTextMarkupCommentsLikelySame(highlight, underline)).toBe(false);
    });

    it('still merges same-subtype text markup comments with matching geometry', () => {
        const left = makeSummary({
            source: 'editor',
            hasNote: false,
            subtype: 'Underline',
            markerRect: makeRect(0.1, 0.1, 0.2, 0.05),
        });
        const right = makeSummary({
            source: 'pdf',
            hasNote: false,
            subtype: 'Underline',
            markerRect: makeRect(0.1, 0.1, 0.2, 0.05),
        });

        expect(areTextMarkupCommentsLikelySame(left, right)).toBe(true);
    });
});

describe('mergeCommentSummaries', () => {
    it('preserves PDF annotation names while merging mirrors', () => {
        const existing = makeSummary({
            source: 'editor',
            annotationName: null,
        });
        const incoming = makeSummary({
            source: 'pdf',
            annotationName: 'evb-markup:stable',
        });

        expect(mergeCommentSummaries(existing, incoming).annotationName).toBe('evb-markup:stable');
    });

    it('preserves selected-text previews when merging editor and PDF mirrors', () => {
        const existing = makeSummary({
            source: 'editor',
            text: '',
            previewText: 'Highlighted words',
            subtype: 'Highlight',
        });
        const incoming = makeSummary({
            source: 'pdf',
            text: '',
            previewText: null,
            subtype: 'Highlight',
        });

        expect(mergeCommentSummaries(existing, incoming).previewText).toBe('Highlighted words');
    });

    it('fills selected-text preview from the incoming summary when the existing summary has none', () => {
        const existing = makeSummary({
            source: 'editor',
            text: '',
            previewText: null,
            subtype: 'Highlight',
        });
        const incoming = makeSummary({
            source: 'pdf',
            text: '',
            previewText: 'Reloaded highlight text',
            subtype: 'Highlight',
        });

        expect(mergeCommentSummaries(existing, incoming).previewText).toBe('Reloaded highlight text');
    });

    it('carries selected display text from the incoming summary', () => {
        const existing = makeSummary({
            source: 'pdf',
            text: '',
            previewText: 'An Introduction to Koranic and d',
            subtype: 'Highlight',
        });
        const incoming = makeSummary({
            source: 'editor',
            text: '',
            displayText: 'An',
            previewText: 'An',
            subtype: 'Highlight',
        });

        expect(mergeCommentSummaries(existing, incoming).displayText).toBe('An');
    });

    it('uses incoming selected preview as display text for no-note text markup', () => {
        const existing = makeSummary({
            source: 'pdf',
            text: '',
            previewText: 'An Introduction to Koranic and d',
            subtype: 'Highlight',
        });
        const incoming = makeSummary({
            source: 'editor',
            text: '',
            previewText: 'An',
            subtype: 'Highlight',
        });

        expect(mergeCommentSummaries(existing, incoming).displayText).toBe('An');
    });

    it('trusts the PDF snapshot when a stale editor summary conflicts on text-markup subtype', () => {
        const existing = makeSummary({
            source: 'editor',
            subtype: 'Underline',
            color: '#22c55e',
            annotationId: '42R0',
        });
        const incoming = makeSummary({
            source: 'pdf',
            subtype: 'Highlight',
            color: '#eab308',
            annotationId: '42R0',
        });

        expect(mergeCommentSummaries(existing, incoming)).toMatchObject({
            subtype: 'Highlight',
            color: '#eab308',
        });
    });

    it('uses the PDF text-markup color when the editor mirror still has the default highlight color', () => {
        const existing = makeSummary({
            source: 'editor',
            subtype: 'Underline',
            color: '#ffd400',
            annotationId: '42R0',
        });
        const incoming = makeSummary({
            source: 'pdf',
            subtype: 'Underline',
            color: '#06b6d4',
            annotationId: '42R0',
        });

        expect(mergeCommentSummaries(existing, incoming).color).toBe('#06b6d4');
    });

    it('preserves a locally edited text-markup color over the next PDF mirror', () => {
        const existing = makeSummary({
            source: 'editor',
            subtype: 'Underline',
            color: '#ec4899',
            colorEdited: true,
            annotationId: '42R0',
        });
        const incoming = makeSummary({
            source: 'pdf',
            subtype: 'Underline',
            color: '#06b6d4',
            annotationId: '42R0',
        });

        expect(mergeCommentSummaries(existing, incoming).color).toBe('#ec4899');
    });
});

describe('deterministic annotation names', () => {
    it('make logical annotation matching exact before fuzzy geometry', () => {
        const left = makeSummary({
            pageIndex: 0,
            annotationName: 'evb-markup:stable',
            markerRect: makeRect(0.1, 0.1, 0.1, 0.1),
        });
        const right = makeSummary({
            pageIndex: 0,
            annotationName: 'evb-markup:stable',
            markerRect: makeRect(0.8, 0.8, 0.1, 0.1),
        });

        expect(commentsAreSameLogicalAnnotation(left, right)).toBe(true);
    });

    it('keep nm stable keys canonical after duplicate merging', () => {
        const merged = mergeDuplicateCommentSummary(
            makeSummary({
                source: 'editor',
                stableKey: 'src:editor:0:runtime-1',
                annotationName: null,
            }),
            makeSummary({
                source: 'pdf',
                stableKey: 'ann:0:42R',
                annotationId: '42R',
                annotationName: 'evb-markup:stable',
            }),
        );

        expect(merged.annotationName).toBe('evb-markup:stable');
        expect(merged.stableKey).toBe('nm:evb-markup:stable');
    });

    it('prefers nm-backed comments over object-ref-only comments', () => {
        const preferred = selectPreferredAnnotationComment(
            makeSummary({
                stableKey: 'ann:0:42R',
                annotationId: '42R',
            }),
            makeSummary({
                stableKey: 'nm:evb-markup:stable',
                annotationName: 'evb-markup:stable',
            }),
        );

        expect(preferred.stableKey).toBe('nm:evb-markup:stable');
    });
});

describe('useAnnotationIdentity memory', () => {
    it('hydrates a PDF text-markup summary with the remembered exact editor preview', () => {
        const identity = useAnnotationIdentity(ref([]));
        identity.rememberSummaryText(makeSummary({
            source: 'editor',
            stableKey: 'src:editor:0:runtime-1',
            text: '',
            displayText: null,
            previewText: 'An',
            subtype: 'Highlight',
            hasNote: false,
            markerRect: makeRect(0.10, 0.20, 0.03, 0.05),
            modifiedAt: 1_700_000_000_000,
        }));

        const hydrated = identity.hydrateSummaryFromMemory(makeSummary({
            source: 'pdf',
            stableKey: 'ann:0:42R',
            annotationId: '42R',
            text: '',
            displayText: null,
            previewText: 'An Introduction to Koranic and d',
            subtype: 'Highlight',
            hasNote: false,
            markerRect: makeRect(0.10, 0.20, 0.80, 0.05),
            modifiedAt: 1_700_000_000_000,
        }));

        expect(hydrated.displayText).toBe('An');
    });
});
