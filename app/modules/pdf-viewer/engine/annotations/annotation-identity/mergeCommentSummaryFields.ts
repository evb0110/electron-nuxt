import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';

function normalizeSubtypeForIdentity(subtype: IAnnotationCommentSummary['subtype']) {
    return (subtype ?? '').trim().toLowerCase();
}

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

export function mergeSortIndex(
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

function mergeModifiedAt(
    existing: Pick<IAnnotationCommentSummary, 'modifiedAt'>,
    incoming: Pick<IAnnotationCommentSummary, 'modifiedAt'>,
) {
    const existingTs = existing.modifiedAt ?? null;
    const incomingTs = incoming.modifiedAt ?? null;
    if (existingTs && incomingTs) {
        return Math.max(existingTs, incomingTs);
    }
    return existingTs ?? incomingTs;
}

function mergeCreatedAt(
    existing: Pick<IAnnotationCommentSummary, 'createdAt' | 'modifiedAt'>,
    incoming: Pick<IAnnotationCommentSummary, 'createdAt' | 'modifiedAt'>,
) {
    const existingTs = existing.createdAt ?? null;
    const incomingTs = incoming.createdAt ?? null;
    if (existingTs && incomingTs) {
        return Math.min(existingTs, incomingTs);
    }
    return existingTs ?? incomingTs;
}

function isSpecificSubtype(subtype: IAnnotationCommentSummary['subtype']) {
    return Boolean(subtype && subtype !== 'Highlight');
}

function mergeSpecificFirstField<T extends Pick<IAnnotationCommentSummary, 'subtype'>>(
    existing: T,
    incoming: T,
    select: (summary: T) => string | null | undefined,
) {
    const existingValue = select(existing);
    const incomingValue = select(incoming);
    if (existingValue && isSpecificSubtype(existing.subtype)) {
        return existingValue;
    }
    if (incomingValue && isSpecificSubtype(incoming.subtype)) {
        return incomingValue;
    }
    return existingValue ?? incomingValue;
}

function textMarkupSubtypesConflict(
    existing: Pick<IAnnotationCommentSummary, 'subtype'>,
    incoming: Pick<IAnnotationCommentSummary, 'subtype'>,
) {
    return (
        isTextMarkupSubtype(existing.subtype)
        && isTextMarkupSubtype(incoming.subtype)
        && normalizeSubtypeForIdentity(existing.subtype) !== normalizeSubtypeForIdentity(incoming.subtype)
    );
}

function selectTextMarkupConflictWinner(
    existing: IAnnotationCommentSummary,
    incoming: IAnnotationCommentSummary,
) {
    if (!textMarkupSubtypesConflict(existing, incoming)) {
        return null;
    }
    if (incoming.source === 'pdf') {
        return incoming;
    }
    if (existing.source === 'pdf') {
        return existing;
    }
    return incoming.modifiedAt && (!existing.modifiedAt || incoming.modifiedAt > existing.modifiedAt)
        ? incoming
        : existing;
}

function mergeSubtypeField(
    existing: IAnnotationCommentSummary,
    incoming: IAnnotationCommentSummary,
) {
    return selectTextMarkupConflictWinner(existing, incoming)?.subtype
        ?? mergeSpecificFirstField(existing, incoming, summary => summary.subtype ?? null);
}

function mergeColorField(
    existing: IAnnotationCommentSummary,
    incoming: IAnnotationCommentSummary,
) {
    if (existing.colorEdited && existing.color) {
        return existing.color;
    }
    if (incoming.colorEdited && incoming.color) {
        return incoming.color;
    }
    if (
        isTextMarkupSubtype(existing.subtype)
        && isTextMarkupSubtype(incoming.subtype)
        && existing.source === 'editor'
        && incoming.source === 'pdf'
        && incoming.color
    ) {
        return incoming.color;
    }
    return selectTextMarkupConflictWinner(existing, incoming)?.color
        ?? existing.color
        ?? incoming.color;
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

export function pickPreferredMarkerRect(
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

function getNoNoteTextMarkupDisplayText(summary: IAnnotationCommentSummary) {
    if (!isTextMarkupSubtype(summary.subtype) || summary.text.trim()) {
        return null;
    }
    return summary.displayText?.trim() ? summary.displayText : null;
}

function getNoNoteEditorTextMarkupPreviewText(summary: IAnnotationCommentSummary) {
    if (
        summary.source !== 'editor'
        || !isTextMarkupSubtype(summary.subtype)
        || summary.text.trim()
    ) {
        return null;
    }
    return summary.previewText?.trim() ? summary.previewText : null;
}

export function mergeCommentSummaryFields(
    existing: IAnnotationCommentSummary,
    incoming: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    const existingText = existing.text.trim();
    const text = existingText.length > 0 ? existing.text : incoming.text;
    const displayText = getNoNoteTextMarkupDisplayText(existing)
        ?? getNoNoteTextMarkupDisplayText(incoming)
        ?? getNoNoteEditorTextMarkupPreviewText(existing)
        ?? getNoNoteEditorTextMarkupPreviewText(incoming);
    const existingPreviewText = existing.previewText?.trim() ?? '';
    const previewText = existingPreviewText.length > 0
        ? existing.previewText
        : incoming.previewText;

    const author = existing.author?.trim() ? existing.author : incoming.author;

    const kindLabel = mergeSpecificFirstField(
        existing,
        incoming,
        summary => summary.kindLabel?.trim() ? summary.kindLabel : null,
    );

    const modifiedAt = mergeModifiedAt(existing, incoming);
    const createdAt = mergeCreatedAt(existing, incoming);

    const source = existing.source === 'editor' ? 'editor' : incoming.source;
    const sortIndex = mergeSortIndex(existing, incoming);
    const hasNote = existing.hasNote === true || incoming.hasNote === true;
    const subtype = mergeSubtypeField(existing, incoming);

    return {
        ...existing,
        text,
        displayText: displayText ?? null,
        previewText: previewText ?? null,
        author,
        kindLabel: kindLabel ?? null,
        createdAt,
        modifiedAt,
        sortIndex,
        annotationId: existing.annotationId ?? incoming.annotationId,
        annotationName: existing.annotationName ?? incoming.annotationName,
        uid: existing.uid ?? incoming.uid,
        subtype,
        color: mergeColorField(existing, incoming),
        colorEdited: existing.colorEdited === true || incoming.colorEdited === true,
        source,
        hasNote,
        markerRect: pickPreferredMarkerRect(existing, incoming),
    };
}
