import {
    describe,
    expect,
    it,
} from 'vitest';
import { annotationCommentEditScore } from '@app/composables/pdf/annotationCommentMatching';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: '',
        stableKey: 'stable',
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

describe('annotationCommentEditScore', () => {
    it('returns 0 for a bare pdf-source comment with no identifiers', () => {
        expect(annotationCommentEditScore(createComment())).toBe(0);
    });

    it('adds 8 for editor source', () => {
        const comment = createComment({source: 'editor'});
        expect(annotationCommentEditScore(comment)).toBe(8);
    });

    it('adds 6 for a uid', () => {
        const comment = createComment({uid: 'uid-1'});
        expect(annotationCommentEditScore(comment)).toBe(6);
    });

    it('adds 4 for an annotationId, 2 for an id, and 1 for a markerRect', () => {
        const annotationOnly = createComment({annotationId: 'ann-1'});
        expect(annotationCommentEditScore(annotationOnly)).toBe(4);

        const idOnly = createComment({id: 'id-1'});
        expect(annotationCommentEditScore(idOnly)).toBe(2);

        const markerOnly = createComment({markerRect: {
            left: 0,
            top: 0,
            width: 0.1,
            height: 0.1,
        }});
        expect(annotationCommentEditScore(markerOnly)).toBe(1);
    });

    it('sums all signals when present', () => {
        const comment = createComment({
            source: 'editor',
            uid: 'uid',
            annotationId: 'ann',
            id: 'i',
            markerRect: {
                left: 0,
                top: 0,
                width: 0.5,
                height: 0.5,
            },
        });
        expect(annotationCommentEditScore(comment)).toBe(8 + 6 + 4 + 2 + 1);
    });
});
