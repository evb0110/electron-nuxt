import type { IPdfjsEditor } from '@app/types/pdfjs';

function getEditorComment(editor: IPdfjsEditor) {
    try {
        return editor.comment;
    } catch {
        return null;
    }
}

export function hasEditorCommentPayload(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return false;
    }
    const comment = getEditorComment(editor);
    if (typeof comment === 'string') {
        return comment.trim().length > 0;
    }
    if (comment && typeof comment === 'object') {
        const text = typeof comment.text === 'string'
            ? comment.text.trim()
            : '';
        const deleted = comment.deleted === true;
        return !deleted && text.length > 0;
    }
    return false;
}
