import type { Ref } from 'vue';
import type { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import type { usePdfViewerRuntime } from '@app/modules/pdf-viewer/runtime/usePdfViewerRuntime';
import type { usePdfViewerAnnotationRuntime } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime';
import type { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { createPdfViewerPublicApi } from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerPublicApi';
import type { TPdfViewerPublicApiSource } from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerPublicApi';
import type { IScrollSnapshot } from '@app/types/pdf';
import type { IPdfViewerExpose } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { toShapeAnnotationCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';

interface IUsePdfViewerPublicApiControllerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    viewerRuntime: ReturnType<typeof usePdfViewerRuntime>;
    singlePageScroll: ReturnType<typeof usePdfSinglePageNavigationController>;
    getUserViewportInteractionEpoch: () => number;
    cancelPendingSearchScroll: () => void;
    annotationRuntime: ReturnType<typeof usePdfViewerAnnotationRuntime>;
    appAnnotationHistory: ReturnType<typeof usePdfAppAnnotationHistory>;
    captureViewerScrollSnapshot: () => IScrollSnapshot | null;
    restoreViewerScrollSnapshot: NonNullable<IPdfViewerExpose['restoreScrollSnapshot']>;
    applyFitWidthToCurrentPage: NonNullable<IPdfViewerExpose['applyFitWidthToCurrentPage']>;
    waitForViewerLoadSettled: NonNullable<IPdfViewerExpose['waitForViewerLoadSettled']>;
    renderVisiblePages: (
        range: {
            start: number;
            end: number;
        },
        options?: {
            preserveRenderedPages?: boolean;
            forceRerender?: boolean;
            bufferOverride?: number;
        },
    ) => Promise<void>;
    preserveNextSourceReloadVisibleContent: NonNullable<IPdfViewerExpose['preserveNextSourceReloadVisibleContent']>;
    getPagePreview: IPdfViewerExpose['getPagePreview'];
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

export const usePdfViewerPublicApiController = (options: IUsePdfViewerPublicApiControllerOptions) => {
    const {
        annotationRuntime,
        viewerRuntime,
    } = options;
    const {
        annotations,
        annotationCommentModel,
        annotationColorCommands,
        annotationSettings,
        focusAnnotationComment,
        deleteAnnotationComment,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
        managedEmbeddedPdfShapes,
    } = annotationRuntime;
    const { currentPage } = viewerRuntime.scroll;

    async function ensurePublicAnnotationTargetPageReady(pageNumber: number) {
        if (viewerRuntime.numPages.value > 0 && pageNumber > viewerRuntime.numPages.value) {
            return false;
        }
        options.cancelPendingSearchScroll();
        options.singlePageScroll.scrollToPage(pageNumber);
        await nextTick();
        await options.waitForViewerLoadSettled();
        await viewerRuntime.document.ensurePageMetricsInRange(pageNumber, pageNumber);
        await options.renderVisiblePages(
            {
                start: pageNumber,
                end: pageNumber,
            },
            {
                preserveRenderedPages: true,
                forceRerender: true,
                bufferOverride: 0,
            },
        );
        await nextTick();
        const container = options.viewerContainer.value;
        return Boolean(container && getPageContainerByNumber(container, pageNumber));
    }

    return createPdfViewerPublicApi({
        getViewerContainer: () => options.viewerContainer.value,
        getPagePreview: options.getPagePreview,
        getCurrentPage: () => currentPage.value,
        getPendingNavigationTargetPage: () => options.singlePageScroll.navigationAnchorPage.value,
        getUserViewportInteractionEpoch: options.getUserViewportInteractionEpoch,
        scrollToPage: (pageNumber, scrollOptions) => {
            options.cancelPendingSearchScroll();
            options.singlePageScroll.scrollToPage(pageNumber, scrollOptions);
        },
        cancelProgrammaticNavigation: () => {
            options.cancelPendingSearchScroll();
            options.singlePageScroll.cancelProgrammaticNavigation();
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
        markSavedShapeState: () => {
            shapeComposable.markSavedShapeState();
            // Saving changes the clean shape baseline but must not collapse the
            // app-managed undo/redo stack; re-emit so toolbar state stays current.
            options.appAnnotationHistory.emitCombinedState();
        },
        highlightSelection: annotationRuntime.highlightComposable.highlightSelection,
        commentSelection: annotationRuntime.highlightComposable.commentSelection,
        createTextMarkupFromText: async (target) => {
            const pageNumber = Number.isFinite(target.pageNumber)
                ? Math.max(1, Math.trunc(target.pageNumber))
                : currentPage.value;
            const normalizedTarget = {
                ...target,
                pageNumber,
            };
            await ensurePublicAnnotationTargetPageReady(pageNumber);
            return annotationRuntime.highlightComposable.createTextMarkupFromText(normalizedTarget);
        },
        commentAtPoint: annotationRuntime.highlightComposable.commentAtPoint,
        createPointNoteAnnotation: async (target) => {
            const pageNumber = Number.isFinite(target.pageNumber)
                ? Math.max(1, Math.trunc(target.pageNumber))
                : currentPage.value;
            const pageX = Number.isFinite(target.pageX) ? target.pageX : 0;
            const pageY = Number.isFinite(target.pageY) ? target.pageY : 0;
            const result = (
                created: boolean,
                reason?: string,
            ) => ({
                created,
                pageNumber,
                pageX,
                pageY,
                ...(reason ? {reason} : {}),
            });

            if (viewerRuntime.numPages.value > 0 && pageNumber > viewerRuntime.numPages.value) {
                return result(false, `Page ${pageNumber} is outside the document.`);
            }

            const isTargetPageReady = await ensurePublicAnnotationTargetPageReady(pageNumber);
            if (!isTargetPageReady) {
                return result(false, `Page ${pageNumber} is not rendered.`);
            }
            const pointOptions = target.preferTextAnchor === undefined
                ? {}
                : {preferTextAnchor: target.preferTextAnchor};
            const created = await annotationRuntime.highlightComposable.commentAtPoint(
                pageNumber,
                pageX,
                pageY,
                pointOptions,
            );
            return result(created, created ? undefined : 'Point note could not be created.');
        },
        createShapeAnnotation: async (target) => {
            const pageNumber = Number.isFinite(target.pageNumber)
                ? Math.max(1, Math.trunc(target.pageNumber))
                : currentPage.value;
            const result = (
                created: boolean,
                shape: ReturnType<typeof toShapeAnnotationCommentSummary> | null,
                reason?: string,
            ) => ({
                created,
                pageNumber,
                shape,
                ...(reason ? {reason} : {}),
            });

            if (viewerRuntime.numPages.value > 0 && pageNumber > viewerRuntime.numPages.value) {
                return result(false, null, `Page ${pageNumber} is outside the document.`);
            }

            const isTargetPageReady = await ensurePublicAnnotationTargetPageReady(pageNumber);
            if (!isTargetPageReady) {
                return result(false, null, `Page ${pageNumber} is not rendered.`);
            }

            const shape = shapeComposable.buildShapeAnnotation(
                {
                    ...target,
                    pageIndex: pageNumber - 1,
                },
                annotationSettings.value ?? DEFAULT_ANNOTATION_SETTINGS,
            );
            if (!shape) {
                return result(false, null, 'Shape geometry is too small or invalid.');
            }

            shapeComposable.addShape(shape);
            shapeTool.handleShapeCreated(shape);
            return result(true, toShapeAnnotationCommentSummary(shape));
        },
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
        unsuppressAnnotationId: (annotationId) => {
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
};
