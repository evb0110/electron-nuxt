import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';

export function compareAnnotations(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    return compareAnnotationCommentSummaries(left, right);
}
