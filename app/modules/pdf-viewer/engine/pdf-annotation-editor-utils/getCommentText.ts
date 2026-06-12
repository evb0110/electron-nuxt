import type { IPdfjsEditor } from '@app/types/pdfjs';

function getEditorComment(editor: IPdfjsEditor) {
    try {
        return editor.comment;
    } catch {
        return null;
    }
}

export function getCommentText(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return '';
    }
    const comment = getEditorComment(editor);
    if (typeof comment === 'string') {
        return comment;
    }
    if (comment && typeof comment.text === 'string') {
        return comment.text;
    }
    return '';
}
