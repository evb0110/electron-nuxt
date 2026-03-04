import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    splitByQueryMatches,
    matchesCommentQuery,
} from '@app/utils/pdf-annotation-comments';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'comment-1',
        stableKey: 'stable-comment-1',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Sample note text',
        kindLabel: 'Inline Note',
        subtype: 'Text',
        author: null,
        modifiedAt: 1700000000000,
        color: null,
        uid: null,
        annotationId: null,
        source: 'pdf',
        ...overrides,
    };
}

describe('pdf-annotation-comments', () => {
    it('matches by explicit comment author', () => {
        const comment = createComment({author: 'Eugene'});

        expect(matchesCommentQuery(comment, 'eugene')).toBe(true);
    });

    it('matches by fallback author when comment author is missing', () => {
        const comment = createComment();

        expect(matchesCommentQuery(comment, 'eugene', 'Eugene')).toBe(true);
    });

    it('does not match missing author query without fallback', () => {
        const comment = createComment();

        expect(matchesCommentQuery(comment, 'eugene')).toBe(false);
    });

    it('splits text into highlighted and non-highlighted parts', () => {
        expect(splitByQueryMatches('Eugene Eugene', 'euge')).toEqual([
            {
                text: 'Euge',
                match: true,
            },
            {
                text: 'ne ',
                match: false,
            },
            {
                text: 'Euge',
                match: true,
            },
            {
                text: 'ne',
                match: false,
            },
        ]);
    });

    it('returns a single plain part when query is empty', () => {
        expect(splitByQueryMatches('Eugene', '')).toEqual([{
            text: 'Eugene',
            match: false,
        }]);
    });
});
