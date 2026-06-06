import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { resolveCommentForDelete } from '@app/utils/pdf-viewer/annotations/annotation-delete-resolver/resolveCommentForDelete';
import { resolveStablePdfDeleteFallback } from '@app/utils/pdf-viewer/annotations/annotation-delete-resolver/resolveStablePdfDeleteFallback';

const identity = {
    resolveCommentFromCache: () => null,
    commentMergePriority: () => 0,
};

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'comment-1',
        stableKey: overrides.stableKey ?? 'editor:0:comment-1',
        sortIndex: overrides.sortIndex ?? null,
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? 'shared note',
        kindLabel: overrides.kindLabel ?? null,
        subtype: overrides.subtype ?? 'FreeText',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        uid: overrides.uid ?? 'comment-1',
        annotationId: overrides.annotationId ?? null,
        source: overrides.source ?? 'editor',
        hasNote: overrides.hasNote ?? true,
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.1,
            width: 0.1,
            height: 0.1,
        },
    };
}

describe('annotationDeleteResolver', () => {
    it('does not resolve an exact-text stable ref when marker geometry is far away', () => {
        const target = createComment({
            uid: null,
            annotationId: null,
            markerRect: {
                left: 0.1,
                top: 0.1,
                width: 0.08,
                height: 0.08,
            },
        });
        const farStableCandidate = createComment({
            id: 'pdf-1',
            stableKey: 'pdf:0:pdf-1',
            uid: null,
            annotationId: 'pdf-1',
            source: 'pdf',
            text: 'shared note',
            markerRect: {
                left: 0.75,
                top: 0.75,
                width: 0.08,
                height: 0.08,
            },
        });

        expect(resolveCommentForDelete({
            comment: target,
            candidates: [farStableCandidate],
            identity,
            findEditorForComment: vi.fn(() => null),
        })).toBeNull();
    });

    it('resolves an exact-text stable ref when marker geometry is nearby', () => {
        const target = createComment({
            uid: null,
            annotationId: null,
        });
        const nearbyStableCandidate = createComment({
            id: 'pdf-1',
            stableKey: 'pdf:0:pdf-1',
            uid: null,
            annotationId: 'pdf-1',
            source: 'pdf',
            text: 'shared note',
            markerRect: {
                left: 0.12,
                top: 0.11,
                width: 0.1,
                height: 0.1,
            },
        });

        expect(resolveCommentForDelete({
            comment: target,
            candidates: [nearbyStableCandidate],
            identity,
            findEditorForComment: vi.fn(() => null),
        })).toBe(nearbyStableCandidate);
    });

    it('does not use stable PDF fallback for far-away text matches', () => {
        const target = createComment({
            uid: null,
            annotationId: null,
        });
        const farStableCandidate = createComment({
            id: 'pdf-1',
            stableKey: 'pdf:0:pdf-1',
            uid: null,
            annotationId: 'pdf-1',
            source: 'pdf',
            text: 'shared note',
            markerRect: {
                left: 0.8,
                top: 0.1,
                width: 0.08,
                height: 0.08,
            },
        });

        expect(resolveStablePdfDeleteFallback({
            comment: target,
            candidates: [farStableCandidate],
            identity,
        })).toBeNull();
    });
});
