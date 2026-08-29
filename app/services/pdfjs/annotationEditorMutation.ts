import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { delay } from 'es-toolkit/promise';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    getAnnotationStorageEditor,
    setSelectedEditor,
    writeAnnotationStorageEditorComment,
} from '@app/services/pdfjs/annotationEditorAdapter';

const ANNOTATION_EDITOR_RENDER_WAIT_TIMEOUT_MS = 1_500;

export function writeEditorCommentToAnnotationStorage(editor: IPdfjsEditor, text: string) {
    writeAnnotationStorageEditorComment(editor, text);
}

export function getStoredAnnotationEditor(
    pdfDocument: PDFDocumentProxy | null,
    annotationElementId: string,
) {
    return getAnnotationStorageEditor(pdfDocument, annotationElementId);
}

function editorAttachmentState(editor: IPdfjsEditor): boolean | null {
    const isAttachedToDOM: unknown = Reflect.get(editor, 'isAttachedToDOM');
    if (typeof isAttachedToDOM === 'boolean') {
        return isAttachedToDOM;
    }

    const parent: unknown = Reflect.get(editor, 'parent');
    if (parent !== undefined) {
        return parent !== null;
    }

    const div = editor.div;
    if (div) {
        return div.isConnected;
    }

    return null;
}

function removeEditorWithFallback(
    editor: IPdfjsEditor,
    logDebug: (message: string, error: unknown) => void,
) {
    let removeAttempted = false;
    try {
        const remove = editor.remove;
        if (typeof remove === 'function') {
            removeAttempted = true;
            remove.call(editor);
        }
        if (removeAttempted && editorAttachmentState(editor) !== true) {
            return true;
        }
    }
    catch (removeError) {
        logDebug('editor.remove failed for annotation comment', removeError);
    }

    let deleteAttempted = false;
    try {
        const deleteMethod = editor.delete;
        if (typeof deleteMethod === 'function') {
            deleteAttempted = true;
            deleteMethod.call(editor);
        }
        if (deleteAttempted && editorAttachmentState(editor) !== true) {
            return true;
        }
    }
    catch (legacyDeleteError) {
        logDebug('editor.delete fallback failed for annotation comment', legacyDeleteError);
    }

    return (removeAttempted || deleteAttempted) && editorAttachmentState(editor) !== true;
}

function selectedEditorState(uiManager: AnnotationEditorUIManager): boolean | null {
    const hasSelection: unknown = Reflect.get(uiManager, 'hasSelection');
    return typeof hasSelection === 'boolean' ? hasSelection : null;
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
            // PDF.js delete() starts by committing the active editor. Do that
            // before selecting the deletion target, otherwise the commit can
            // clear the new selection and make delete() a silent no-op.
            const commitOrRemove = Reflect.get(uiManager, 'commitOrRemove');
            if (typeof commitOrRemove === 'function') {
                commitOrRemove.call(uiManager);
            }
            const selected = setSelectedEditor(uiManager, editor);
            if (selected) {
                // PDF.js private uiManager.delete removes the selected annotation editor.
                uiManager.delete();
                deleted = editorAttachmentState(editor) !== true;
            }
            if (!deleted) {
                // Some bundled PDF.js managers can return normally without deleting when
                // selection was lost during commit. Never report a canonical tombstone
                // while the live editor is still attached.
                deleted = removeEditorWithFallback(editor, options.logDebug);
            }
        }
    }
    catch (deleteError) {
        options.logDebug('uiManager.delete failed for annotation comment', deleteError);
        deleted = editor ? removeEditorWithFallback(editor, options.logDebug) : false;
    }

    return deleted;
}

export function deleteSelectedEditorWithUiManager(
    uiManager: AnnotationEditorUIManager,
    logDebug: (message: string, error: unknown) => void,
) {
    try {
        if (selectedEditorState(uiManager) === false) {
            return false;
        }
        // PDF.js private uiManager.delete removes the currently selected annotation editor/comment.
        uiManager.delete();
        return selectedEditorState(uiManager) !== true;
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
