import type { Ref } from 'vue';
import type { Merge } from 'type-fest';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { TPdfAnnotationSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession';
import type { IPdfViewerExpose } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { toShapeAnnotationCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import { toSelectedTextMarkupComment } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';

type TPdfViewerPublicApiRefBackedKeys =
    | 'annotationHistoryMutationVersion'
    | 'annotationHistoryResetVersion'
    | 'hasShapes'
    | 'isCapturingRegion'
    | 'isCropSelecting'
    | 'selectedShapeId';

type TPdfViewerRefBackedSource = {
    [TKey in TPdfViewerPublicApiRefBackedKeys]-?: Readonly<Ref<Exclude<IPdfViewerExpose[TKey], undefined>>>;
};

type TPdfViewerPublicApiSource = Merge<
    Omit<IPdfViewerExpose, TPdfViewerPublicApiRefBackedKeys>,
    TPdfViewerRefBackedSource
>;

interface IUsePdfViewerPublicApiControllerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    documentSession: TPdfDocumentSession;
    viewportSession: TPdfViewportSession;
    getUserViewportInteractionEpoch: () => number;
    cancelPendingSearchScroll: () => void;
    annotationSession: TPdfAnnotationSession;
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
    renderLoadedPdfPagesForBrowserPrint: NonNullable<IPdfViewerExpose['renderLoadedPdfPagesForBrowserPrint']>;
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

export const usePdfViewerPublicApiController = (
    options: IUsePdfViewerPublicApiControllerOptions,
): TPdfViewerPublicApiSource => {
    const {
        annotationSession,
        documentSession,
    } = options;
    const annotationRuntime = annotationSession;
    const viewportSession = options.viewportSession;
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
    const currentPage = viewportSession.currentPage;

    async function renderAnnotationPage(pageNumber: number, optionsOverride: { forceRerender?: boolean } = {}) {
        if (!Number.isFinite(pageNumber)) {
            return false;
        }
        const normalizedPageNumber = Math.max(1, Math.trunc(pageNumber));
        if (documentSession.numPages.value > 0 && normalizedPageNumber > documentSession.numPages.value) {
            return false;
        }
        await options.waitForViewerLoadSettled();
        await documentSession.ensurePageMetricsInRange(normalizedPageNumber, normalizedPageNumber);
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
        if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
            return false;
        }
        options.cancelPendingSearchScroll();
        viewportSession.singlePageScroll.scrollToPage(pageNumber);
        await nextTick();
        return renderAnnotationPage(pageNumber);
    }

    return {
        getViewerContainer: () => options.viewerContainer.value,
        getCurrentPage: () => currentPage.value,
        getPendingNavigationTargetPage: () => viewportSession.singlePageScroll.navigationAnchorPage.value,
        getUserViewportInteractionEpoch: options.getUserViewportInteractionEpoch,
        scrollToPage: (pageNumber, scrollOptions) => {
            options.cancelPendingSearchScroll();
            viewportSession.singlePageScroll.scrollToPage(pageNumber, scrollOptions);
        },
        cancelProgrammaticNavigation: () => {
            options.cancelPendingSearchScroll();
            viewportSession.singlePageScroll.cancelProgrammaticNavigation('public-api');
        },
        applyFitWidthToCurrentPage: options.applyFitWidthToCurrentPage,
        ensurePageMetricsInRange: documentSession.ensurePageMetricsInRange,
        getPageMetricsSnapshot: () => documentSession.pageMetrics.value.map(metric => ({ ...metric })),
        waitForViewerLoadSettled: options.waitForViewerLoadSettled,
        preserveNextSourceReloadVisibleContent: options.preserveNextSourceReloadVisibleContent,
        adoptPersistedManagedShapesOnNextImport: annotationRuntime.adoptPersistedManagedShapesOnNextImport,
        clearPendingManagedShapeImportAdoption: annotationRuntime.clearPendingManagedShapeImportAdoption,
        ensureManagedShapeBaselineReady: annotationRuntime.ensureManagedShapeBaselineReady,
        preparePersistedManagedShapesForSave: annotationRuntime.preparePersistedManagedShapesForSave,
        restorePreparedManagedShapesAfterFailedSave: annotationRuntime.restorePreparedManagedShapesAfterFailedSave,
        runSaveTransaction: annotationSession.runSaveTransaction,
        saveDocument: annotationSession.saveViewerDocument,
        materializePdfJsDocumentForInternalUse: annotationSession.materializePdfJsDocumentForInternalUse,
        clearAnnotationHistory: () => annotationSession.appAnnotationHistory.clear(),
        renderLoadedPdfPagesForBrowserPrint: options.renderLoadedPdfPagesForBrowserPrint,
        markSavedShapeState: () => {
            shapeComposable.markSavedShapeState();
            // Saving changes the clean shape baseline but must not collapse the
            // app-managed undo/redo stack; re-emit so toolbar state stays current.
            annotationSession.appAnnotationHistory.emitCombinedState();
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

            if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
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

            if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
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

            shapeTool.handleShapeCreated(shape);
            return result(true, toShapeAnnotationCommentSummary(shape));
        },
        annotationHistoryMutationVersion: annotationSession.appAnnotationHistory.annotationHistoryMutationVersion,
        annotationHistoryResetVersion: annotationSession.appAnnotationHistory.annotationHistoryResetVersion,
        hasCanonicalAnnotationChanges: annotationRuntime.hasCanonicalAnnotationChanges,
        getDeletedCanonicalAnnotationIds: annotationRuntime.getDeletedCanonicalAnnotationIds,
        getDeletedPersistedCanonicalAnnotationCount: annotationRuntime.getDeletedPersistedCanonicalAnnotationCount,
        setWorkspaceCommandSink: annotationSession.appAnnotationHistory.setWorkspaceCommandSink,
        startCommentPlacement: annotationRuntime.highlightComposable.startCommentPlacement,
        cancelCommentPlacement: annotationRuntime.highlightComposable.cancelCommentPlacement,
        undoAnnotation: annotationSession.undoAnnotation,
        redoAnnotation: annotationSession.redoAnnotation,
        registerAnnotationHistoryCommand: annotationRuntime.registerShapeHistoryCommand,
        ensurePdfAnnotationNameReconciliation: annotations.commentSync.ensurePdfAnnotationNameReconciliation,
        focusAnnotationComment,
        updateAnnotationComment: (comment, text) => {
            const updated = annotationMutationService.updateComment(
                {
                    comment,
                    text,
                },
                { source: 'user' },
            );
            if (comment.source === 'pdf' && !comment.annotationName) {
                void annotations.commentSync
                    .ensurePdfAnnotationNameReconciliation('existing-annotation-mutation');
            }
            return updated;
        },
        moveAnnotationMarker: (comment, rect) => annotationMutationService.moveMarker(
            {
                comment,
                rect,
            },
            {source: 'agent'},
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
        updateSelectedTextMarkupAnnotationColor: (color, selected) => annotationMutationService.updateColor(
            {
                color,
                comment: toSelectedTextMarkupComment(selected),
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
        deleteEmbeddedAnnotationDeferred: annotationMutationService.deleteEmbeddedAnnotationDeferred,
        getAllShapes: shapeComposable.getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys,
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
        remapPageIdentityDelta: delta => annotationRuntime.annotationApplication.value.remapPages(delta),
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
    };
};
