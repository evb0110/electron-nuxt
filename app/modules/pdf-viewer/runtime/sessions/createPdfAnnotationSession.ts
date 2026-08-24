import type {
    ComputedRef,
    Ref,
} from 'vue';
import {getEditorsOnPage} from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { useManagedEmbeddedPdfShapes } from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { isImportedEmbeddedShapeSubtype } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/isImportedEmbeddedShapeSubtype';
import { shouldDemandManagedEmbeddedShapeBaseline } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-import-policy/shouldDemandManagedEmbeddedShapeBaseline';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { usePdfAnnotationColorCommands } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';
import { usePdfAnnotationCommentActions } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentActions';
import { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/public';
import { useAnnotationMutationService } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationService';
import { useAnnotationMutationVisualEffects } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationVisualEffects';
import { usePdfViewerPortalAnnotationHandlers } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerPortalAnnotationHandlers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
    TMarkupSubtype,
    ILinkAnnotation,
    TAnnotationSettingChange,
} from '@app/types/annotations';
import type {TPdfSource} from '@app/types/pdfUi';
import {
    createEmptyPdfjsAnnotationEditorState,
    type IPdfjsAnnotationEditorState,
} from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { collectEditedTextMarkupCanvasSuppressionIds } from '@app/modules/pdf-viewer/annotations/edited-text-markup-canvas-suppression/collectEditedTextMarkupCanvasSuppressionIds';
import { usePdfViewerAnnotationRuntimeBridge } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/usePdfViewerAnnotationRuntimeBridge';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { TPdfRenderingSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type { IAnnotationCreationFailureReport } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import {
    asAnnotationId,
    mintAnnotationId,
    normalizeAnnotationText,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { groupBy } from 'es-toolkit/array';
import { useAnnotationIdentity } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationIdentity';
import { useAnnotationSync } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationSync';
import { useAnnotationEditorBridge } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationEditorBridge';
import { useAnnotationToolState } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationToolState';
import { useAnnotationHighlight } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationHighlight';
import { useAnnotationCrud } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationCrud';
import { useFreeTextResize } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useFreeTextResize';
import { useAnnotationMarkerViewModel } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMarkerViewModel';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/openPathSecondaryPerformancePolicy';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import { useTextMarkupPresentationController } from '@app/modules/pdf-viewer/runtime/annotations/useTextMarkupPresentationController';


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
    emitAnnotationInventory: (completeness: IAnnotationInventoryCompleteness | null) => void;
    emitAnnotationEnrichmentState: (state: IAnnotationEnrichmentState) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    emitAnnotationToolAutoReset: () => void;
    emitAnnotationSetting: (payload: TAnnotationSettingChange) => void;
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationToolCancel: () => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
    reportAnnotationFailure?: (failure: IAnnotationCreationFailureReport) => void;
    emitShapeContextMenu: Parameters<typeof usePdfShapeTool>[0]['emitShapeContextMenu'];
}

interface IAnnotationStoreDocumentIdentityInput {
    workingCopyPath: string | null;
    source: TPdfSource | null;
}

interface IAnnotationSnapshotDocumentIdentityInput {
    originalPath: string | null;
    workingCopyPath: string | null;
    source: TPdfSource | null;
}

// A pathless Blob or File carries no durable name: two picks can share a name,
// a size, and a timestamp while holding different bytes. Only the object itself
// distinguishes them, so both the canonical store and the snapshot cache key on
// the instance. Entries die with the Blob, and the `blob-instance:` prefix
// cannot collide with a path.
const annotationBlobIdentities = new WeakMap<Blob, string>();
let nextAnnotationBlobIdentity = 0;

function annotationBlobIdentity(source: Blob) {
    const existing = annotationBlobIdentities.get(source);
    if (existing) {
        return existing;
    }
    nextAnnotationBlobIdentity += 1;
    const identity = `blob-instance:${nextAnnotationBlobIdentity}`;
    annotationBlobIdentities.set(source, identity);
    return identity;
}

function annotationDocumentKey(source: TPdfSource | null) {
    if (!source) {
        return 'no-document';
    }
    return source instanceof Blob
        ? annotationBlobIdentity(source)
        : `path:${source.path}`;
}

function resolveAnnotationStoreDocumentIdentity(
    input: IAnnotationStoreDocumentIdentityInput,
) {
    return input.workingCopyPath
        ? `path:${input.workingCopyPath}`
        : annotationDocumentKey(input.source);
}

// The snapshot cache keeps its own precedence: it survives working-copy
// rewrites by preferring the original path, which the canonical store must not
// do because its records describe the bytes PDF.js currently holds.
export function resolveAnnotationSnapshotDocumentIdentity(
    input: IAnnotationSnapshotDocumentIdentityInput,
) {
    return input.originalPath
        ? `source:${input.originalPath}`
        : resolveAnnotationStoreDocumentIdentity(input);
}

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
        appAnnotationHistory.registerCommand(command);
    }

    let deletedShapeHandler: ((shape: IShapeAnnotation) => void) | null = null;
    let shapeCommentsChangedHandler: (() => void) | null = null;
    function createAnnotationApplication(documentKey: string) {
        const history = appAnnotationHistory;
        return new AnnotationApplication(documentKey, new AnnotationStore({
            get canUndo() { return history.canUndo.value; },
            get canRedo() { return history.canRedo.value; },
            registerCommand: command => history.registerCommand(command),
            forgetCommands: ids => history.forgetCommands(ids),
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

    // Refreshed by the canonical projection below, which runs on every store
    // emission; the store is the only judge of what counts as deleted.
    const deletedEmbeddedAnnotationIds = shallowRef<ReadonlySet<string>>(new Set<string>());

    const managedEmbeddedPdfShapes = useManagedEmbeddedPdfShapes({
        viewerContainer: options.viewerContainer,
        originalPath: options.originalPath,
        workingCopyPath: options.workingCopyPath,
        sourcePdfData: options.sourcePdfData,
        documentRevisionToken: options.documentRevisionToken,
        visibleRange: viewport.visibleRange,
        bufferPages: options.bufferPages,
        shapeComposable,
        deletedEmbeddedAnnotationIds,
        logger: BrowserLogger,
        runGuardedTask,
        nextTick,
        isPageRendered: rendering.isPageRendered,
        invalidatePages: rendering.invalidatePages,
        renderVisiblePages: rendering.renderVisiblePages,
        hideManagedAnnotationEditors: rendering.hideManagedAnnotationEditors,
        currentPage: viewport.currentPage,
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
        deletedEmbeddedAnnotationIds.value = annotationApplication.value.deletedEmbeddedAnnotationIds();
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
    const annotationDocumentIdentity = computed(() => (
        resolveAnnotationStoreDocumentIdentity({
            workingCopyPath: options.workingCopyPath.value,
            source: options.src.value,
        })
    ));
    const annotationSnapshotDocumentIdentity = computed(() => (
        resolveAnnotationSnapshotDocumentIdentity({
            originalPath: options.originalPath.value,
            workingCopyPath: options.workingCopyPath.value,
            source: options.src.value,
        })
    ));
    function resetAnnotationApplication(documentKey: string) {
        stopAnnotationApplicationProjection();
        canonicalColors = new Map();
        annotationCommentModel.clearProjection();
        annotationApplication.value = createAnnotationApplication(documentKey);
        stopAnnotationApplicationProjection = annotationApplication.value.store.subscribe(projectCanonicalAnnotations);
    }
    watch(annotationDocumentIdentity, resetAnnotationApplication, {immediate: true});
    // Canonical annotations record edits against the bytes PDF.js currently holds.
    // A save that materializes pending deletes, and a file-history undo of one,
    // rewrite the working copy in place and reload the document under the same
    // path, so the path-keyed identity above cannot see it. Every record —
    // delete tombstones included — then describes bytes that are gone, and the
    // commands that produced them can no longer be inverted.
    // A reload clears the proxy before publishing the next one, so the swap is
    // only visible against the last document actually loaded.
    let lastLoadedPdfDocument = documentSession.pdfDocument.value;
    watch(documentSession.pdfDocument, (document) => {
        if (!document || document === lastLoadedPdfDocument) {
            return;
        }
        const replacesLoadedDocument = lastLoadedPdfDocument !== null;
        lastLoadedPdfDocument = document;
        if (!replacesLoadedDocument) {
            return;
        }
        appAnnotationHistory.clear();
        resetAnnotationApplication(annotationDocumentIdentity.value);
    });
    onScopeDispose(() => stopAnnotationApplicationProjection());
    shapeCommentsChangedHandler = () => {
        annotationCommentModel.emitCommentsForSidebar(annotationCommentsCache.value);
    };

    const { t } = useTypedI18n();
    const identity = useAnnotationIdentity(annotationCommentsCache);
    const linkAnnotations = ref<ILinkAnnotation[]>([]);
    const linksByPage = computed<Record<number, ILinkAnnotation[]>>(() =>
        groupBy(linkAnnotations.value, link => link.pageNumber),
    );
    const freeTextResize = useFreeTextResize({
        getAnnotationUiManager: () => annotationUiManager.value,
        getNumPages: () => documentSession.numPages.value,
        emitAnnotationModified: options.emitAnnotationModified,
        emitAnnotationSetting: options.emitAnnotationSetting,
        scheduleAnnotationCommentsSync: () => commentSync.scheduleAnnotationCommentsSync(),
        registerHistoryCommand: command => appAnnotationHistory.registerExecutorCommand(command),
    });
    const toolState = useAnnotationToolState({
        pdfDocument: documentSession.pdfDocument,
        annotationUiManager,
        currentPage: viewport.currentPage,
        annotationTool: options.annotationTool,
        annotationKeepActive: options.annotationKeepActive,
        annotationSettings: options.annotationSettings,
        numPages: documentSession.numPages,
        getEditorIdentity: identity.getEditorIdentity,
        getCanonicalMarkupSubtypes: () => annotationApplication.value.store.markupSubtypesByExternalId(),
        recordCanonicalMarkupSubtype: (externalIds, subtype) =>
            annotationApplication.value.store.setPendingMarkupSubtype(externalIds, subtype),
        resolveCanonicalMarkupSubtype: externalIds =>
            annotationApplication.value.store.resolveMarkupSubtype(externalIds),
        forgetCanonicalMarkupSubtypeIntents: externalIds =>
            annotationApplication.value.store.forgetPendingMarkupSubtypes(externalIds),
        clearCanonicalMarkupSubtypeIntents: () =>
            annotationApplication.value.store.clearPendingMarkupSubtypes(),
        getFreeTextResize: () => freeTextResize,
        emitAnnotationToolAutoReset: options.emitAnnotationToolAutoReset,
    });
    const textMarkupPresentation = useTextMarkupPresentationController({
        annotationCommentsCache,
        annotationSettings: options.annotationSettings,
        clearEditorPresentation: toolState.clearMarkupSubtypeEditorPresentation,
        effectiveScale: viewport.scale.effectiveScale,
        isActive: options.isActive,
        presentEditor: toolState.presentMarkupSubtypeEditor,
        readEditorPresentation: toolState.readMarkupSubtypeEditorPresentation,
        resetEditorPresentation: toolState.resetMarkupSubtypeEditorPresentation,
        viewerContainer: options.viewerContainer,
    });
    const {
        markersByPage,
        inlineIndicators,
    } = useAnnotationMarkerViewModel({
        viewerContainer: options.viewerContainer,
        annotationCommentsCache,
        activeCommentStableKey,
        markerGeometryVersion: rendering.renderedPageStateVersion,
        labels: {
            annotation: t('annotations.annotationLabel'),
            note: t('annotations.stickyNoteLabel'),
            moreNotes: count => t('annotations.moreNotes', { count }),
        },
    });
    const commentSync = useAnnotationSync({
        pdfDocument: documentSession.pdfDocument,
        documentIdentity: annotationSnapshotDocumentIdentity,
        documentRevisionToken: options.documentRevisionToken,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        annotationUiManager,
        authorName: options.authorName,
        getIdentity: () => identity,
        getMarkupSubtype: () => toolState,
        getStore: () => ({
            setAnnotations: (comments, syncOptions) => {
                // Store reconciliation is deliberately synchronous. PDF.js and
                // retry projections only observe the resulting canonical snapshot.
                annotationApplication.value.reconcileLegacySummaries(comments, syncOptions);
                return annotationProjection.value.map(comment => ({...comment}));
            },
            setLinkAnnotations: links => {
                linkAnnotations.value = links;
            },
            setActiveKey: (key) => {
                const comment = key
                    ? annotationCommentsCache.value.find(candidate => candidate.stableKey === key)
                    : null;
                activeCommentStableKey.value = comment ? annotationIdForSummary(comment) : null;
            },
            setInventoryCompleteness: (completeness) => {
                options.emitAnnotationInventory(completeness);
            },
        }),
        syncInlineCommentIndicators: inlineIndicators.syncInlineCommentIndicators,
        textMarkupPresentation,
        getAnnotationNameReadLimits: () => {
            const policy = resolveOpenPathSecondaryPerformancePolicy(getPerformanceProfile());
            return {
                eagerMaxBytes: policy.eagerAnnotationNameReadMaxBytes,
                interactiveMaxBytes: policy.interactiveAnnotationNameReadMaxBytes,
            };
        },
        getPdfSourceByteSize: () => {
            const source = options.src.value;
            return typeof Blob !== 'undefined' && source instanceof Blob
                ? source.size
                : source && 'size' in source
                    ? source.size
                    : null;
        },
        isPdfSourceBlob: () => typeof Blob !== 'undefined' && options.src.value instanceof Blob,
    });
    watch(
        commentSync.annotationEnrichmentState,
        state => options.emitAnnotationEnrichmentState(state),
        {immediate: true},
    );
    function emitAnnotationOpenNoteWithReconciliation(comment: IAnnotationCommentSummary) {
        void commentSync.ensurePdfAnnotationNameReconciliation('annotations-ui-open');
        const noteComment = annotationCommentModel.withTransientNoteCreationTimestamp(comment);
        annotationCommentModel.upsertComment(noteComment);
        const canonicalAnnotationId = annotationApplication.value.annotationIdForSummary(noteComment);
        const canonicalNoteComment = canonicalAnnotationId
            ? annotationProjection.value.find(candidate => candidate.appAnnotationId === canonicalAnnotationId)
            : null;
        options.emitAnnotationOpenNote(canonicalNoteComment ?? noteComment);
    }
    const bridge = useAnnotationEditorBridge({
        viewerContainer: options.viewerContainer,
        pdfDocument: documentSession.pdfDocument,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        effectiveScale: viewport.scale.effectiveScale,
        annotationTool: options.annotationTool,
        annotationUiManager,
        annotationL10n,
        getIdentity: () => identity,
        getCommentSync: () => commentSync,
        getToolManager: () => toolState,
        getMarkupSubtype: () => toolState,
        getFreeTextResize: () => freeTextResize,
        emitAnnotationModified: options.emitAnnotationModified,
        emitAnnotationState: (patch) => {
            pdfjsAnnotationEditorState.value = {
                ...pdfjsAnnotationEditorState.value,
                ...patch,
            };
            appAnnotationHistory.emitCombinedState();
        },
        recordPdfjsExecutorCommand: command => appAnnotationHistory.registerExecutorCommand(command),
        isPdfjsHistoryRouted: () => appAnnotationHistory.isRoutingPdfjsHistory(),
        routeAnnotationHistoryUndo: () => appAnnotationHistory.undo(),
        routeAnnotationHistoryRedo: () => appAnnotationHistory.redo(),
        emitAnnotationOpenNote: emitAnnotationOpenNoteWithReconciliation,
        textMarkupPresentation,
    });
    const editor = {
        ...bridge,
        markupSubtype: toolState,
        toolManager: toolState,
        freeTextResize,
        setAnnotationTool: toolState.setAnnotationTool,
        applyAnnotationSettings: toolState.applyAnnotationSettings,
        updateModeWithRetry: toolState.updateModeWithRetry,
        getMarkupSubtypeOverrides: toolState.getMarkupSubtypeOverrides,
        getMarkupSubtypeHints: toolState.getMarkupSubtypeHints,
        ensureFreeTextEditorCanResize: freeTextResize.ensureFreeTextEditorCanResize,
    };
    function selectionMarkupStyle(subtype: TMarkupSubtype) {
        const settings = options.annotationSettings.value;
        if (!settings) {
            return {
                color: null,
                opacity: null,
            };
        }
        switch (subtype) {
            case 'Underline':
                return {
                    color: settings.underlineColor,
                    opacity: settings.underlineOpacity,
                };
            case 'StrikeOut':
                return {
                    color: settings.strikethroughColor,
                    opacity: settings.strikethroughOpacity,
                };
            case 'Squiggly':
                return {
                    color: settings.squigglyColor,
                    opacity: settings.squigglyOpacity,
                };
            case 'Highlight':
                return {
                    color: settings.highlightColor,
                    opacity: settings.highlightOpacity,
                };
        }
    }
    function canonicalComment(application: AnnotationApplication, annotationId: string) {
        const comment = application.listCommentSummaries().find(candidate => (
            candidate.appAnnotationId === annotationId
        ));
        if (!comment) {
            throw new Error(`Canonical annotation ${annotationId} has no comment projection`);
        }
        return comment;
    }
    const highlightIntentSink: Parameters<typeof useAnnotationHighlight>[0]['annotationIntentSink'] = {
        submitSelectionMarkupIntent: (input) => {
            const application = annotationApplication.value;
            const normalizedAuthor = options.authorName.value?.trim();
            const author = normalizedAuthor?.length ? normalizedAuthor : null;
            const subtype = input.requestedSubtype
                ?? toolState.toolToMarkupSubtype[options.annotationTool.value]
                ?? 'Highlight';
            const resolvedCandidates = (subtype === 'Highlight' ? [] : input.observedEditors)
                .filter(candidate => candidate.subtype === subtype)
                .flatMap((candidate) => {
                    let annotationId = application.annotationIdForSummary(candidate.summary);
                    if (!annotationId) {
                        application.ingestLegacySummaries([candidate.summary]);
                        annotationId = application.annotationIdForSummary(candidate.summary);
                    }
                    return annotationId
                        ? [{
                            annotationId,
                            sourceStableKey: candidate.summary.stableKey,
                            observedGeometry: candidate.geometry,
                        }]
                        : [];
                });
            const now = Date.now();
            const style = selectionMarkupStyle(subtype);
            const projection = application.store.applyTextMarkupSelection({
                kind: 'text-markup',
                identity: {id: mintAnnotationId()},
                pageIndex: input.pageIndex,
                subtype,
                text: '',
                geometry: input.geometry,
                color: style.color,
                opacity: style.opacity,
                author,
                createdAt: now,
                modifiedAt: now,
                revision: 0,
                persistedRevision: -1,
                deleted: false,
            }, resolvedCandidates);
            return {
                annotationId: projection.created.identity.id,
                subtype,
                comment: canonicalComment(application, projection.created.identity.id),
                replacements: projection.replacements.flatMap((replacement) => {
                    const source = resolvedCandidates.find(candidate => (
                        candidate.annotationId === replacement.annotationId
                    ));
                    return source
                        ? [{
                            ...replacement,
                            sourceStableKey: source.sourceStableKey,
                        }]
                        : [];
                }),
            };
        },
        submitStickyNoteIntent: (input) => {
            const application = annotationApplication.value;
            const normalizedAuthor = options.authorName.value?.trim();
            const author = normalizedAuthor?.length ? normalizedAuthor : null;
            const now = Date.now();
            const created = application.store.createStickyNote({
                kind: 'sticky-note',
                identity: {id: mintAnnotationId()},
                pageIndex: input.pageIndex,
                text: '',
                anchor: input.anchor,
                color: options.annotationSettings.value?.textColor ?? null,
                author,
                createdAt: now,
                modifiedAt: now,
                revision: 0,
                persistedRevision: -1,
                deleted: false,
            });
            return {
                annotationId: created.identity.id,
                comment: canonicalComment(application, created.identity.id),
            };
        },
        bindProjectedEditorIdentity: (annotationId: string, summary: IAnnotationCommentSummary) => {
            const application = annotationApplication.value;
            const canonicalId = asAnnotationId(annotationId);
            const entity = application.store.get(canonicalId);
            if (!entity) {
                return;
            }
            application.store.bindIdentity({
                annotationId: canonicalId,
                expectedRevision: entity.revision,
                bindings: {
                    ...(summary.annotationId ? {pdfRef: summary.annotationId} : {}),
                    ...(summary.annotationName ? {pdfName: summary.annotationName} : {}),
                    ...(summary.uid ? {pdfjsUid: summary.uid} : {}),
                    ...(summary.id ? {elementId: summary.id} : {}),
                },
            });
        },
    };
    const highlight = useAnnotationHighlight({
        viewerContainer: options.viewerContainer,
        isActive: options.isActive,
        annotationUiManager,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        annotationTool: options.annotationTool,
        getIdentity: () => identity,
        getMarkupSubtype: () => toolState,
        getSync: () => commentSync,
        getToolManager: () => toolState,
        textMarkupPresentation,
        annotationIntentSink: highlightIntentSink,
        deferCreatedEditorUndoToStorage: true,
        stopDrag: options.stopDrag,
        emitAnnotationOpenNote: emitAnnotationOpenNoteWithReconciliation,
        emitAnnotationNotePlacementChange: options.emitAnnotationNotePlacementChange,
        ...(options.reportAnnotationFailure
            ? {reportAnnotationFailure: options.reportAnnotationFailure}
            : {}),
        ensureAnnotationEditorLayerReady: async (pageNumber) => {
            if (await rendering.renderAnnotationEditorLayerForPage(pageNumber)) {
                return;
            }
            await rendering.renderVisiblePages(
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
        },
    });
    const crud = useAnnotationCrud({
        viewerContainer: options.viewerContainer,
        pdfDocument: documentSession.pdfDocument,
        annotationUiManager,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        annotationTool: options.annotationTool,
        annotationCommentsCache,
        getIdentity: () => identity,
        getSync: () => commentSync,
        getFreeTextResize: () => freeTextResize,
        getToolManager: () => toolState,
        getInlineIndicators: () => inlineIndicators,
        getHighlight: () => highlight,
        textMarkupPresentation,
        scrollToPage: (pageNumber, scrollOptions) => viewport.singlePageScroll.scrollToPage(pageNumber, scrollOptions),
        renderVisiblePages: rendering.renderVisiblePages,
        updateVisibleRange: viewport.scroll.updateVisibleRange,
        emitAnnotationModified: options.emitAnnotationModified,
        emitAnnotationOpenNote: emitAnnotationOpenNoteWithReconciliation,
        emitAnnotationCommentClick: options.emitAnnotationCommentClick,
        emitAnnotationContextMenu: options.emitAnnotationContextMenu,
        emitAnnotationToolCancel: options.emitAnnotationToolCancel,
    });
    const annotations = {
        identity,
        editor,
        commentSync,
        inlineIndicators,
        markersByPage,
        linksByPage,
        highlight,
        crud,
    };
    appAnnotationHistory.setReplayEffect(() => {
        // A replay retires or restores canonical entities and their PDF.js
        // editors together. A comment sync that already scanned the editor
        // layer would apply that pre-replay view on top of the result and mint
        // an undone annotation back from the editor it no longer has, so its
        // outcome is dropped here; the resync below re-reads the settled layer.
        annotations.commentSync.discardInFlightSync();
        const manager = annotationUiManager.value;
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
    onScopeDispose(() => appAnnotationHistory.setReplayEffect(null));

    const highlightComposable = annotations.highlight;
    const commentCrud = annotations.crud;
    const annotationColorCommands = usePdfAnnotationColorCommands({
        pdfDocument: documentSession.pdfDocument,
        annotations,
        annotationCommentModel,
        emitForcedAnnotationMutation,
    });
    const {
        focusAnnotationComment,
        deleteAnnotationComment,
    } = usePdfAnnotationCommentActions({
        viewerContainer: options.viewerContainer,
        numPages: documentSession.numPages,
        activeCommentStableKey,
        annotationCommentsCache,
        annotationCommentModel,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
        commentCrud,
        scrollToPage: (pageNumber, scrollOptions) => viewport.singlePageScroll.scrollToPage(pageNumber, scrollOptions),
        updateVisibleRange: viewport.scroll.updateVisibleRange,
        renderVisiblePages: rendering.renderVisiblePages,
        emitForcedAnnotationMutation,
    });

    const annotationMutationService = useAnnotationMutationService({
        runHistoryTransaction: action => appAnnotationHistory.runTransaction(action),
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
        setCanonicalNoteText: (id, text) => {
            const entity = annotationApplication.value.store.get(id);
            if (entity && entity.kind !== 'shape' && entity.text !== normalizeAnnotationText(text)) {
                annotationApplication.value.store.setNoteText(id, text);
            }
        },
        deleteCanonicalAnnotation: id => {
            if (!annotationApplication.value.store.get(id)?.deleted) {
                annotationApplication.value.store.delete(id);
            }
        },
        setCanonicalColor: (id, color) => {
            const entity = annotationApplication.value.store.get(id);
            if (entity && entity.kind !== 'shape' && entity.color !== color) {
                annotationApplication.value.store.setStyle(id, {color});
            }
        },
        moveCanonicalAnchor: (id, rect) => {
            const entity = annotationApplication.value.store.get(id);
            if (
                entity?.kind === 'sticky-note'
                && (
                    entity.anchor.left !== rect.left
                    || entity.anchor.top !== rect.top
                    || entity.anchor.width !== rect.width
                    || entity.anchor.height !== rect.height
                )
            ) {
                annotationApplication.value.store.moveAnchor(id, rect);
            }
        },
    });
    annotationMutationVisualEffects = annotationMutationService.visualEffects;

    useAnnotationMutationVisualEffects({
        viewerContainer: options.viewerContainer,
        annotationCommentsCache,
        textMarkupPresentation,
        invalidatePages: rendering.invalidatePages,
        renderVisiblePages: rendering.renderVisiblePages,
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

    const canvasHiddenAnnotationIds = computed(() => collectEditedTextMarkupCanvasSuppressionIds(
        annotationCommentsCache.value,
        managedEmbeddedPdfShapes.renderHiddenEmbeddedAnnotationIds.value,
    ));
    const detachProjection = rendering.attachAnnotationProjection({
        annotationUiManager,
        annotationL10n,
        hiddenAnnotationIds: managedEmbeddedPdfShapes.renderHiddenEmbeddedAnnotationIds,
        canvasHiddenAnnotationIds,
        textMarkupPresentation,
        managedAnnotationIds: managedEmbeddedPdfShapes.managedEmbeddedAnnotationIds,
        replaceAnnotationUiManager: (manager) => {
            if (annotationUiManager.value === manager) {
                annotations.editor.initAnnotationEditor();
            }
        },
        pageCommitted: managedEmbeddedPdfShapes.syncAfterPageRendered,
    });
    const { scheduleSetAnnotationTool } = usePdfViewerAnnotationRuntimeBridge({
        isActive: options.isActive,
        currentPage: viewport.currentPage,
        effectiveScale: viewport.scale.effectiveScale,
        annotationTool: options.annotationTool,
        annotationCursorMode: options.annotationCursorMode,
        annotationSettings: options.annotationSettings,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        annotations,
    });
    function clearAnnotationProjectionState() {
        annotationCommentModel.clearProjection();
        activeCommentStableKey.value = null;
        options.emitAnnotationComments([]);
        options.emitAnnotationInventory(null);
    }
    watch(documentSession.pdfDocument, (document, previousDocument) => {
        if (previousDocument && !document) {
            annotations.editor.destroyAnnotationEditor();
            return;
        }
        if (document) {
            annotations.editor.initAnnotationEditor();
        }
    }, { flush: 'sync' });
    const unsubscribeDocumentTransitions = documentSession.subscribe((transition) => {
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.phase === 'invalidated') {
            annotations.commentSync.incrementSyncToken();
            annotations.highlight.clearSelectionCache();
            if (transition.reason === 'source-cleared' || transition.reason === 'empty-source') {
                clearAnnotationProjectionState();
            }
            return;
        }
        if (transition.phase === 'restore') {
            scheduleSetAnnotationTool(options.annotationTool.value, 'restore annotation tool after tab activation');
            annotations.editor.applyAnnotationSettings(options.annotationSettings.value);
            return;
        }
        if (transition.phase === 'settled') {
            annotations.commentSync.scheduleAnnotationCommentsSync();
            managedEmbeddedPdfShapes.settleViewerLoadSettledWithManagedShapes(
                transition.fence.loadToken,
                () => undefined,
            );
        }
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
        if (
            !options.isAnySaving.value
            && nextDocumentKey !== previousDocumentKey
        ) {
            appAnnotationHistory.clear();
        }
        options.clearPendingImagePlacement();
        handleSourceChanged(next, previous);
    });
    documentSession.registerDisposable(() => {
        unsubscribeDocumentTransitions();
        detachProjection();
        annotations.inlineIndicators.cleanup();
        annotations.highlight.clearSelectionCache();
        annotations.editor.destroyAnnotationEditor();
        clearAnnotationProjectionState();
    });
    onMounted(() => {
        annotations.inlineIndicators.attachInlineCommentMarkerObserver();
    });
    const saveTransaction = usePdfViewerSaveTransaction({
        pdfDocument: documentSession.pdfDocument,
        annotationUiManager,
        annotationApplication,
        documentRevisionToken: options.documentRevisionToken,
        documentSession,
        flushAnnotationMutationsForSave: annotationMutationService.flushForSave,
        getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
        getMarkupSubtypeHints: annotations.editor.getMarkupSubtypeHints,
        getAllShapes: shapeComposable.getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys,
        ensureManagedShapeBaselineReady: managedEmbeddedPdfShapes.ensureManagedShapeBaselineReady,
    });

    return {
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
        adoptPersistedManagedShapesOnNextImport: () => annotationApplication.value.store.adoptPersistedShapesOnNextImport(),
        clearPendingManagedShapeImportAdoption: () => annotationApplication.value.store.clearPendingShapeImportAdoption(),
        ensureManagedShapeBaselineReady: managedEmbeddedPdfShapes.ensureManagedShapeBaselineReady,
        preparePersistedManagedShapesForSave: managedEmbeddedPdfShapes.preparePersistedManagedShapesForSave,
        restorePreparedManagedShapesAfterFailedSave: managedEmbeddedPdfShapes.restorePreparedManagedShapesAfterFailedSave,
        highlightComposable,
        commentCrud,
        markersByPage: annotations.markersByPage,
        linksByPage: annotations.linksByPage,
        registerShapeHistoryCommand,
        handleSourceChanged,
        annotationUiManager,
        annotationL10n,
        appAnnotationHistory,
        pdfjsAnnotationEditorState,
        canvasHiddenAnnotationIds,
        scheduleSetAnnotationTool,
        ...saveTransaction,
        ...portalHandlers,
    };
};

export type TPdfAnnotationSession = ReturnType<typeof createPdfAnnotationSession>;
