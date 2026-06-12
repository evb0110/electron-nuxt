import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { isNoteEligibleComment } from '@app/modules/pdf-viewer/public';

const FRESH_NOTE_CREATION_UNDO_WINDOW_MS = 5_000;
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;

interface IPageAnnotationOpenNoteWindow {
    comment: IAnnotationCommentSummary;
    createdAtMs?: number | undefined;
    text?: string | undefined;
}

function normalizeNoteText(text: string) {
    return text.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim();
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
