import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { isPdfDocumentUsable } from '@app/utils/isPdfDocumentUsable';

interface ISavePdfDocumentWithCommittedEditorsOptions {
    pdfDocument: PDFDocumentProxy | null;
    annotationUiManager: AnnotationEditorUIManager | null;
    getCurrentPdfDocument?: () => PDFDocumentProxy | null;
    isPdfDocumentCurrent?: (pdfDocument: PDFDocumentProxy) => boolean;
}

interface ICommitPdfEditorsForSaveOptions {annotationUiManager: AnnotationEditorUIManager | null;}

async function waitForCommittedEditorsToSettle() {
    await nextTick();

    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        return;
    }

    await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                resolve();
            });
        });
    });
    await nextTick();
}

function isSaveTargetCurrent(
    options: ISavePdfDocumentWithCommittedEditorsOptions,
    pdfDocument: PDFDocumentProxy,
) {
    if (!isPdfDocumentUsable(pdfDocument)) {
        return false;
    }
    if (
        options.getCurrentPdfDocument
        && options.getCurrentPdfDocument() !== pdfDocument
    ) {
        return false;
    }
    return options.isPdfDocumentCurrent?.(pdfDocument) !== false;
}

export async function savePdfDocumentWithCommittedEditors(
    options: ISavePdfDocumentWithCommittedEditorsOptions,
) {
    const pdfDocument = options.pdfDocument;
    if (!pdfDocument || !isSaveTargetCurrent(options, pdfDocument)) {
        return null;
    }

    await commitPdfEditorsForSave(options);
    if (!isSaveTargetCurrent(options, pdfDocument)) {
        return null;
    }

    try {
        const savedBytes = await pdfDocument.saveDocument();
        if (!isSaveTargetCurrent(options, pdfDocument)) {
            return null;
        }
        return savedBytes;
    } catch (error) {
        if (!isSaveTargetCurrent(options, pdfDocument)) {
            return null;
        }
        throw error;
    }
}

export async function commitPdfEditorsForSave(
    options: ICommitPdfEditorsForSaveOptions,
) {
    options.annotationUiManager?.commitOrRemove();
    await waitForCommittedEditorsToSettle();
}
