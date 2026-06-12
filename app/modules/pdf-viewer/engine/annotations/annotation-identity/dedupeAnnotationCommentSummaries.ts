import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';
import { commentMergePriority } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/commentMergePriority';
import { commentsAreSameLogicalAnnotation } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/commentsAreSameLogicalAnnotation';
import { mergeDuplicateCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/mergeDuplicateCommentSummary';
import { normalizeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/normalizeSummaryStableKey';

export function dedupeAnnotationCommentSummaries(comments: IAnnotationCommentSummary[]) {
    const sorted = comments
        .map(comment => normalizeSummaryStableKey(comment))
        .sort((left, right) => {
            const priorityDelta = commentMergePriority(right) - commentMergePriority(left);
            if (priorityDelta !== 0) {
                return priorityDelta;
            }
            const leftTs = left.modifiedAt ?? 0;
            const rightTs = right.modifiedAt ?? 0;
            if (leftTs !== rightTs) {
                return rightTs - leftTs;
            }
            return left.stableKey.localeCompare(right.stableKey);
        });

    const merged: IAnnotationCommentSummary[] = [];
    for (const candidate of sorted) {
        const existingIndex = merged.findIndex(existing => commentsAreSameLogicalAnnotation(existing, candidate));
        if (existingIndex === -1) {
            merged.push(candidate);
            continue;
        }
        const primary = merged[existingIndex];
        if (!primary) {
            merged.push(candidate);
            continue;
        }
        merged[existingIndex] = mergeDuplicateCommentSummary(primary, candidate);
    }

    return merged.sort(compareAnnotationCommentSummaries);
}
