import type { Ref } from 'vue';
import type { usePdfAppAnnotationHistory } from '@app/composables/pdf/usePdfAppAnnotationHistory';
import type { usePdfViewerRuntime } from '@app/modules/pdf-viewer/runtime/usePdfViewerRuntime';
import type { usePdfViewerAnnotationRuntime } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime';
import type { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import {
    createPdfViewerPublicApi,
    type TPdfViewerPublicApiSource,
} from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerPublicApi';
import type { IScrollSnapshot } from '@app/types/pdf';
import type { IPdfViewerExpose } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';

interface IUsePdfViewerPublicApiControllerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    viewerRuntime: ReturnType<typeof usePdfViewerRuntime>;
    singlePageScroll: ReturnType<typeof usePdfSinglePageNavigationController>;
    cancelPendingSearchScroll: () => void;
    annotationRuntime: ReturnType<typeof usePdfViewerAnnotationRuntime>;
    appAnnotationHistory: ReturnType<typeof usePdfAppAnnotationHistory>;
    captureViewerScrollSnapshot: () => IScrollSnapshot | null;
    restoreViewerScrollSnapshot: NonNullable<IPdfViewerExpose['restoreScrollSnapshot']>;
    applyFitWidthToCurrentPage: NonNullable<IPdfViewerExpose['applyFitWidthToCurrentPage']>;
    waitForViewerLoadSettled: NonNullable<IPdfViewerExpose['waitForViewerLoadSettled']>;
    preserveNextSourceReloadVisibleContent: NonNullable<IPdfViewerExpose['preserveNextSourceReloadVisibleContent']>;
    saveViewerDocument: IPdfViewerExpose['saveDocument'];
    renderLoadedPdfPagesForBrowserPrint: NonNullable<IPdfViewerExpose['renderLoadedPdfPagesForBrowserPrint']>;
    undoAnnotation: IPdfViewerExpose['undoAnnotation'];
    redoAnnotation: IPdfViewerExpose['redoAnnotation'];
    startImagePlacement: IPdfViewerExpose['startImagePlacement'];
    clearPendingImagePlacement: IPdfViewerExpose['clearPendingImagePlacement'];
    restorePendingImagePlacement: IPdfViewerExpose['restorePendingImagePlacement'];
    invalidatePages: IPdfViewerExpose['invalidatePages'];
    captureRegionToClipboard: IPdfViewerExpose['captureRegionToClipboard'];
    isCapturingRegion: TPdfViewerPublicApiSource['isCapturingRegion'];
    startCropSelection: IPdfViewerExpose['startCropSelection'];
    cancelCropSelection: IPdfViewerExpose['cancelCropSelection'];
    isCropSelecting: TPdfViewerPublicApiSource['isCropSelecting'];
    requestScrollToCurrentResult: IPdfViewerExpose['requestScrollToCurrentResult'];
}

export function usePdfViewerPublicApiController(options: IUsePdfViewerPublicApiControllerOptions) {
    const {
        annotationRuntime,
        viewerRuntime,
    } = options;
    const {
        annotations,
        annotationCommentModel,
        annotationColorCommands,
        focusAnnotationComment,
        deleteAnnotationComment,
        shapeComposable,
        selectedShapeCommands,
        managedEmbeddedPdfShapes,
    } = annotationRuntime;
    const { currentPage } = viewerRuntime.scroll;

    return createPdfViewerPublicApi({
        getViewerContainer: () => options.viewerContainer.value,
        getCurrentPage: () => currentPage.value,
        scrollToPage: (pageNumber: number) => {
            options.cancelPendingSearchScroll();
            options.singlePageScroll.scrollToPage(pageNumber);
        },
        captureScrollSnapshot: options.captureViewerScrollSnapshot,
        restoreScrollSnapshot: options.restoreViewerScrollSnapshot,
        applyFitWidthToCurrentPage: options.applyFitWidthToCurrentPage,
        ensurePageMetricsInRange: viewerRuntime.document.ensurePageMetricsInRange,
        getPageMetricsSnapshot: () => viewerRuntime.document.pageMetrics.value.map(metric => ({ ...metric })),
        waitForViewerLoadSettled: options.waitForViewerLoadSettled,
        preserveNextSourceReloadVisibleContent: options.preserveNextSourceReloadVisibleContent,
        adoptPersistedManagedShapesOnNextImport: annotationRuntime.adoptPersistedManagedShapesOnNextImport,
        clearPendingManagedShapeImportAdoption: annotationRuntime.clearPendingManagedShapeImportAdoption,
        preparePersistedManagedShapesForSave: annotationRuntime.preparePersistedManagedShapesForSave,
        restorePreparedManagedShapesAfterFailedSave: annotationRuntime.restorePreparedManagedShapesAfterFailedSave,
        saveDocument: options.saveViewerDocument,
        clearAnnotationHistory: () => options.appAnnotationHistory.clear(),
        renderLoadedPdfPagesForBrowserPrint: options.renderLoadedPdfPagesForBrowserPrint,
        markSavedShapeState: shapeComposable.markSavedShapeState,
        highlightSelection: annotationRuntime.highlightComposable.highlightSelection,
        commentSelection: annotationRuntime.highlightComposable.commentSelection,
        commentAtPoint: annotationRuntime.highlightComposable.commentAtPoint,
        startCommentPlacement: annotationRuntime.highlightComposable.startCommentPlacement,
        cancelCommentPlacement: annotationRuntime.highlightComposable.cancelCommentPlacement,
        undoAnnotation: options.undoAnnotation,
        redoAnnotation: options.redoAnnotation,
        registerAnnotationHistoryCommand: annotationRuntime.registerShapeHistoryCommand,
        focusAnnotationComment,
        updateAnnotationComment: annotationRuntime.commentCrud.updateAnnotationComment,
        deleteAnnotationComment,
        getAnnotationCommentsSnapshot: annotationCommentModel.getSnapshot,
        getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
        getMarkupSubtypeHints: annotations.editor.getMarkupSubtypeHints,
        getSelectedTextMarkupAnnotationProperties: annotations.editor.markupSubtype.getSelectedTextMarkupAnnotationProperties,
        updateSelectedTextMarkupAnnotationColor: annotationColorCommands.updateSelectedTextMarkupAnnotationColor,
        updateTextMarkupAnnotationColor: annotationColorCommands.updateTextMarkupAnnotationColor,
        getAllShapes: shapeComposable.getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys,
        loadShapes: shapeComposable.loadShapes,
        clearShapes: shapeComposable.clearShapes,
        clearSelectedShape: selectedShapeCommands.clearSelectedShape,
        deleteSelectedShape: selectedShapeCommands.deleteSelectedShape,
        hasShapes: shapeComposable.hasShapes,
        selectedShapeId: shapeComposable.selectedShapeId,
        updateShape: selectedShapeCommands.updateShape,
        getSelectedShape: selectedShapeCommands.getSelectedShape,
        startImagePlacement: options.startImagePlacement,
        clearPendingImagePlacement: options.clearPendingImagePlacement,
        restorePendingImagePlacement: options.restorePendingImagePlacement,
        invalidatePages: options.invalidatePages,
        suppressAnnotationId: annotationRuntime.suppressAnnotationId,
        unsuppressAnnotationId: (annotationId: string) => {
            managedEmbeddedPdfShapes.unsuppressAnnotationId(annotationId);
            annotations.commentSync.unsuppressAnnotationId(annotationId);
        },
        suppressAnnotationStableKey: annotations.commentSync.suppressAnnotationStableKey,
        unsuppressAnnotationStableKey: annotations.commentSync.unsuppressAnnotationStableKey,
        removeAnnotationFromDom: annotationRuntime.removeAnnotationFromDom,
        removeAnnotationFromInternalCache: annotationCommentModel.removeFromInternalCache,
        restoreAnnotationToInternalCache: annotationCommentModel.restoreLocally,
        clearPendingMarkerMoves: annotationCommentModel.clearPendingMarkerMoves,
        captureRegionToClipboard: options.captureRegionToClipboard,
        isCapturingRegion: options.isCapturingRegion,
        startCropSelection: options.startCropSelection,
        cancelCropSelection: options.cancelCropSelection,
        isCropSelecting: options.isCropSelecting,
        requestScrollToCurrentResult: options.requestScrollToCurrentResult,
    });
}
