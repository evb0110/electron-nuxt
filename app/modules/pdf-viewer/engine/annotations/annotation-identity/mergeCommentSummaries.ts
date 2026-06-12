import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { mergeCommentSummaryFields } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/mergeCommentSummaryFields';

export function mergeCommentSummaries(
    existing: IAnnotationCommentSummary,
    incoming: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    return mergeCommentSummaryFields(existing, incoming);
}
