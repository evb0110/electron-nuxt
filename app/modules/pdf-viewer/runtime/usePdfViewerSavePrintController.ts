import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import { savePdfDocumentWithCommittedEditors } from '@app/modules/pdf-viewer/engine/pdf-save-document/savePdfDocumentWithCommittedEditors';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';

interface IUsePdfViewerSavePrintControllerOptions {
    getPdfDocument: () => PDFDocumentProxy | null;
    getAnnotationUiManager: () => AnnotationEditorUIManager | null;
}

export const usePdfViewerSavePrintController = (options: IUsePdfViewerSavePrintControllerOptions) => {
    async function saveViewerDocument() {
        return savePdfDocumentWithCommittedEditors({
            pdfDocument: options.getPdfDocument(),
            annotationUiManager: options.getAnnotationUiManager(),
            getCurrentPdfDocument: options.getPdfDocument,
        });
    }

    async function renderLoadedPdfPagesForBrowserPrint(
        targetDocument: IBrowserPrintDocument,
        pageNumbers: number[],
        renderOptions?: { signal?: AbortSignal },
    ) {
        const pdfDocument = options.getPdfDocument();
        if (!pdfDocument) {
            throw new Error('Missing loaded PDF document');
        }

        const { renderPdfDocumentPagesForBrowserPrint } = await import('@app/utils/pdfPrint');
        await renderPdfDocumentPagesForBrowserPrint(
            targetDocument,
            pdfDocument,
            pageNumbers,
            renderOptions,
        );
    }

    return {
        saveViewerDocument,
        renderLoadedPdfPagesForBrowserPrint,
    };
};
