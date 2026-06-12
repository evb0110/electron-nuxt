import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    mergeCommentSummaryFields,
    mergeSortIndex,
    pickPreferredMarkerRect,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/mergeCommentSummaryFields';
import { normalizeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/normalizeSummaryStableKey';

function selectDuplicateSummaryId(
    primary: IAnnotationCommentSummary,
    secondary: IAnnotationCommentSummary,
    merged: Pick<IAnnotationCommentSummary, 'id'>,
    annotationId: string | null,
    uid: string | null,
) {
    if (annotationId) {
        return primary.annotationId ? primary.id : secondary.id;
    }
    if (uid) {
        return primary.uid ? primary.id : secondary.id;
    }
    return merged.id;
}

export function mergeDuplicateCommentSummary(
    primary: IAnnotationCommentSummary,
    secondary: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    const merged = mergeCommentSummaryFields(primary, secondary);
    const annotationName = primary.annotationName ?? secondary.annotationName ?? null;
    const annotationId = primary.annotationId ?? secondary.annotationId ?? null;
    const uid = primary.uid ?? secondary.uid ?? null;
    const markerRect = pickPreferredMarkerRect(primary, secondary);
    const source: IAnnotationCommentSummary['source'] = (
        primary.source === 'editor' || secondary.source === 'editor'
            ? 'editor'
            : 'pdf'
    );
    const sortIndex = mergeSortIndex(primary, secondary);
    const id = selectDuplicateSummaryId(primary, secondary, merged, annotationId, uid);

    const normalized: IAnnotationCommentSummary = {
        ...merged,
        id,
        sortIndex,
        annotationName,
        annotationId,
        uid,
        source,
        markerRect,
    };
    return normalizeSummaryStableKey(normalized);
}
