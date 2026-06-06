import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { toCanonicalStableKey } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/toCanonicalStableKey';

export function normalizeSummaryStableKey(
    summary: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    return {
        ...summary,
        stableKey: toCanonicalStableKey(summary),
    };
}
