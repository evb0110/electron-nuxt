import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import { usePdfViewerFitWidthController } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewerFitWidthController';
import { usePdfViewerSavePrintController } from '@app/modules/pdf-viewer/runtime/usePdfViewerSavePrintController';
import type { usePdfViewerAnnotationRuntime } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { TPdfRerenderSource } from '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol';
import type {IAnnotationSaveVerificationOptions} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
interface IUsePdfViewerExposeControllersOptions {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    documentRevisionToken: ComputedRef<TDocumentRevisionToken | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationRuntime: ReturnType<typeof usePdfViewerAnnotationRuntime>;
    isLoading: Ref<boolean>;
    continuousScroll: ComputedRef<boolean>;
    fitMode: ComputedRef<TFitMode>;
    zoomMode: ComputedRef<TZoomMode>;
    zoom: ComputedRef<number>;
    effectiveScale: ComputedRef<number>;
    fitWidthScale: Ref<number>;
    viewMode: ComputedRef<TPdfViewMode>;
    numPages: Ref<number>;
    pageMetricsVersion: Ref<number>;
    visibleRange: Ref<IPageRange>;
    resolveHorizontalScrollClampForActiveSpread: () => { shouldLock: boolean } | null;
    syncHorizontalScrollForZoomMode: () => boolean;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    isFitWidthScaleCurrent: (container: HTMLElement | null) => boolean;
    cancelInFlightRenders: () => Promise<void> | void;
    reRenderAllVisiblePages: (
        getRange: () => IPageRange,
        options: {
            rerenderSource?: TPdfRerenderSource;
            renderBufferOverride?: number;
        },
    ) => Promise<void>;
    emitZoomMode: (mode: TZoomMode) => void;
}

export const usePdfViewerExposeControllers = (options: IUsePdfViewerExposeControllersOptions) => {
    const { applyFitWidthToCurrentPage } = usePdfViewerFitWidthController({
        viewerContainer: options.viewerContainer,
        pdfDocument: options.pdfDocument,
        isLoading: options.isLoading,
        continuousScroll: options.continuousScroll,
        fitMode: options.fitMode,
        zoomMode: options.zoomMode,
        zoom: options.zoom,
        effectiveScale: options.effectiveScale,
        fitWidthScale: options.fitWidthScale,
        viewMode: options.viewMode,
        currentPage: options.currentPage,
        numPages: options.numPages,
        pageMetricsVersion: options.pageMetricsVersion,
        visibleRange: options.visibleRange,
        computeFitWidthScale: options.computeFitWidthScale,
        isFitWidthScaleCurrent: options.isFitWidthScaleCurrent,
        syncHorizontalScrollForZoomMode: options.syncHorizontalScrollForZoomMode,
        cancelInFlightRenders: options.cancelInFlightRenders,
        reRenderAllVisiblePages: options.reRenderAllVisiblePages,
        emitZoomMode: options.emitZoomMode,
    });

    const {
        commitPdfEditorsForSave,
        materializePdfJsDocumentForInternalUse,
        runSaveTransaction,
        saveViewerDocument,
        renderLoadedPdfPagesForBrowserPrint,
    } = usePdfViewerSavePrintController({
        getPdfDocument: () => options.pdfDocument.value,
        getAnnotationUiManager: () => options.annotationUiManager.value,
        flushAnnotationMutationsForSave: options.annotationRuntime.annotationMutationService.flushForSave,
        getMarkupSubtypeOverrides: options.annotationRuntime.annotations.editor.getMarkupSubtypeOverrides,
        getMarkupSubtypeHints: options.annotationRuntime.annotations.editor.getMarkupSubtypeHints,
        getAllShapes: options.annotationRuntime.shapeComposable.getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds: options.annotationRuntime.shapeComposable.getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys: options.annotationRuntime.shapeComposable.getDeletedEmbeddedShapeStableKeys,
        ensureManagedShapeBaselineReady: options.annotationRuntime.ensureManagedShapeBaselineReady,
        prepareAnnotationSave: () => {
            const application = options.annotationRuntime.annotationApplication.value;
            const session = application.beginSave(options.documentRevisionToken.value);
            return {
                plan: session.plan,
                verify: (bytes: Uint8Array) => application.verifySaveBytes(session, bytes),
                verifyPath: (
                    path: string,
                    knownSize: number,
                    verificationOptions?: IAnnotationSaveVerificationOptions,
                ) => application.verifySavePath(
                    session,
                    path,
                    knownSize,
                    verificationOptions,
                ),
                assertCurrent: () => application.assertSaveCurrent(session),
                recordMaterializedIdentityBinding: binding => application.recordMaterializedIdentityBinding(
                    session,
                    binding.annotationId,
                    binding.pdfRef,
                ),
                commit: () => {
                    application.acknowledgeSave(session);
                },
            };
        },
    });

    return {
        applyFitWidthToCurrentPage,
        commitPdfEditorsForSave,
        materializePdfJsDocumentForInternalUse,
        runSaveTransaction,
        saveViewerDocument,
        renderLoadedPdfPagesForBrowserPrint,
    };
};
