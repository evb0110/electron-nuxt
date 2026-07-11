import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {annotationIdForSummary} from '@app/modules/pdf-viewer/public';

export function deleteAnnotationById(
    comments: readonly IAnnotationCommentSummary[],
    annotationId: string,
    remove: (comment: IAnnotationCommentSummary) => Promise<unknown> | undefined,
) {
    const comment = comments.find(candidate => annotationIdForSummary(candidate) === annotationId);
    if (comment) void remove(comment);
}
