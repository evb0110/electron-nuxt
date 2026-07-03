import type { Ref } from 'vue';
import type { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import type { usePdfViewerRuntime } from '@app/modules/pdf-viewer/runtime/usePdfViewerRuntime';
import type { usePdfViewerAnnotationRuntime } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime';
import type { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { createPdfViewerPublicApi } from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerPublicApi';
import type { TPdfViewerPublicApiSource } from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerPublicApi';
import type { IScrollSnapshot } from '@app/types/pdfUi';
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
    runSaveTransaction: IPdfViewerExpose['runSaveTransaction'];
    saveViewerDocument: IPdfViewerExpose['saveDocument'];
    materializePdfJsDocumentForInternalUse: IPdfViewerExpose['materializePdfJsDocumentForInternalUse'];
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
        annotationMutationService,
        annotationCommentModel,
        annotationSettings,
        focusAnnotationComment,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
    } = annotationRuntime;
    const { currentPage } = viewerRuntime.scroll;

    async function renderAnnotationPage(pageNumber: number, optionsOverride: { forceRerender?: boolean } = {}) {
        if (!Number.isFinite(pageNumber)) {
            return false;
        }
        const normalizedPageNumber = Math.max(1, Math.trunc(pageNumber));
        if (viewerRuntime.numPages.value > 0 && normalizedPageNumber > viewerRuntime.numPages.value) {
            return false;
        }
        await options.waitForViewerLoadSettled();
        await viewerRuntime.document.ensurePageMetricsInRange(normalizedPageNumber, normalizedPageNumber);
        await options.renderVisiblePages(
            {
                start: normalizedPageNumber,
                end: normalizedPageNumber,
            },
            {
                preserveRenderedPages: true,
                ...(optionsOverride.forceRerender !== undefined ? { forceRerender: optionsOverride.forceRerender } : {}),
                bufferOverride: 0,
            },
        );
        await nextTick();
        const container = options.viewerContainer.value;
        return Boolean(container && getPageContainerByNumber(container, normalizedPageNumber));
    }

    async function rerenderAnnotationPage(pageNumber: number) {
        return renderAnnotationPage(pageNumber, { forceRerender: true });
    }

    async function ensurePublicAnnotationTargetPageReady(pageNumber: number) {
        if (viewerRuntime.numPages.value > 0 && pageNumber > viewerRuntime.numPages.value) {
            return false;
        }
        options.cancelPendingSearchScroll();
        options.singlePageScroll.scrollToPage(pageNumber);
        await nextTick();
        return renderAnnotationPage(pageNumber);
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
        runSaveTransaction: options.runSaveTransaction,
        saveDocument: options.saveViewerDocument,
        materializePdfJsDocumentForInternalUse: options.materializePdfJsDocumentForInternalUse,
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
        annotationHistoryMutationVersion: options.appAnnotationHistory.annotationHistoryMutationVersion,
        annotationHistoryResetVersion: options.appAnnotationHistory.annotationHistoryResetVersion,
        startCommentPlacement: annotationRuntime.highlightComposable.startCommentPlacement,
        cancelCommentPlacement: annotationRuntime.highlightComposable.cancelCommentPlacement,
        undoAnnotation: options.undoAnnotation,
        redoAnnotation: options.redoAnnotation,
        registerAnnotationHistoryCommand: annotationRuntime.registerShapeHistoryCommand,
        focusAnnotationComment,
        updateAnnotationComment: (comment, text) => annotationMutationService.updateComment(
            {
                comment,
                text,
            },
            { source: 'user' },
        ),
        deleteAnnotationComment: comment => annotationMutationService.deleteAnnotation(
            { comment },
            { source: 'user' },
        ),
        getAnnotationCommentsSnapshot: annotationCommentModel.getSnapshot,
        rerenderAnnotationPage,
        getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
        getMarkupSubtypeHints: annotations.editor.getMarkupSubtypeHints,
        getSelectedTextMarkupAnnotationProperties: annotations.editor.markupSubtype.getSelectedTextMarkupAnnotationProperties,
        updateSelectedTextMarkupAnnotationColor: color => annotationMutationService.updateColor(
            {
                color,
                selected: true,
            },
            { source: 'user' },
        ),
        updateTextMarkupAnnotationColor: (comment, color) => annotationMutationService.updateColor(
            {
                comment,
                color,
            },
            { source: 'user' },
        ),
        pendingEmbeddedMutationVersion: annotationMutationService.pendingEmbeddedMutationVersion,
        queuePendingEmbeddedTextUpdate: (comment, text, stableKey) => annotationMutationService.queuePendingEmbeddedTextUpdate({
            comment,
            text,
            ...(stableKey !== undefined ? {stableKey} : {}),
        }),
        clearPendingEmbeddedTextUpdate: annotationMutationService.clearPendingEmbeddedTextUpdate,
        migratePendingEmbeddedTextUpdate: annotationMutationService.migratePendingEmbeddedTextUpdate,
        queuePendingEmbeddedAnnotationDelete: annotationMutationService.queuePendingEmbeddedAnnotationDelete,
        unqueuePendingEmbeddedAnnotationDelete: annotationMutationService.unqueuePendingEmbeddedAnnotationDelete,
        getPendingEmbeddedMutationSnapshot: annotationMutationService.getPendingEmbeddedMutationSnapshot,
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
        suppressAnnotationId: annotationId => annotationMutationService.suppressAnnotation({annotationId}),
        unsuppressAnnotationId: annotationId => annotationMutationService.unsuppressAnnotation({annotationId}),
        suppressAnnotationStableKey: stableKey => annotationMutationService.suppressAnnotation({stableKey}),
        unsuppressAnnotationStableKey: stableKey => annotationMutationService.unsuppressAnnotation({stableKey}),
        removeAnnotationFromDom: annotationRuntime.removeAnnotationFromDom,
        removeAnnotationFromInternalCache: stableKey => annotationMutationService.removeAnnotationFromInternalCache(
            stableKey,
            { source: 'user' },
        ),
        restoreAnnotationToInternalCache: comment => annotationMutationService.restoreAnnotation(
            comment,
            { source: 'user' },
        ),
        clearPendingMarkerMoves: annotationMutationService.clearPendingMarkerMoves,
        captureRegionToClipboard: options.captureRegionToClipboard,
        isCapturingRegion: options.isCapturingRegion,
        startCropSelection: options.startCropSelection,
        cancelCropSelection: options.cancelCropSelection,
        isCropSelecting: options.isCropSelecting,
        requestScrollToCurrentResult: options.requestScrollToCurrentResult,
    });
};
