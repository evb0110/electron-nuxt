import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IAnnotationCommentSummary,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';
import {
    createEmptyPdfjsAnnotationEditorState,
    type IPdfjsAnnotationEditorState,
} from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import { usePdfViewerAnnotationRuntime } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime';
import { usePdfViewerAnnotationRuntimeBridge } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntimeBridge';
import { useEditedTextMarkupVisualSync } from '@app/modules/pdf-viewer/runtime/annotations/useEditedTextMarkupVisualSync';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { TPdfRenderingSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';

export interface ICreatePdfAnnotationSessionOptions {
    document: TPdfDocumentSession;
    viewport: TPdfViewportSession;
    rendering: TPdfRenderingSession;
    viewerContainer: Ref<HTMLElement | null>;
    originalPath: ComputedRef<string | null>;
    src: ComputedRef<TPdfSource | null>;
    sourcePdfData: ComputedRef<Uint8Array | null>;
    workingCopyPath: ComputedRef<string | null>;
    documentRevisionToken: ComputedRef<TDocumentRevisionToken | null>;
    isAnySaving: ComputedRef<boolean>;
    isActive: ComputedRef<boolean>;
    bufferPages: ComputedRef<number>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationKeepActive: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    authorName: ComputedRef<string | null | undefined>;
    stopDrag: () => void;
    clearPendingImagePlacement: () => void;
    emitAnnotationModified: (payload?: IAnnotationModifiedPayload) => void;
    emitAnnotationState: Parameters<typeof usePdfAppAnnotationHistory>[0]['emitAnnotationState'];
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => void;
    emitAnnotationOpenNote: Parameters<typeof usePdfViewerAnnotationRuntime>[0]['emitAnnotationOpenNote'];
    emitAnnotationContextMenu: Parameters<typeof usePdfViewerAnnotationRuntime>[0]['emitAnnotationContextMenu'];
    emitAnnotationToolAutoReset: () => void;
    emitAnnotationSetting: Parameters<typeof usePdfViewerAnnotationRuntime>[0]['emitAnnotationSetting'];
    emitAnnotationCommentClick: Parameters<typeof usePdfViewerAnnotationRuntime>[0]['emitAnnotationCommentClick'];
    emitAnnotationToolCancel: () => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
    emitShapeContextMenu: Parameters<typeof usePdfViewerAnnotationRuntime>[0]['emitShapeContextMenu'];
}

/**
 * Decides whether a source replacement also drops the app command stack.
 *
 * Byte operations replace the source object while retaining the same logical
 * working copy; commands beneath that checkpoint must survive the reload.
 */
function shouldClearAnnotationHistoryForSourceChange(change: {
    isAnySaving: boolean;
    nextDocumentKey: string | null;
    previousDocumentKey: string | null;
}) {
    return !change.isAnySaving && change.nextDocumentKey !== change.previousDocumentKey;
}

/**
 * Owns annotation initialization and the presentation integration with the
 * rendering owner. Editor lifecycle derives from the document proxy rather
 * than from a callback injected into the loading path.
 */
export const createPdfAnnotationSession = (options: ICreatePdfAnnotationSessionOptions) => {
    const documentSession = options.document;
    const viewport = options.viewport;
    const rendering = options.rendering;
    const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
    const annotationL10n = shallowRef<GenericL10n | null>(null);
    const pdfjsAnnotationEditorState = ref<IPdfjsAnnotationEditorState>(createEmptyPdfjsAnnotationEditorState());

    const appAnnotationHistory = usePdfAppAnnotationHistory({
        pdfjsAnnotationState: pdfjsAnnotationEditorState,
        emitAnnotationState: options.emitAnnotationState,
        markModified: options.emitAnnotationModified,
    });

    const annotationRuntime = usePdfViewerAnnotationRuntime({
        viewerContainer: options.viewerContainer,
        originalPath: options.originalPath,
        src: options.src,
        sourcePdfData: options.sourcePdfData,
        workingCopyPath: options.workingCopyPath,
        documentRevisionToken: options.documentRevisionToken,
        isAnySaving: options.isAnySaving,
        bufferPages: options.bufferPages,
        pdfDocument: documentSession.pdfDocument,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        visibleRange: viewport.visibleRange,
        effectiveScale: viewport.scale.effectiveScale,
        annotationTool: options.annotationTool,
        annotationCursorMode: options.annotationCursorMode,
        annotationKeepActive: options.annotationKeepActive,
        annotationSettings: options.annotationSettings,
        annotationUiManager: annotationUiManager,
        annotationL10n,
        renderedPageStateVersion: rendering.renderedPageStateVersion,
        authorName: options.authorName,
        appAnnotationHistory,
        pdfjsAnnotationEditorState,
        stopDrag: options.stopDrag,
        scrollToPage: (pageNumber, scrollOptions) => viewport.singlePageScroll.scrollToPage(pageNumber, scrollOptions),
        updateVisibleRange: viewport.scroll.updateVisibleRange,
        emitAnnotationModified: options.emitAnnotationModified,
        emitAnnotationComments: options.emitAnnotationComments,
        emitAnnotationOpenNote: options.emitAnnotationOpenNote,
        emitAnnotationContextMenu: options.emitAnnotationContextMenu,
        emitAnnotationToolAutoReset: options.emitAnnotationToolAutoReset,
        emitAnnotationSetting: options.emitAnnotationSetting,
        emitAnnotationCommentClick: options.emitAnnotationCommentClick,
        emitAnnotationToolCancel: options.emitAnnotationToolCancel,
        emitAnnotationNotePlacementChange: options.emitAnnotationNotePlacementChange,
        emitShapeContextMenu: options.emitShapeContextMenu,
    });

    const {
        canvasHiddenAnnotationIds,
        applyEditedTextMarkupColorsForRenderedPage,
    } = useEditedTextMarkupVisualSync({
        viewerContainer: options.viewerContainer,
        annotationCommentsCache: annotationRuntime.annotationCommentsCache,
        hiddenEmbeddedAnnotationIds: annotationRuntime.renderHiddenEmbeddedAnnotationIds,
        annotationSettings: options.annotationSettings,
    });

    annotationRuntime.attachRenderingPort({
        renderVisiblePages: (range, renderOptions) => rendering.renderVisiblePages(range, renderOptions),
        renderAnnotationEditorLayerForPage: rendering.renderAnnotationEditorLayerForPage,
        isPageRendered: rendering.isPageRendered,
        invalidatePages: rendering.invalidatePages,
        hideManagedAnnotationEditors: rendering.hideManagedAnnotationEditors,
    });

    const detachProjection = rendering.attachAnnotationProjection({
        annotationUiManager,
        annotationL10n: annotationL10n,
        hiddenAnnotationIds: annotationRuntime.renderHiddenEmbeddedAnnotationIds,
        canvasHiddenAnnotationIds,
        managedAnnotationIds: annotationRuntime.managedEmbeddedAnnotationIds,
        replaceAnnotationUiManager: (manager) => {
            if (annotationUiManager.value === manager) {
                annotationRuntime.annotations.editor.initAnnotationEditor();
            }
        },
        pageLayersRendered: pageNumber => applyEditedTextMarkupColorsForRenderedPage(pageNumber),
        pageCommitted: pageNumber => annotationRuntime.managedEmbeddedPdfShapes.syncAfterPageRendered(pageNumber),
    });

    const { scheduleSetAnnotationTool } = usePdfViewerAnnotationRuntimeBridge({
        viewerContainer: options.viewerContainer,
        isActive: options.isActive,
        currentPage: viewport.currentPage,
        effectiveScale: viewport.scale.effectiveScale,
        annotationTool: options.annotationTool,
        annotationCursorMode: options.annotationCursorMode,
        annotationSettings: options.annotationSettings,
        annotationUiManager: annotationUiManager,
        annotationCommentsCache: annotationRuntime.annotationCommentsCache,
        activeCommentStableKey: annotationRuntime.activeCommentStableKey,
        annotations: annotationRuntime.annotations,
    });

    function clearAnnotationProjectionState() {
        annotationRuntime.clearAnnotationProjection?.();
        annotationRuntime.activeCommentStableKey.value = null;
        options.emitAnnotationComments([]);
    }

    // The PDF.js editor is a projection of the live document proxy: binding it
    // to that ref keeps init/destroy out of the loading path entirely.
    watch(documentSession.pdfDocument, (document, previousDocument) => {
        if (previousDocument && !document) {
            annotationRuntime.annotations.editor.destroyAnnotationEditor();
            return;
        }
        if (document) {
            annotationRuntime.annotations.editor.initAnnotationEditor();
        }
    }, { flush: 'sync' });

    const unsubscribeDocumentTransitions = documentSession.subscribe((transition) => {
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.phase === 'invalidated') {
            annotationRuntime.annotations.commentSync.incrementSyncToken();
            annotationRuntime.annotations.highlight.clearSelectionCache();
            if (transition.reason === 'source-cleared' || transition.reason === 'empty-source') {
                clearAnnotationProjectionState();
            }
            return;
        }
        if (transition.phase === 'restore') {
            scheduleSetAnnotationTool(options.annotationTool.value, 'restore annotation tool after tab activation');
            annotationRuntime.annotations.editor.applyAnnotationSettings(options.annotationSettings.value);
            return;
        }
        if (transition.phase !== 'settled') {
            return;
        }
        // A complete annotation inventory may touch every page. Require a
        // committed canvas and then use the debounced background lane so it
        // cannot preempt the first visible render.
        annotationRuntime.annotations.commentSync.scheduleAnnotationCommentsSync();
        annotationRuntime.managedEmbeddedPdfShapes.settleViewerLoadSettledWithManagedShapes(
            transition.fence.loadToken,
            () => undefined,
        );
    });

    watch(() => [
        options.src.value,
        options.workingCopyPath.value,
    ] as const, ([
        next,
        nextDocumentKey,
    ], [
        previous,
        previousDocumentKey,
    ]) => {
        if (next === previous) {
            return;
        }
        if (shouldClearAnnotationHistoryForSourceChange({
            isAnySaving: options.isAnySaving.value,
            nextDocumentKey,
            previousDocumentKey,
        })) {
            appAnnotationHistory.clear();
        }
        options.clearPendingImagePlacement();
        annotationRuntime.handleSourceChanged(next, previous);
    });

    documentSession.registerDisposable(() => {
        unsubscribeDocumentTransitions();
        detachProjection();
        annotationRuntime.annotations.inlineIndicators.cleanup();
        annotationRuntime.annotations.highlight.clearSelectionCache();
        annotationRuntime.annotations.editor.destroyAnnotationEditor();
        clearAnnotationProjectionState();
    });

    onMounted(() => {
        annotationRuntime.annotations.inlineIndicators.attachInlineCommentMarkerObserver();
    });

    return {
        ...annotationRuntime,
        annotationUiManager,
        annotationL10n,
        appAnnotationHistory,
        pdfjsAnnotationEditorState,
        canvasHiddenAnnotationIds,
        scheduleSetAnnotationTool,
        undoAnnotation: () => appAnnotationHistory.undo(),
        redoAnnotation: () => appAnnotationHistory.redo(),
    };
};

export type TPdfAnnotationSession = ReturnType<typeof createPdfAnnotationSession>;
