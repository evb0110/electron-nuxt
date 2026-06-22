import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { useManagedEmbeddedPdfShapes } from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { isImportedEmbeddedShapeSubtype } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/isImportedEmbeddedShapeSubtype';
import type { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import { useAnnotationOrchestrator } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationOrchestrator';
import {
    usePdfAnnotationColorCommands,
    usePdfAnnotationCommentActions,
    usePdfAnnotationCommentModel,
} from '@app/modules/pdf-viewer/annotations/public';
import { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/public';
import { usePdfViewerPortalAnnotationHandlers } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerPortalAnnotationHandlers';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    IPageRange,
    PDFDocumentProxy,
    TPdfSource,
} from '@app/types/pdf';


interface IUsePdfViewerAnnotationRuntimeOptions {
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    sourcePdfData: ComputedRef<Uint8Array | null>;
    workingCopyPath: ComputedRef<string | null>;
    isAnySaving: Ref<boolean>;
    bufferPages: ComputedRef<number>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    effectiveScale: ComputedRef<number>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationKeepActive: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<GenericL10n | null>;
    renderedPageStateVersion: Ref<number>;
    authorName: ComputedRef<string | null | undefined>;
    appAnnotationHistory: ReturnType<typeof usePdfAppAnnotationHistory>;
    pdfjsAnnotationEditorState: Ref<IAnnotationEditorState>;
    stopDrag: () => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    renderVisiblePages: (
        range: IPageRange,
        options?: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
            forceRerender?: boolean;
        },
    ) => Promise<void>;
    renderAnnotationEditorLayerForPage: (pageNumber: number) => Promise<boolean>;
    isPageRendered: (pageNumber: number) => boolean;
    invalidatePages: (pages: number[]) => void;
    hideManagedAnnotationEditors: (pageNumber?: number) => void;
    emitAnnotationModified: (payload?: IAnnotationModifiedPayload) => void;
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: Parameters<ReturnType<typeof useAnnotationOrchestrator>['crud']['handleAnnotationCommentContextMenu']>[0] extends never
        ? (payload: unknown) => void
        : (payload: Parameters<Parameters<typeof useAnnotationOrchestrator>[0]['emitAnnotationContextMenu']>[0]) => void;
    emitAnnotationToolAutoReset: () => void;
    emitAnnotationSetting: Parameters<typeof useAnnotationOrchestrator>[0]['emitAnnotationSetting'];
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationToolCancel: () => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
    emitShapeContextMenu: Parameters<typeof usePdfShapeTool>[0]['emitShapeContextMenu'];
}

export const usePdfViewerAnnotationRuntime = (options: IUsePdfViewerAnnotationRuntimeOptions) => {
    const sourcePdfFileSize = computed(() => {
        const source = options.src.value;
        if (!source) {
            return null;
        }
        if (
            typeof source === 'object'
            && 'kind' in source
            && source.kind === 'path'
        ) {
            return source.size;
        }
        return source instanceof Blob ? source.size : null;
    });

    function registerShapeHistoryCommand(command: {
        cmd: () => void;
        undo: () => void;
    }) {
        options.appAnnotationHistory.registerCommand(command);
    }

    function emitForcedAnnotationMutation(mutationOptions: { scheduleCommentSync?: boolean } = {}) {
        options.emitAnnotationModified({ forceDirty: true });
        if (mutationOptions.scheduleCommentSync) {
            annotations.commentSync.scheduleAnnotationCommentsSync();
        }
    }

    let deletedShapeHandler: ((shape: IShapeAnnotation) => void) | null = null;
    let shapeCommentsChangedHandler: (() => void) | null = null;
    const shapeTool = usePdfShapeTool({
        annotationTool: options.annotationTool,
        annotationSettings: options.annotationSettings,
        isAnySaving: options.isAnySaving,
        registerHistoryCommand: registerShapeHistoryCommand,
        markModified: options.emitAnnotationModified,
        emitShapeContextMenu: options.emitShapeContextMenu,
        getDeletedShapeHandler: () => deletedShapeHandler,
        getShapeCommentsChangedHandler: () => shapeCommentsChangedHandler,
    });
    const {
        shapeComposable,
        selectedShapeCommands,
    } = shapeTool;

    const managedEmbeddedPdfShapes = useManagedEmbeddedPdfShapes({
        viewerContainer: options.viewerContainer,
        workingCopyPath: options.workingCopyPath,
        sourcePdfData: options.sourcePdfData,
        sourcePdfFileSize,
        visibleRange: options.visibleRange,
        bufferPages: options.bufferPages,
        shapeComposable,
        suppressCommentAnnotationId: (annotationId) => annotations.commentSync.suppressAnnotationId(annotationId),
        logger: BrowserLogger,
        runGuardedTask,
        nextTick,
        isPageRendered: pageNumber => options.isPageRendered(pageNumber),
        invalidatePages: pages => options.invalidatePages(pages),
        renderVisiblePages: (range, renderOptions) => options.renderVisiblePages(range, renderOptions),
        hideManagedAnnotationEditors: pageNumber => options.hideManagedAnnotationEditors(pageNumber),
        currentPage: options.currentPage,
    });
    deletedShapeHandler = (shape) => {
        if (shape.annotationId) {
            managedEmbeddedPdfShapes.suppressAnnotationId(shape.annotationId);
        }
        managedEmbeddedPdfShapes.refreshDeletedEmbeddedShape(shape);
    };

    watch(options.pdfDocument, () => {
        managedEmbeddedPdfShapes.clearVisuallySuppressedAnnotationIds();
    });

    const annotationCommentModel = usePdfAnnotationCommentModel({
        isAnySaving: options.isAnySaving,
        getShapeAnnotationCommentSummaries: shapeTool.getShapeAnnotationCommentSummaries,
        emitAnnotationComments: options.emitAnnotationComments,
        shouldSuppressSidebarComment: (comment) => {
            const annotationId = normalizePdfJsAnnotationId(comment.annotationId);
            return (
                Boolean(comment.subtype && isImportedEmbeddedShapeSubtype(comment.subtype))
                || Boolean(annotationId && managedEmbeddedPdfShapes.hiddenEmbeddedAnnotationIds.value.has(annotationId))
            );
        },
        suppressAnnotationStableKey: stableKey => annotations.commentSync.suppressAnnotationStableKey(stableKey),
        unsuppressAnnotationStableKey: stableKey => annotations.commentSync.unsuppressAnnotationStableKey(stableKey),
        suppressAnnotationId: annotationId => annotations.commentSync.suppressAnnotationId(annotationId),
        unsuppressAnnotationId: annotationId => annotations.commentSync.unsuppressAnnotationId(annotationId),
    });
    const {
        annotationCommentsCache,
        activeCommentStableKey,
    } = annotationCommentModel;
    shapeCommentsChangedHandler = () => {
        annotationCommentModel.emitCommentsForSidebar(annotationCommentsCache.value);
    };

    watch(
        () => shapeComposable.shapes.value,
        () => {
            if (!options.src.value && !options.pdfDocument.value) {
                return;
            }
            annotationCommentModel.emitCommentsForSidebar(annotationCommentsCache.value);
            if (options.appAnnotationHistory.canUndo.value || options.appAnnotationHistory.canRedo.value) {
                options.appAnnotationHistory.emitCombinedState();
            }
        },
    );

    let undoPdfjsAnnotationHandler: (() => void) | null = null;
    let redoPdfjsAnnotationHandler: (() => void) | null = null;

    const annotations = useAnnotationOrchestrator({
        viewerContainer: options.viewerContainer,
        pdfDocument: options.pdfDocument,
        numPages: options.numPages,
        currentPage: options.currentPage,
        effectiveScale: options.effectiveScale,
        annotationTool: options.annotationTool,
        annotationKeepActive: options.annotationKeepActive,
        annotationSettings: options.annotationSettings,
        annotationUiManager: options.annotationUiManager,
        annotationL10n: options.annotationL10n,
        annotationCommentsCache,
        activeCommentStableKey,
        markerGeometryVersion: options.renderedPageStateVersion,
        authorName: options.authorName,
        stopDrag: options.stopDrag,
        scrollToPage: options.scrollToPage,
        renderVisiblePages: options.renderVisiblePages,
        renderAnnotationEditorLayerForPage: options.renderAnnotationEditorLayerForPage,
        updateVisibleRange: options.updateVisibleRange,
        emitAnnotationModified: options.emitAnnotationModified,
        emitAnnotationState: (state) => {
            options.pdfjsAnnotationEditorState.value = state;
            options.appAnnotationHistory.emitCombinedState();
        },
        recordPdfjsHistoryCommand: params => options.appAnnotationHistory.registerPdfjsCommand(params),
        recordPdfjsHistoryClean: type => options.appAnnotationHistory.cleanPdfjsCommands(type),
        recordPdfjsHistoryUndo: () => options.appAnnotationHistory.notifyPdfjsUndo(),
        recordPdfjsHistoryRedo: () => options.appAnnotationHistory.notifyPdfjsRedo(),
        discardPdfjsHistory: () => options.appAnnotationHistory.discardPdfjsCommands(),
        isPdfjsHistoryRouted: () => options.appAnnotationHistory.isRoutingPdfjsHistory(),
        routeAnnotationHistoryUndo: () => options.appAnnotationHistory.undo({ undoPdfjs: () => undoPdfjsAnnotationHandler?.() }),
        routeAnnotationHistoryRedo: () => options.appAnnotationHistory.redo({ redoPdfjs: () => redoPdfjsAnnotationHandler?.() }),
        emitAnnotationComments: annotationCommentModel.applyFromSync,
        emitAnnotationOpenNote: (comment) => {
            const noteComment = annotationCommentModel.withTransientNoteCreationTimestamp(comment);
            annotationCommentModel.upsertComment(noteComment);
            options.emitAnnotationOpenNote(noteComment);
        },
        emitAnnotationContextMenu: options.emitAnnotationContextMenu,
        emitAnnotationToolAutoReset: options.emitAnnotationToolAutoReset,
        emitAnnotationSetting: options.emitAnnotationSetting,
        emitAnnotationCommentClick: options.emitAnnotationCommentClick,
        emitAnnotationToolCancel: options.emitAnnotationToolCancel,
        emitAnnotationNotePlacementChange: options.emitAnnotationNotePlacementChange,
    });

    const highlightComposable = annotations.highlight;
    const commentCrud = annotations.crud;
    const annotationColorCommands = usePdfAnnotationColorCommands({
        viewerContainer: options.viewerContainer,
        pdfDocument: options.pdfDocument,
        annotationSettings: options.annotationSettings,
        annotations,
        annotationCommentModel,
        emitForcedAnnotationMutation,
        refreshEditedTextMarkupPage: (pageNumber) => {
            runGuardedTask(
                () => options.renderVisiblePages(
                    {
                        start: pageNumber,
                        end: pageNumber,
                    },
                    {
                        preserveRenderedPages: true,
                        forceRerender: true,
                        bufferOverride: 0,
                    },
                ),
                {
                    scope: 'annotations',
                    message: `Failed to refresh edited text markup page ${pageNumber}`,
                },
            );
        },
    });
    const {
        focusAnnotationComment,
        deleteAnnotationComment,
    } = usePdfAnnotationCommentActions({
        viewerContainer: options.viewerContainer,
        numPages: options.numPages,
        activeCommentStableKey,
        annotationCommentsCache,
        annotationCommentModel,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
        commentCrud,
        scrollToPage: options.scrollToPage,
        updateVisibleRange: options.updateVisibleRange,
        renderVisiblePages: options.renderVisiblePages,
        emitForcedAnnotationMutation,
    });

    const portalHandlers = usePdfViewerPortalAnnotationHandlers({
        activeCommentStableKey,
        suppressAnnotationId: managedEmbeddedPdfShapes.suppressAnnotationId,
        removeAnnotationFromDom: commentCrud.removeAnnotationFromDom,
        refreshHiddenAnnotationPage: managedEmbeddedPdfShapes.refreshHiddenAnnotationPage,
        emitAnnotationOpenNote: options.emitAnnotationOpenNote,
        emitAnnotationContextMenu: options.emitAnnotationContextMenu,
        buildAnnotationContextMenuPayload: highlightComposable.buildAnnotationContextMenuPayload,
        handleMarkerMove: annotationCommentModel.handleMarkerMove,
        findEditorForComment: commentCrud.findEditorForComment,
        addPendingCommentEditorKey: key => annotations.commentSync.pendingCommentEditorKeys.add(key),
        getEditorPendingKey: annotations.identity.getEditorPendingKey,
        markModified: emitForcedAnnotationMutation,
        getAnnotationTool: () => options.annotationTool.value,
        cancelAnnotationTool: options.emitAnnotationToolCancel,
        isCommentPlacementActive: () => highlightComposable.isPlacingComment.value,
        cancelCommentPlacement: highlightComposable.cancelCommentPlacement,
    });

    function handleSourceChanged(next: TPdfSource | null, previous: TPdfSource | null) {
        annotationCommentModel.handleSourceChanged(
            next,
            previous,
            { syncAnnotationComments: annotations.commentSync.syncAnnotationComments },
        );
    }

    return {
        annotations,
        annotationCommentModel,
        annotationCommentsCache,
        activeCommentStableKey,
        annotationColorCommands,
        focusAnnotationComment,
        deleteAnnotationComment,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
        managedEmbeddedPdfShapes,
        annotationSettings: options.annotationSettings,
        managedEmbeddedAnnotationIds: managedEmbeddedPdfShapes.managedEmbeddedAnnotationIds,
        hiddenEmbeddedAnnotationIds: managedEmbeddedPdfShapes.hiddenEmbeddedAnnotationIds,
        renderHiddenEmbeddedAnnotationIds: managedEmbeddedPdfShapes.renderHiddenEmbeddedAnnotationIds,
        suppressAnnotationId: managedEmbeddedPdfShapes.suppressAnnotationId,
        adoptPersistedManagedShapesOnNextImport: managedEmbeddedPdfShapes.adoptPersistedManagedShapesOnNextImport,
        clearPendingManagedShapeImportAdoption: managedEmbeddedPdfShapes.clearPendingManagedShapeImportAdoption,
        preparePersistedManagedShapesForSave: managedEmbeddedPdfShapes.preparePersistedManagedShapesForSave,
        restorePreparedManagedShapesAfterFailedSave: managedEmbeddedPdfShapes.restorePreparedManagedShapesAfterFailedSave,
        highlightComposable,
        commentCrud,
        markersByPage: annotations.markersByPage,
        linksByPage: annotations.linksByPage,
        registerShapeHistoryCommand,
        setUndoPdfjsAnnotationHandler: (handler: (() => void) | null) => {
            undoPdfjsAnnotationHandler = handler;
        },
        setRedoPdfjsAnnotationHandler: (handler: (() => void) | null) => {
            redoPdfjsAnnotationHandler = handler;
        },
        handleSourceChanged,
        ...portalHandlers,
    };
};
