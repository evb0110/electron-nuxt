import type { IPdfjsEditor } from '@app/types/pdfjs';
import { getPdfjsEditorFacadeState } from '@app/modules/pdf-viewer/engine/annotations/bridge/getPdfjsEditorFacadeState';

export function getEditorSelectionPreviewText(editor: IPdfjsEditor | null | undefined) {
    if (!editor) {
        return '';
    }

    const explicitText = getPdfjsEditorFacadeState(editor).selectionText?.trim();
    if (explicitText) {
        return explicitText;
    }

    return editor.div?.getAttribute('aria-label')?.trim() ?? '';
}
