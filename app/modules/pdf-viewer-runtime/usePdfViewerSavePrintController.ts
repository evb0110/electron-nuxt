import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import { savePdfDocumentWithCommittedEditors } from '@app/composables/pdf/pdfSaveDocument';
import {
    renderPdfDocumentPagesForBrowserPrint,
    type IBrowserPrintDocument,
} from '@app/utils/pdfPrint';

interface IUsePdfViewerSavePrintControllerOptions {
    getPdfDocument: () => PDFDocumentProxy | null;
    getAnnotationUiManager: () => AnnotationEditorUIManager | null;
}

export function usePdfViewerSavePrintController(options: IUsePdfViewerSavePrintControllerOptions) {
    async function saveViewerDocument() {
        return savePdfDocumentWithCommittedEditors({
            pdfDocument: options.getPdfDocument(),
            annotationUiManager: options.getAnnotationUiManager(),
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
}
