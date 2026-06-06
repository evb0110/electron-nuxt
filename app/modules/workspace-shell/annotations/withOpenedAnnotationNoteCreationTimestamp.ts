import type { IAnnotationCommentSummary } from '@app/types/annotations';

export function withOpenedAnnotationNoteCreationTimestamp(comment: IAnnotationCommentSummary) {
    if (comment.source !== 'editor' || comment.createdAt || comment.modifiedAt) {
        return comment;
    }
    return {
        ...comment,
        createdAt: Date.now(),
    };
}
