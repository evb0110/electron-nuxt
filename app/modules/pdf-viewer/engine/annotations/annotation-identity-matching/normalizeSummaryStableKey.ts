import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { toCanonicalStableKey } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity-matching/toCanonicalStableKey';

export function normalizeSummaryStableKey(
    summary: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    return {
        ...summary,
        stableKey: toCanonicalStableKey(summary),
    };
}
