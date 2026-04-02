import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { PDFDocumentProxy } from '@app/types/pdf';

interface ISavePdfDocumentWithCommittedEditorsOptions {
    pdfDocument: PDFDocumentProxy | null;
    annotationUiManager: AnnotationEditorUIManager | null;
}

export async function savePdfDocumentWithCommittedEditors(
    options: ISavePdfDocumentWithCommittedEditorsOptions,
): Promise<Uint8Array | null> {
    if (!options.pdfDocument) {
        return null;
    }

    options.annotationUiManager?.commitOrRemove();
    await nextTick();
    return options.pdfDocument.saveDocument();
}
