import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { PDFDocumentProxy } from '@app/types/pdf';

interface ISavePdfDocumentWithCommittedEditorsOptions {
    pdfDocument: PDFDocumentProxy | null;
    annotationUiManager: AnnotationEditorUIManager | null;
}

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

export async function savePdfDocumentWithCommittedEditors(
    options: ISavePdfDocumentWithCommittedEditorsOptions,
): Promise<Uint8Array | null> {
    if (!options.pdfDocument) {
        return null;
    }

    options.annotationUiManager?.commitOrRemove();
    await waitForCommittedEditorsToSettle();
    return options.pdfDocument.saveDocument();
}
