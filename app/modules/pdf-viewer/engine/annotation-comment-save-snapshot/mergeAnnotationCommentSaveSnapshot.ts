import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { annotationCommentsMatch } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/annotationCommentsMatch';
import { selectPreferredAnnotationComment } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/selectPreferredAnnotationComment';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';

function commentsShareSaveIdentity(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (annotationCommentsMatch(left, right)) {
        return true;
    }
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }
    const leftAnnotationId = normalizePdfJsAnnotationId(left.annotationId);
    const rightAnnotationId = normalizePdfJsAnnotationId(right.annotationId);
    if (leftAnnotationId && rightAnnotationId && leftAnnotationId === rightAnnotationId) {
        return true;
    }
    if (left.uid && left.uid === right.uid) {
        return true;
    }
    return Boolean(
        left.id
        && left.id === right.id
        && left.source === right.source,
    );
}

function isLocalEditorNoteForSave(comment: IAnnotationCommentSummary) {
    return comment.source === 'editor'
        && !parsePdfJsAnnotationRef(comment.annotationId)
        && (
            comment.hasNote === true
            || comment.text.trim().length > 0
            || normalizeMarkerRect(comment.markerRect) !== null
        );
}

function mergeCommentForSave(
    existing: IAnnotationCommentSummary,
    candidate: IAnnotationCommentSummary,
) {
    const preferred = selectPreferredAnnotationComment(existing, candidate);
    const fallback = preferred === existing ? candidate : existing;
    const markerRect = normalizeMarkerRect(preferred.markerRect)
        ?? normalizeMarkerRect(fallback.markerRect);
    const preferredText = preferred.text.trim().length > 0
        ? preferred.text
        : fallback.text;

    return {
        ...preferred,
        text: preferredText,
        displayText: preferred.displayText ?? fallback.displayText ?? null,
        previewText: preferred.previewText ?? fallback.previewText ?? null,
        kindLabel: preferred.kindLabel ?? fallback.kindLabel ?? null,
        createdAt: preferred.createdAt ?? fallback.createdAt ?? null,
        modifiedAt: preferred.modifiedAt ?? fallback.modifiedAt ?? null,
        markerRect,
        hasNote: preferred.hasNote === true || fallback.hasNote === true,
    };
}

export function mergeAnnotationCommentSaveSnapshot(
    snapshotComments: IAnnotationCommentSummary[] | undefined,
    localComments: IAnnotationCommentSummary[],
) {
    if (!snapshotComments) {
        return localComments.map(comment => ({
            ...comment,
            markerRect: normalizeMarkerRect(comment.markerRect),
        }));
    }

    const merged = snapshotComments.map(comment => ({
        ...comment,
        markerRect: normalizeMarkerRect(comment.markerRect),
    }));
    for (const comment of localComments.filter(isLocalEditorNoteForSave)) {
        const normalizedComment = {
            ...comment,
            markerRect: normalizeMarkerRect(comment.markerRect),
        };
        const existingIndex = merged.findIndex(candidate =>
            commentsShareSaveIdentity(candidate, normalizedComment),
        );
        if (existingIndex === -1) {
            merged.push(normalizedComment);
            continue;
        }

        merged[existingIndex] = mergeCommentForSave(
            merged[existingIndex]!,
            normalizedComment,
        );
    }

    return merged.sort(compareAnnotationCommentSummaries);
}
