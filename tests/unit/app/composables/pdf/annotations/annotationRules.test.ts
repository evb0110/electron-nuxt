import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    compareAnnotations,
    isNoteEligible,
    isSelectionInteractionTool,
} from '@app/composables/pdf/annotations/annotationRules';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'id',
        stableKey: 'key',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'pdf',
        ...overrides,
    };
}

describe('isNoteEligible', () => {
    it('returns true when hasNote is explicitly true regardless of subtype', () => {
        expect(isNoteEligible('highlight', true)).toBe(true);
        expect(isNoteEligible(null, true)).toBe(true);
    });

    it('returns true for note-like subtypes', () => {
        expect(isNoteEligible('Text')).toBe(true);
        expect(isNoteEligible('FreeText')).toBe(true);
        expect(isNoteEligible('typewriter')).toBe(true);
        expect(isNoteEligible('note-linked')).toBe(true);
        expect(isNoteEligible('note-inline')).toBe(true);
    });

    it('matches subtype substrings for popup and note', () => {
        expect(isNoteEligible('SomethingPopup')).toBe(true);
        expect(isNoteEligible('SomeNoteThing')).toBe(true);
    });

    it('returns false for non-note subtypes when no other signals are provided', () => {
        expect(isNoteEligible('highlight')).toBe(false);
        expect(isNoteEligible('underline')).toBe(false);
        expect(isNoteEligible(null)).toBe(false);
        expect(isNoteEligible(undefined)).toBe(false);
    });

    it('returns true when source is editor and text has non-empty content', () => {
        expect(isNoteEligible('highlight', false, 'editor', 'hello')).toBe(true);
    });

    it('returns false when source is editor but text is whitespace-only', () => {
        expect(isNoteEligible('highlight', false, 'editor', '   ')).toBe(false);
    });

    it('returns false when source is pdf even with non-empty text', () => {
        expect(isNoteEligible('highlight', false, 'pdf', 'hello')).toBe(false);
    });
});

describe('compareAnnotations', () => {
    it('returns negative when left has a smaller pageIndex', () => {
        const left = createComment({pageIndex: 0});
        const right = createComment({pageIndex: 5});
        expect(compareAnnotations(left, right)).toBeLessThan(0);
    });

    it('returns positive when left has a larger pageIndex', () => {
        const left = createComment({pageIndex: 7});
        const right = createComment({pageIndex: 2});
        expect(compareAnnotations(left, right)).toBeGreaterThan(0);
    });

    it('orders by sortIndex when pageIndex matches', () => {
        const left = createComment({
            pageIndex: 1,
            sortIndex: 1,
        });
        const right = createComment({
            pageIndex: 1,
            sortIndex: 5,
        });
        expect(compareAnnotations(left, right)).toBeLessThan(0);
    });

    it('orders by creation time before source-local sort indexes', () => {
        const older = createComment({
            pageIndex: 1,
            sortIndex: 5,
            createdAt: 100,
            modifiedAt: 100,
        });
        const newer = createComment({
            pageIndex: 1,
            sortIndex: 1,
            createdAt: 200,
            modifiedAt: 200,
        });
        expect(compareAnnotations(older, newer)).toBeLessThan(0);
    });

    it('treats a comment with sortIndex as preceding one without', () => {
        const left = createComment({
            pageIndex: 1,
            sortIndex: 3,
        });
        const right = createComment({
            pageIndex: 1,
            sortIndex: null,
        });
        expect(compareAnnotations(left, right)).toBe(-1);
        expect(compareAnnotations(right, left)).toBe(1);
    });

    it('does not reorder undated annotations by edit time', () => {
        const left = createComment({
            pageIndex: 0,
            sortIndex: 1,
            modifiedAt: 100,
        });
        const right = createComment({
            pageIndex: 0,
            sortIndex: 0,
            modifiedAt: 200,
        });
        expect(compareAnnotations(left, right)).toBeGreaterThan(0);
    });

    it('keeps creation order stable when a note is edited later', () => {
        const createdFirstEditedLater = createComment({
            pageIndex: 0,
            createdAt: 100,
            modifiedAt: 1_000,
        });
        const createdSecond = createComment({
            pageIndex: 0,
            stableKey: 'second',
            createdAt: 200,
            modifiedAt: 200,
        });

        expect(compareAnnotations(createdFirstEditedLater, createdSecond)).toBeLessThan(0);
    });

    it('keeps undated legacy annotations before dated additions on the same page', () => {
        const legacy = createComment({
            pageIndex: 0,
            sortIndex: 10,
        });
        const addedLater = createComment({
            pageIndex: 0,
            sortIndex: 0,
            createdAt: 200,
            modifiedAt: 200,
        });
        expect(compareAnnotations(legacy, addedLater)).toBeLessThan(0);
    });

    it('falls back to stableKey comparison when all other fields match', () => {
        const left = createComment({
            pageIndex: 0,
            stableKey: 'a',
        });
        const right = createComment({
            pageIndex: 0,
            stableKey: 'b',
        });
        expect(compareAnnotations(left, right)).toBeLessThan(0);
        expect(compareAnnotations(right, left)).toBeGreaterThan(0);
    });
});

describe('isSelectionInteractionTool', () => {
    it('returns true only for the select tool', () => {
        expect(isSelectionInteractionTool('select')).toBe(true);
    });

    it('returns false for other authoring tools', () => {
        expect(isSelectionInteractionTool('highlight')).toBe(false);
        expect(isSelectionInteractionTool('underline')).toBe(false);
        expect(isSelectionInteractionTool('strikethrough')).toBe(false);
        expect(isSelectionInteractionTool('draw')).toBe(false);
        expect(isSelectionInteractionTool('rectangle')).toBe(false);
        expect(isSelectionInteractionTool('text')).toBe(false);
    });

    it('returns false for the none tool', () => {
        expect(isSelectionInteractionTool('none')).toBe(false);
    });

    it('returns false for stamp', () => {
        expect(isSelectionInteractionTool('stamp')).toBe(false);
    });
});
