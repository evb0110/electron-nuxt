import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import type {
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
import type { ISerializationPlan } from '@app/modules/pdf-viewer/serialization/serializationPlan';

interface IUsePdfViewerSavePrintControllerOptions {
    getPdfDocument: () => PDFDocumentProxy | null;
    getAnnotationUiManager: () => AnnotationEditorUIManager | null;
    flushAnnotationMutationsForSave?: () => Promise<unknown>;
    getMarkupSubtypeOverrides?: () => Map<string, TMarkupSubtype> | undefined;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
    getAllShapes?: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    prepareAnnotationSave?: () => {
        plan?: ISerializationPlan;
        verify(bytes: Uint8Array): Promise<void>;
        assertCurrent?(): Promise<void> | void;
        commit(): void;
    };
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
        commitPdfEditorsForSave,
        getPdfDocument: options.getPdfDocument,
        ...(options.getMarkupSubtypeOverrides ? {getMarkupSubtypeOverrides: options.getMarkupSubtypeOverrides} : {}),
        ...(options.getMarkupSubtypeHints ? {getMarkupSubtypeHints: options.getMarkupSubtypeHints} : {}),
        ...(options.getAllShapes ? {getAllShapes: options.getAllShapes} : {}),
        ...(options.getDeletedEmbeddedShapeAnnotationIds ? {getDeletedEmbeddedShapeAnnotationIds: options.getDeletedEmbeddedShapeAnnotationIds} : {}),
        ...(options.getDeletedEmbeddedShapeStableKeys ? {getDeletedEmbeddedShapeStableKeys: options.getDeletedEmbeddedShapeStableKeys} : {}),
        ...(options.prepareAnnotationSave ? {prepareAnnotationSave: options.prepareAnnotationSave} : {}),
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
