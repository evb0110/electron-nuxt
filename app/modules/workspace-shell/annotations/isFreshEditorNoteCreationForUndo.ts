import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { isNoteEligibleComment } from '@app/utils/pdf-viewer/annotations/annotation-rules/isNoteEligibleComment';

const FRESH_NOTE_CREATION_UNDO_WINDOW_MS = 5_000;
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;

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
