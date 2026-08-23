import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {annotationIdForSummary} from '@app/modules/pdf-viewer/public';
import {BrowserLogger} from '@app/utils/browserLogger';

/**
 * Note windows outlive the projection they were opened from, so a delete can
 * arrive for an annotation that is already gone. Report that miss instead of
 * dropping it, and never fall back to some other comment.
 */
export function deleteAnnotationById(
    comments: readonly IAnnotationCommentSummary[],
    annotationId: string,
    remove: (comment: IAnnotationCommentSummary) => Promise<unknown> | undefined,
) {
    const comment = comments.find(candidate => annotationIdForSummary(candidate) === annotationId);
    if (!comment) {
        BrowserLogger.warn('annotations', 'Delete annotation by id found no projected comment', {
            annotationId,
            commentCount: comments.length,
        });
        return false;
    }
    void remove(comment);
    return true;
}
