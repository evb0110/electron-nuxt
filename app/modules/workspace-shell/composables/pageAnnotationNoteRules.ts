import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    isNoteEligibleComment,
    markerRectCenterDistance,
} from '@app/composables/pdf/annotations/annotationRules';

const FRESH_NOTE_CREATION_UNDO_WINDOW_MS = 5_000;
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;

export interface IPageAnnotationOpenNoteWindow {
    comment: IAnnotationCommentSummary;
    createdAtMs?: number | undefined;
    text?: string | undefined;
}

export function withOpenedAnnotationNoteCreationTimestamp(comment: IAnnotationCommentSummary) {
    if (comment.source !== 'editor' || comment.createdAt || comment.modifiedAt) {
        return comment;
    }
    return {
        ...comment,
        createdAt: Date.now(),
    };
}

export function getAnnotationPageNumber(comment: IAnnotationCommentSummary) {
    const pageNumber = Number.isFinite(comment.pageNumber)
        ? comment.pageNumber
        : comment.pageIndex + 1;
    return Math.max(1, Math.round(pageNumber));
}

function normalizeNoteText(text: string) {
    return text.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim();
}

export function isFreshEditorNoteCreationForUndo(
    originalComment: IAnnotationCommentSummary,
    noteComment: IAnnotationCommentSummary,
    wasAlreadyOpen: boolean,
) {
    if (
        wasAlreadyOpen
        || originalComment.source !== 'editor'
        || noteComment.source !== 'editor'
        || !isNoteEligibleComment(noteComment)
        || normalizeNoteText(noteComment.text).length > 0
    ) {
        return false;
    }

    const timestamp = noteComment.createdAt ?? noteComment.modifiedAt;
    return typeof timestamp === 'number'
        && Number.isFinite(timestamp)
        && Math.abs(Date.now() - timestamp) <= FRESH_NOTE_CREATION_UNDO_WINDOW_MS;
}

export function isUndoableFreshEmptyEditorNote(note: IPageAnnotationOpenNoteWindow) {
    const { comment } = note;
    const noteText = typeof note.text === 'string' ? note.text : comment.text;
    if (
        comment.source !== 'editor'
        || !isNoteEligibleComment(comment)
        || normalizeNoteText(noteText).length > 0
    ) {
        return false;
    }

    const timestamp = comment.createdAt ?? comment.modifiedAt ?? note.createdAtMs;
    return (
        typeof timestamp !== 'number'
        || !Number.isFinite(timestamp)
        || Math.abs(Date.now() - timestamp) <= FRESH_NOTE_CREATION_UNDO_WINDOW_MS
    );
}

export function commentsShareDeleteTarget(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
    isSameAnnotationComment: (a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) => boolean,
) {
    if (left.stableKey && left.stableKey === right.stableKey) {
        return true;
    }
    if (isSameAnnotationComment(left, right)) {
        return true;
    }
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }
    if (left.annotationId && left.annotationId === right.annotationId) {
        return true;
    }
    if (left.uid && left.uid === right.uid) {
        return true;
    }
    if (left.id && left.id === right.id && left.source === right.source) {
        return true;
    }
    if (!isNoteEligibleComment(left) || !isNoteEligibleComment(right)) {
        return false;
    }

    const leftText = normalizeNoteText(left.text);
    const rightText = normalizeNoteText(right.text);
    const sameText = leftText.length > 0 && leftText === rightText;
    const closePlacement = markerRectCenterDistance(left.markerRect, right.markerRect) < 0.035;
    const oneHasStableEditorRef = Boolean(left.annotationId || left.uid) !== Boolean(right.annotationId || right.uid);
    return (
        sameText && (closePlacement || oneHasStableEditorRef)
    ) || (
        closePlacement && oneHasStableEditorRef
    );
}
