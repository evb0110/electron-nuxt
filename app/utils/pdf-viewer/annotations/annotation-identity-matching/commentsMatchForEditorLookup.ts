import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { annotationCommentsMatch } from '@app/utils/pdf-viewer/annotation-comment-matching/annotationCommentsMatch';

export function commentsMatchForEditorLookup(
    left: Pick<IAnnotationCommentSummary, 'stableKey' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'>,
    right: Pick<IAnnotationCommentSummary, 'stableKey' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'>,
) {
    return annotationCommentsMatch(left, right);
}
