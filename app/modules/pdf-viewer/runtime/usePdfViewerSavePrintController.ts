import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import {
    commitPdfEditorsForSave as commitPdfEditorsForSaveBridge,
    savePdfDocumentWithCommittedEditors,
} from '@app/modules/pdf-viewer/engine/pdf-save-document/savePdfDocumentWithCommittedEditors';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import type {
    IPdfViewerConsumedPendingEmbeddedMutations,
    IPdfViewerPendingEmbeddedMutationSnapshot,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';

interface IUsePdfViewerSavePrintControllerOptions {
    getPdfDocument: () => PDFDocumentProxy | null;
    getAnnotationUiManager: () => AnnotationEditorUIManager | null;
    flushAnnotationMutationsForSave?: () => Promise<unknown>;
    consumePendingEmbeddedMutations?: () => IPdfViewerConsumedPendingEmbeddedMutations;
    getPendingEmbeddedMutationSnapshot?: () => IPdfViewerPendingEmbeddedMutationSnapshot;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    getMarkupSubtypeOverrides?: () => Map<string, TMarkupSubtype> | undefined;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
    getAllShapes?: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
}

export const usePdfViewerSavePrintController = (options: IUsePdfViewerSavePrintControllerOptions) => {
    async function materializePdfJsDocumentForInternalUse() {
        return savePdfDocumentWithCommittedEditors({
            pdfDocument: options.getPdfDocument(),
            annotationUiManager: options.getAnnotationUiManager(),
            getCurrentPdfDocument: options.getPdfDocument,
        });
    }

    async function saveViewerDocument() {
        return materializePdfJsDocumentForInternalUse();
    }

    async function commitPdfEditorsForSave() {
        await commitPdfEditorsForSaveBridge({annotationUiManager: options.getAnnotationUiManager()});
    }

    const { runSaveTransaction } = usePdfViewerSaveTransaction({
        materializePdfJsDocumentForInternalUse,
        ...(options.flushAnnotationMutationsForSave ? {flushAnnotationMutationsForSave: options.flushAnnotationMutationsForSave} : {}),
        ...(options.consumePendingEmbeddedMutations ? {consumePendingEmbeddedMutations: options.consumePendingEmbeddedMutations} : {}),
        ...(options.getPendingEmbeddedMutationSnapshot ? {getPendingEmbeddedMutationSnapshot: options.getPendingEmbeddedMutationSnapshot} : {}),
        commitPdfEditorsForSave,
        getPdfDocument: options.getPdfDocument,
        ...(options.getAnnotationCommentsSnapshot ? {getAnnotationCommentsSnapshot: options.getAnnotationCommentsSnapshot} : {}),
        ...(options.getMarkupSubtypeOverrides ? {getMarkupSubtypeOverrides: options.getMarkupSubtypeOverrides} : {}),
        ...(options.getMarkupSubtypeHints ? {getMarkupSubtypeHints: options.getMarkupSubtypeHints} : {}),
        ...(options.getAllShapes ? {getAllShapes: options.getAllShapes} : {}),
        ...(options.getDeletedEmbeddedShapeAnnotationIds ? {getDeletedEmbeddedShapeAnnotationIds: options.getDeletedEmbeddedShapeAnnotationIds} : {}),
        ...(options.getDeletedEmbeddedShapeStableKeys ? {getDeletedEmbeddedShapeStableKeys: options.getDeletedEmbeddedShapeStableKeys} : {}),
    });

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
        commitPdfEditorsForSave,
        materializePdfJsDocumentForInternalUse,
        runSaveTransaction,
        saveViewerDocument,
        renderLoadedPdfPagesForBrowserPrint,
    };
};
