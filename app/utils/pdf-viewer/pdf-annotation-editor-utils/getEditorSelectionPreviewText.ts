import type { IPdfjsEditor } from '@app/types/pdfjs';

export function getEditorSelectionPreviewText(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return '';
    }

    const explicitText = editor.__evbSelectionText?.trim();
    if (explicitText) {
        return explicitText;
    }

    return editor.div?.getAttribute('aria-label')?.trim() ?? '';
}
