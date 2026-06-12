import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { computeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/computeSummaryStableKey';

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
