import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import {
    getEditorsOnPage,
    type TPdfjsAnnotationManager,
} from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import {
    useManagedEmbeddedPdfShapes,
    type IManagedEmbeddedPdfShapeProjectionPort,
} from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { isImportedEmbeddedShapeSubtype } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/isImportedEmbeddedShapeSubtype';
import { shouldDemandManagedEmbeddedShapeBaseline } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-import-policy/shouldDemandManagedEmbeddedShapeBaseline';
import type { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import { useAnnotationOrchestrator } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationOrchestrator';
import {
    AnnotationApplication,
    usePdfAnnotationColorCommands,
    usePdfAnnotationCommentActions,
    usePdfAnnotationCommentModel,
} from '@app/modules/pdf-viewer/annotations/public';
import { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/public';
import { useAnnotationMutationService } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationService';
import { useAnnotationMutationVisualEffects } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationVisualEffects';
import { usePdfViewerPortalAnnotationHandlers } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerPortalAnnotationHandlers';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type {
    IAnnotationCommentSummary,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type {
    IPageRange,
    TPdfSource,
} from '@app/types/pdfUi';
import type { IPdfjsAnnotationEditorState } from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import {createAttachablePdfAnnotationRenderingPort} from '@app/modules/pdf-viewer/runtime/annotations/createAttachablePdfAnnotationRenderingPort';
import type { IPdfAnnotationRenderingPort } from '@app/modules/pdf-viewer/runtime/annotations/createAttachablePdfAnnotationRenderingPort';
import { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';


interface IUsePdfViewerAnnotationRuntimeOptions {
    viewerContainer: Ref<HTMLElement | null>;
    originalPath: ComputedRef<string | null>;
    src: ComputedRef<TPdfSource | null>;
    sourcePdfData: ComputedRef<Uint8Array | null>;
    workingCopyPath: ComputedRef<string | null>;
    documentRevisionToken: ComputedRef<TDocumentRevisionToken | null>;
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
    annotationUiManager: ShallowRef<TPdfjsAnnotationManager | null>;
    annotationL10n: ShallowRef<GenericL10n | null>;
    renderedPageStateVersion: Ref<number>;
    authorName: ComputedRef<string | null | undefined>;
    appAnnotationHistory: ReturnType<typeof usePdfAppAnnotationHistory>;
    pdfjsAnnotationEditorState: Ref<IPdfjsAnnotationEditorState>;
    stopDrag: () => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
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
    const {
        port: renderingPort,
        attachRenderingPort,
    } = createAttachablePdfAnnotationRenderingPort();
    function emitForcedAnnotationMutation(mutationOptions: { scheduleCommentSync?: boolean } = {}) {
        options.emitAnnotationModified({ forceDirty: true });
        if (mutationOptions.scheduleCommentSync) {
            annotations.commentSync.scheduleAnnotationCommentsSync();
        }
    }

    function registerShapeHistoryCommand(command: {
        cmd: () => void;
        undo: () => void;
    }) {
        options.appAnnotationHistory.registerCommand(command);
    }

    let deletedShapeHandler: ((shape: IShapeAnnotation) => void) | null = null;
    let shapeCommentsChangedHandler: (() => void) | null = null;
    function createAnnotationApplication(documentKey: string) {
        const history = options.appAnnotationHistory;
        return new AnnotationApplication(documentKey, new AnnotationStore({
            get canUndo() { return history.canUndo.value; },
            get canRedo() { return history.canRedo.value; },
            registerCommand: command => history.registerCommand(command),
            undo: () => history.undo(),
            redo: () => history.redo(),
        }));
    }
    const annotationApplication = shallowRef(createAnnotationApplication('no-document'));
    const shapeTool = usePdfShapeTool({
        annotationTool: options.annotationTool,
        annotationSettings: options.annotationSettings,
        isAnySaving: options.isAnySaving,
        annotationApplication,
        markModified: options.emitAnnotationModified,
        emitShapeContextMenu: options.emitShapeContextMenu,
        getDeletedShapeHandler: () => deletedShapeHandler,
        getShapeCommentsChangedHandler: () => shapeCommentsChangedHandler,
    });
    const {
        shapeComposable,
        selectedShapeCommands,
    } = shapeTool;

    function commitProjectedShapesToCanonical() {
        annotationApplication.value.ingestShapes(shapeComposable.getAllShapes());
    }
    const canonicalShapeProjectionPort: IManagedEmbeddedPdfShapeProjectionPort = {
        hasShapes: shapeComposable.hasShapes,
        deletedEmbeddedAnnotationIds: shapeComposable.deletedEmbeddedAnnotationIds,
        getAllShapes: shapeComposable.getAllShapes,
        getDeletedEmbeddedAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys,
        replaceShapes: (shapes) => {
            annotationApplication.value.ingestShapes(shapes);
            shapeComposable.replaceShapes(shapes);
            shapeCommentsChangedHandler?.();
        },
        reconcilePersistedShapes: (shapes) => {
            shapeComposable.reconcilePersistedShapes(shapes);
            commitProjectedShapesToCanonical();
            shapeCommentsChangedHandler?.();
        },
        primePersistedShapes: (shapes) => {
            shapeComposable.primePersistedShapes(shapes);
            commitProjectedShapesToCanonical();
            shapeCommentsChangedHandler?.();
        },
        adoptPersistedShapeMetadata: (shapes) => {
            shapeComposable.adoptPersistedShapeMetadata(shapes);
            commitProjectedShapesToCanonical();
            shapeCommentsChangedHandler?.();
        },
        captureShapeStateSnapshot: shapeComposable.captureShapeStateSnapshot,
        restoreShapeStateSnapshot: (snapshot) => {
            shapeComposable.restoreShapeStateSnapshot(snapshot);
            commitProjectedShapesToCanonical();
            shapeCommentsChangedHandler?.();
        },
    };

    const managedEmbeddedPdfShapes = useManagedEmbeddedPdfShapes({
        viewerContainer: options.viewerContainer,
        originalPath: options.originalPath,
        workingCopyPath: options.workingCopyPath,
        sourcePdfData: options.sourcePdfData,
        documentRevisionToken: options.documentRevisionToken,
        visibleRange: options.visibleRange,
        bufferPages: options.bufferPages,
        shapeComposable: canonicalShapeProjectionPort,
        logger: BrowserLogger,
        runGuardedTask,
        nextTick,
        isPageRendered: renderingPort.isPageRendered,
        invalidatePages: renderingPort.invalidatePages,
        renderVisiblePages: renderingPort.renderVisiblePages,
        hideManagedAnnotationEditors: renderingPort.hideManagedAnnotationEditors,
        currentPage: options.currentPage,
    });
    watch(options.annotationTool, (tool) => {
        if (!shouldDemandManagedEmbeddedShapeBaseline(tool)) {
            return;
        }
        runGuardedTask(
            () => managedEmbeddedPdfShapes.ensureManagedShapeBaselineReady(),
            {
                category: 'user-visible-operation',
                scope: 'pdf-shapes',
                message: 'Failed to prepare embedded PDF shapes for editing',
            },
        );
    }, {flush: 'sync'});
    deletedShapeHandler = (shape) => {
        managedEmbeddedPdfShapes.refreshDeletedEmbeddedShape(shape);
    };

    const annotationProjection = shallowRef<IAnnotationCommentSummary[]>([]);
    const annotationCommentModel = usePdfAnnotationCommentModel({
        isAnySaving: options.isAnySaving,
        annotationProjection,
        ingestSummaries: comments => annotationApplication.value.ingestLegacySummaries(comments),
        getShapeAnnotationCommentSummaries: shapeTool.getShapeAnnotationCommentSummaries,
        emitAnnotationComments: options.emitAnnotationComments,
        shouldSuppressSidebarComment: (comment) => {
            const annotationId = normalizePdfJsAnnotationId(comment.annotationId);
            return (
                Boolean(comment.subtype && isImportedEmbeddedShapeSubtype(comment.subtype))
                || Boolean(annotationId && managedEmbeddedPdfShapes.hiddenEmbeddedAnnotationIds.value.has(annotationId))
            );
        },
    });
    const {
        annotationCommentsCache,
        activeCommentStableKey,
    } = annotationCommentModel;
    let annotationMutationVisualEffects: ReturnType<typeof useAnnotationMutationService>['visualEffects'] | null = null;
    let canonicalColors = new Map<string, string | null>();
    function projectCanonicalAnnotations() {
        const projected = annotationApplication.value.listCommentSummaries();
        annotationProjection.value = projected.map(comment => Object.freeze({...comment}));
        const nextColors = new Map<string, string | null>();
        annotationApplication.value.store.list().forEach((entity) => {
            if (entity.kind === 'shape') {
                return;
            }
            const annotationId = entity.identity.id;
            const color = entity.color;
            nextColors.set(annotationId, color);
            const previousColor = canonicalColors.get(annotationId);
            if (previousColor === undefined || previousColor === color || !color || !annotationMutationVisualEffects) {
                return;
            }
            const comment = projected.find(candidate => candidate.appAnnotationId === annotationId) ?? null;
            annotationMutationVisualEffects.enqueue({
                kind: 'text-markup-color',
                annotationId,
                stableKey: comment?.stableKey ?? null,
                pageNumber: entity.pageIndex + 1,
                commentSnapshot: comment,
                color,
                sourceColor: previousColor,
            });
        });
        canonicalColors = nextColors;
        annotationCommentModel.emitCommentsForSidebar(projected);
    }
    let stopAnnotationApplicationProjection = annotationApplication.value.store.subscribe(projectCanonicalAnnotations);
    function annotationDocumentKey(source: TPdfSource | null) {
        if (!source) {
            return 'no-document';
        }
        if (source instanceof Blob) {
            return `blob:${'name' in source ? String(source.name) : 'unnamed'}:${source.size}`;
        }
        return `path:${source.path}`;
    }
    const annotationDocumentIdentity = computed(() => (
        options.workingCopyPath.value
            ? `path:${options.workingCopyPath.value}`
            : annotationDocumentKey(options.src.value)
    ));
    watch(annotationDocumentIdentity, (documentKey) => {
        stopAnnotationApplicationProjection();
        canonicalColors = new Map();
        annotationCommentModel.clearProjection();
        annotationApplication.value = createAnnotationApplication(documentKey);
        stopAnnotationApplicationProjection = annotationApplication.value.store.subscribe(projectCanonicalAnnotations);
    }, {immediate: true});
    onScopeDispose(() => stopAnnotationApplicationProjection());
    shapeCommentsChangedHandler = () => {
        annotationCommentModel.emitCommentsForSidebar(annotationCommentsCache.value);
    };

    const annotations = useAnnotationOrchestrator({
        viewerContainer: options.viewerContainer,
        sourcePdf: options.src,
        annotationDocumentIdentity,
        documentRevisionToken: options.documentRevisionToken,
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
        renderingPort,
        updateVisibleRange: options.updateVisibleRange,
        emitAnnotationModified: options.emitAnnotationModified,
        emitAnnotationState: (state) => {
            options.pdfjsAnnotationEditorState.value = state;
            options.appAnnotationHistory.emitCombinedState();
        },
        recordPdfjsExecutorCommand: command => options.appAnnotationHistory.registerExecutorCommand(command),
        isPdfjsHistoryRouted: () => options.appAnnotationHistory.isRoutingPdfjsHistory(),
        routeAnnotationHistoryUndo: () => options.appAnnotationHistory.undo(),
        routeAnnotationHistoryRedo: () => options.appAnnotationHistory.redo(),
        emitAnnotationComments: (comments, syncOptions) => {
            annotationApplication.value.reconcileLegacySummaries(comments, syncOptions);
            return annotationProjection.value.map(comment => ({...comment}));
        },
        emitAnnotationOpenNote: (comment) => {
            const noteComment = annotationCommentModel.withTransientNoteCreationTimestamp(comment);
            annotationCommentModel.upsertComment(noteComment);
            const canonicalAnnotationId = annotationApplication.value.annotationIdForSummary(noteComment);
            const canonicalNoteComment = canonicalAnnotationId
                ? annotationProjection.value.find(candidate => candidate.appAnnotationId === canonicalAnnotationId)
                : null;
            options.emitAnnotationOpenNote(canonicalNoteComment ?? noteComment);
        },
        emitAnnotationContextMenu: options.emitAnnotationContextMenu,
        emitAnnotationToolAutoReset: options.emitAnnotationToolAutoReset,
        emitAnnotationSetting: options.emitAnnotationSetting,
        emitAnnotationCommentClick: options.emitAnnotationCommentClick,
        emitAnnotationToolCancel: options.emitAnnotationToolCancel,
        emitAnnotationNotePlacementChange: options.emitAnnotationNotePlacementChange,
    });
    options.appAnnotationHistory.setReplayEffect(() => {
        const manager = options.annotationUiManager.value;
        if (manager) {
            const presentExternalIds = new Set<string>();
            const relevantPageIndexes = new Set(
                annotationApplication.value.store.list({includeDeleted: true})
                    .filter(entity => entity.kind !== 'shape')
                    .map(entity => entity.pageIndex),
            );
            for (const pageIndex of relevantPageIndexes) {
                getEditorsOnPage(manager, pageIndex).forEach((editor) => {
                    if (editor.uid) presentExternalIds.add(editor.uid);
                    if (editor.annotationElementId) presentExternalIds.add(editor.annotationElementId);
                });
            }
            annotationApplication.value.reconcilePdfjsEditorPresence(presentExternalIds);
        }
        // Layer teardown/rebuild and annotation-storage bookkeeping can finish
        // in the next task. Refresh the richer comment snapshot once that settles.
        setTimeout(() => {
            void annotations.commentSync.syncAnnotationComments();
        }, 0);
    });
    onScopeDispose(() => options.appAnnotationHistory.setReplayEffect(null));

    const highlightComposable = annotations.highlight;
    const commentCrud = annotations.crud;
    const annotationColorCommands = usePdfAnnotationColorCommands({
        pdfDocument: options.pdfDocument,
        annotations,
        annotationCommentModel,
        emitForcedAnnotationMutation,
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
        renderVisiblePages: renderingPort.renderVisiblePages,
        emitForcedAnnotationMutation,
    });

    const annotationMutationService = useAnnotationMutationService({
        runHistoryTransaction: action => options.appAnnotationHistory.runTransaction(action),
        updateAnnotationComment: commentCrud.updateAnnotationComment,
        deleteAnnotationComment,
        updateSelectedTextMarkupAnnotationColor: annotationColorCommands.updateSelectedTextMarkupAnnotationColor,
        updateTextMarkupAnnotationColor: annotationColorCommands.updateTextMarkupAnnotationColor,
        markAnnotationLocallyDeleted: annotationCommentModel.markLocallyDeleted,
        restoreAnnotationLocally: annotationCommentModel.restoreLocally,
        removeAnnotationFromInternalCache: annotationCommentModel.removeFromInternalCache,
        findAnnotationCommentByStableKey: stableKey =>
            annotationCommentsCache.value.find(comment => comment.stableKey === stableKey) ?? null,
        clearPendingMarkerMoves: annotationCommentModel.clearPendingMarkerMoves,
        handleMarkerMove: annotationCommentModel.handleMarkerMove,
        findEditorForComment: commentCrud.findEditorForComment,
        markModified: emitForcedAnnotationMutation,
        flushAnnotationCommentsForSave: annotations.commentSync.syncAnnotationComments,
        resolveCanonicalAnnotationId: comment => annotationApplication.value.annotationIdForSummary(comment),
        setCanonicalNoteText: (id, text) => annotationApplication.value.setNoteText(id, text),
        deleteCanonicalAnnotation: id => annotationApplication.value.delete(id),
        setCanonicalColor: (id, color) => annotationApplication.value.store.setStyle(id, {color}),
        moveCanonicalAnchor: (id, rect) => annotationApplication.value.store.moveAnchor(id, rect),
    });
    annotationMutationVisualEffects = annotationMutationService.visualEffects;

    useAnnotationMutationVisualEffects({
        viewerContainer: options.viewerContainer,
        annotationCommentsCache,
        annotationSettings: options.annotationSettings,
        invalidatePages: renderingPort.invalidatePages,
        renderVisiblePages: renderingPort.renderVisiblePages,
        visualEffects: annotationMutationService.visualEffects,
    });

    const portalHandlers = usePdfViewerPortalAnnotationHandlers({
        activeCommentStableKey,
        removeAnnotationFromDom: annotationMutationService.enqueueAnnotationDomRemoval,
        refreshHiddenAnnotationPage: managedEmbeddedPdfShapes.refreshHiddenAnnotationPage,
        emitAnnotationOpenNote: options.emitAnnotationOpenNote,
        emitAnnotationContextMenu: options.emitAnnotationContextMenu,
        buildAnnotationContextMenuPayload: highlightComposable.buildAnnotationContextMenuPayload,
        handleMarkerMove: (comment, markerRect) => annotationMutationService.moveMarker(
            {
                comment,
                rect: markerRect,
            },
            { source: 'user' },
        ),
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
        attachRenderingPort: (port: IPdfAnnotationRenderingPort) => attachRenderingPort(port),
        annotations,
        annotationMutationService,
        annotationApplication,
        hasCanonicalAnnotationChanges: () => {
            // Establish a Vue dependency for workspace dirty-state computed
            // values. The store is framework-agnostic, while every semantic
            // mutation publishes a fresh canonical projection.
            void annotationProjection.value;
            return annotationApplication.value.store.hasChangesSinceSavedBaseline();
        },
        getDeletedCanonicalAnnotationIds: () => Array.from(new Set(
            annotationApplication.value.store
                .list({includeDeleted: true})
                .filter(entity => entity.deleted)
                .flatMap(entity => [
                    entity.identity.id,
                    entity.identity.pdfRef,
                    entity.identity.pdfName,
                    entity.identity.pdfjsUid,
                    entity.identity.elementId,
                ].filter((value): value is string => Boolean(value))),
        )),
        getDeletedPersistedCanonicalAnnotationCount: () => annotationApplication.value.store
            .countDirtyPersistedDeletions(),
        annotationCommentModel,
        clearAnnotationProjection: annotationCommentModel.clearProjection,
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
        adoptPersistedManagedShapesOnNextImport: managedEmbeddedPdfShapes.adoptPersistedManagedShapesOnNextImport,
        clearPendingManagedShapeImportAdoption: managedEmbeddedPdfShapes.clearPendingManagedShapeImportAdoption,
        ensureManagedShapeBaselineReady: managedEmbeddedPdfShapes.ensureManagedShapeBaselineReady,
        preparePersistedManagedShapesForSave: managedEmbeddedPdfShapes.preparePersistedManagedShapesForSave,
        restorePreparedManagedShapesAfterFailedSave: managedEmbeddedPdfShapes.restorePreparedManagedShapesAfterFailedSave,
        highlightComposable,
        commentCrud,
        markersByPage: annotations.markersByPage,
        linksByPage: annotations.linksByPage,
        registerShapeHistoryCommand,
        handleSourceChanged,
        ...portalHandlers,
    };
};
