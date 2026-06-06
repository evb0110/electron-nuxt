import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';

function compareSummarySortOrder(a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) {
    return compareAnnotationCommentSummaries(a, b);
}

export function compareAnnotationComments(a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) {
    return compareSummarySortOrder(a, b);
}
