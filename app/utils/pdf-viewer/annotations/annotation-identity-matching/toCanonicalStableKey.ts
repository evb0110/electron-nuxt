import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { computeSummaryStableKey } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/computeSummaryStableKey';

export function toCanonicalStableKey(
    summary: Pick<IAnnotationCommentSummary, 'id' | 'pageIndex' | 'source' | 'uid' | 'annotationId' | 'annotationName'>,
) {
    return computeSummaryStableKey({
        id: summary.id,
        pageIndex: summary.pageIndex,
        source: summary.source,
        uid: summary.uid,
        annotationId: summary.annotationId,
        annotationName: summary.annotationName,
    });
}
