import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { annotationCommentsMatch } from '@app/utils/pdf-viewer/annotation-comment-matching/annotationCommentsMatch';
import { selectPreferredAnnotationComment } from '@app/utils/pdf-viewer/annotation-comment-matching/selectPreferredAnnotationComment';
import { isNoteEligibleComment } from '@app/utils/pdf-viewer/annotations/annotation-rules/isNoteEligibleComment';
import { markerRectCenterDistance } from '@app/utils/pdf-viewer/annotations/annotation-rules/markerRectCenterDistance';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';

export interface IWorkspaceOpenAnnotationNote {
    comment: IAnnotationCommentSummary;
    text?: string | undefined;
}

export interface IMergeWorkspaceAnnotationCommentsOptions {
    incomingComments: IAnnotationCommentSummary[];
    previousComments: IAnnotationCommentSummary[];
    openNotes: IWorkspaceOpenAnnotationNote[];
    isSameAnnotationComment?: (
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) => boolean;
}

function isTransientEditorOnlyNoteComment(comment: IAnnotationCommentSummary) {
    return comment.source === 'editor'
        && !comment.annotationId
        && isNoteEligibleComment(comment);
}

function commentsShareSourceIdentity(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }
    if (left.annotationId && left.annotationId === right.annotationId) {
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

function commentsShareNotePlacement(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    return left.pageIndex === right.pageIndex
        && isNoteEligibleComment(left)
        && isNoteEligibleComment(right)
        && markerRectCenterDistance(left.markerRect, right.markerRect) < 0.01;
}

function commentsRepresentSameWorkspaceAnnotation(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
    isSameAnnotationComment: IMergeWorkspaceAnnotationCommentsOptions['isSameAnnotationComment'],
) {
    return annotationCommentsMatch(left, right)
        || commentsShareSourceIdentity(left, right)
        || commentsShareNotePlacement(left, right)
        || Boolean(
            isNoteEligibleComment(left)
            && isNoteEligibleComment(right)
            && isSameAnnotationComment?.(left, right),
        );
}

function selectPreferredWorkspaceAnnotationComment(
    existing: IAnnotationCommentSummary,
    candidate: IAnnotationCommentSummary,
) {
    const existingIsNote = isNoteEligibleComment(existing);
    const candidateIsNote = isNoteEligibleComment(candidate);
    const preferred = candidateIsNote && !existingIsNote
        ? candidate
        : !candidateIsNote && existingIsNote
            ? existing
            : selectPreferredAnnotationComment(existing, candidate);
    const fallback = preferred === existing ? candidate : existing;

    return {
        ...preferred,
        createdAt: preferred.createdAt ?? fallback.createdAt ?? null,
        modifiedAt: preferred.modifiedAt ?? fallback.modifiedAt ?? null,
        displayText: preferred.displayText ?? fallback.displayText ?? null,
        previewText: preferred.previewText ?? fallback.previewText ?? null,
        kindLabel: preferred.kindLabel ?? fallback.kindLabel ?? null,
        markerRect: normalizeMarkerRect(preferred.markerRect)
            ?? normalizeMarkerRect(fallback.markerRect),
        ...(existingIsNote || candidateIsNote ? { hasNote: true } : {}),
    };
}

function toOpenNoteComment(note: IWorkspaceOpenAnnotationNote): IAnnotationCommentSummary {
    return {
        ...note.comment,
        text: typeof note.text === 'string' ? note.text : note.comment.text,
        hasNote: true,
    };
}

function upsertWorkspaceAnnotationComment(
    comments: IAnnotationCommentSummary[],
    candidate: IAnnotationCommentSummary,
    isSameAnnotationComment: IMergeWorkspaceAnnotationCommentsOptions['isSameAnnotationComment'],
) {
    const existingIndex = comments.findIndex(comment =>
        commentsRepresentSameWorkspaceAnnotation(comment, candidate, isSameAnnotationComment),
    );
    if (existingIndex === -1) {
        comments.push(candidate);
        return;
    }

    comments[existingIndex] = selectPreferredWorkspaceAnnotationComment(
        comments[existingIndex]!,
        candidate,
    );
}

export function mergeWorkspaceAnnotationComments(
    options: IMergeWorkspaceAnnotationCommentsOptions,
) {
    const merged = [...options.incomingComments];
    const carryForward = [
        ...options.previousComments.filter(isTransientEditorOnlyNoteComment),
        ...options.openNotes.map(toOpenNoteComment),
    ];

    for (const comment of carryForward) {
        if (!isNoteEligibleComment(comment)) {
            continue;
        }
        upsertWorkspaceAnnotationComment(merged, comment, options.isSameAnnotationComment);
    }

    return merged.sort(compareAnnotationCommentSummaries);
}
