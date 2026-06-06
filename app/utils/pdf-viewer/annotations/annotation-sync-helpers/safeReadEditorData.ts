import type { IPdfjsEditor } from '@app/types/pdfjs';
import { BrowserLogger } from '@app/utils/browserLogger';

export function safeReadEditorData(editor: IPdfjsEditor): ReturnType<NonNullable<IPdfjsEditor['getData']>> {
    try {
        return editor.getData?.() ?? {};
    } catch (error) {
        BrowserLogger.debug(
            'annotations',
            'Failed to read annotation editor data payload',
            error,
        );
        return {};
    }
}
