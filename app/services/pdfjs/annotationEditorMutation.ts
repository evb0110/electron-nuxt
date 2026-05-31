import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { delay } from 'es-toolkit/promise';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { setSelectedEditor } from '@app/services/pdfjs/annotationEditorAdapter';

const ANNOTATION_EDITOR_RENDER_WAIT_TIMEOUT_MS = 1_500;

export function writeEditorCommentToAnnotationStorage(editor: IPdfjsEditor, text: string) {
    // PDF.js private editor comment field is the only writable note payload surface.
    editor.comment = text;
    // PDF.js private storage sync persists the editor mutation into annotationStorage.
    editor.addToAnnotationStorage?.();
}

export function getStoredAnnotationEditor(
    pdfDocument: PDFDocumentProxy | null,
    annotationElementId: string,
) {
    // PDF.js private annotationStorage.getEditor bridges persisted popup annotations to live editors.
    const annotationStorage = pdfDocument?.annotationStorage as
        | { getEditor?: (annotationElementId: string) => IPdfjsEditor | null }
        | undefined;
    return annotationStorage?.getEditor?.(annotationElementId) ?? null;
}

export function deleteEditorWithUiManager(
    uiManager: AnnotationEditorUIManager,
    editor: IPdfjsEditor | null,
    options: {
        alreadyDeleted?: boolean;
        logDebug: (message: string, error: unknown) => void;
    },
) {
    let deleted = options.alreadyDeleted ?? false;

    try {
        if (!deleted && editor) {
            setSelectedEditor(uiManager, editor);
            // PDF.js private uiManager.delete removes the selected annotation editor.
            uiManager.delete();
            deleted = true;
        }
    }
    catch (deleteError) {
        options.logDebug('uiManager.delete failed for annotation comment', deleteError);
        try {
            // PDF.js private editor.remove is the modern direct removal fallback.
            editor?.remove?.();
            deleted = true;
        }
        catch (removeError) {
            options.logDebug('editor.remove failed for annotation comment', removeError);
            try {
                // PDF.js private editor.delete is retained for older bundled editor implementations.
                editor?.delete?.();
                deleted = true;
            }
            catch (legacyDeleteError) {
                options.logDebug('editor.delete fallback failed for annotation comment', legacyDeleteError);
                deleted = false;
            }
        }
    }

    return deleted;
}

export function deleteSelectedEditorWithUiManager(
    uiManager: AnnotationEditorUIManager,
    logDebug: (message: string, error: unknown) => void,
) {
    try {
        // PDF.js private uiManager.delete removes the currently selected annotation editor/comment.
        uiManager.delete();
        return true;
    } catch (selectionDeleteError) {
        logDebug('uiManager.delete failed for selected comment fallback', selectionDeleteError);
        return false;
    }
}

export function getAnnotationEditorMode(uiManager: AnnotationEditorUIManager) {
    // PDF.js private uiManager.getMode is used to restore the active editor tool after mutations.
    return uiManager.getMode();
}

export async function waitForAnnotationEditorsRendered(
    uiManager: AnnotationEditorUIManager,
    pageNumber: number,
) {
    const timeoutController = new AbortController();

    // PDF.js private waitForEditorsRendered gates mutations until editor layers exist.
    try {
        await Promise.race([
            uiManager.waitForEditorsRendered(pageNumber),
            delay(ANNOTATION_EDITOR_RENDER_WAIT_TIMEOUT_MS, { signal: timeoutController.signal }).then(() => {
                throw new Error(`Timed out waiting for annotation editors on page ${pageNumber}`);
            }),
        ]);
    } finally {
        timeoutController.abort();
    }
}
