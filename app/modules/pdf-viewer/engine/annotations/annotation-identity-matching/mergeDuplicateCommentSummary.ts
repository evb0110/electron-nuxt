import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { mergeCommentSummaries } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity-matching/mergeCommentSummaries';
import { normalizeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity-matching/normalizeSummaryStableKey';

function markerRectConfidenceScore(
    comment: Pick<IAnnotationCommentSummary, 'source' | 'modifiedAt'>,
    rect: {
        width: number;
        height: number
    },
) {
    let score = 0;
    if (comment.source === 'editor') {
        score += 4;
    }
    if (typeof comment.modifiedAt === 'number' && comment.modifiedAt > 0) {
        score += 2;
    }
    if (rect.width * rect.height > 0.00001) {
        score += 1;
    }
    return score;
}

function markerRectArea(rect: {
    width: number;
    height: number;
}) {
    return rect.width * rect.height;
}

function summarySortIndex(summary: Pick<IAnnotationCommentSummary, 'sortIndex'>) {
    return typeof summary.sortIndex === 'number' ? summary.sortIndex : null;
}

function mergeSortIndex(
    left: Pick<IAnnotationCommentSummary, 'sortIndex'>,
    right: Pick<IAnnotationCommentSummary, 'sortIndex'>,
) {
    const leftSortIndex = summarySortIndex(left);
    const rightSortIndex = summarySortIndex(right);
    return (
        leftSortIndex !== null && rightSortIndex !== null
            ? Math.min(leftSortIndex, rightSortIndex)
            : (leftSortIndex ?? rightSortIndex)
    );
}

function firstNonZero(values: number[]) {
    return values.find(value => value !== 0) ?? 0;
}

function preferredMarkerRectSide(
    left: Pick<IAnnotationCommentSummary, 'source' | 'modifiedAt'> & {rect: IAnnotationMarkerRect},
    right: Pick<IAnnotationCommentSummary, 'source' | 'modifiedAt'> & {rect: IAnnotationMarkerRect},
) {
    const sourceDelta = Number(right.source === 'editor') - Number(left.source === 'editor');
    const preferenceDelta = firstNonZero([
        markerRectConfidenceScore(right, right.rect) - markerRectConfidenceScore(left, left.rect),
        (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0),
        sourceDelta,
        markerRectArea(right.rect) - markerRectArea(left.rect),
    ]);
    return preferenceDelta > 0 ? 'right' : 'left';
}

function pickPreferredMarkerRect(
    left: Pick<IAnnotationCommentSummary, 'markerRect' | 'source' | 'modifiedAt'>,
    right: Pick<IAnnotationCommentSummary, 'markerRect' | 'source' | 'modifiedAt'>,
) {
    const leftRect = normalizeMarkerRect(left.markerRect);
    const rightRect = normalizeMarkerRect(right.markerRect);
    if (!leftRect) {
        return rightRect ?? null;
    }
    if (!rightRect) {
        return leftRect;
    }

    const preferredSide = preferredMarkerRectSide(
        {
            ...left,
            rect: leftRect,
        },
        {
            ...right,
            rect: rightRect,
        },
    );
    return preferredSide === 'right' ? rightRect : leftRect;
}

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
    const merged = mergeCommentSummaries(primary, secondary);
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
