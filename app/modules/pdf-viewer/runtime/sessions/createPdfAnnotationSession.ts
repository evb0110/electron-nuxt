import type {
    ComputedRef,
    Ref,
} from 'vue';
import { useManagedEmbeddedPdfShapes } from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';
import {normalizePdfJsAnnotationId} from '@app/utils/pdfAnnotationRefs';
import { isImportedEmbeddedShapeSubtype } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/isImportedEmbeddedShapeSubtype';
import { shouldDemandManagedEmbeddedShapeBaseline } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-import-policy/shouldDemandManagedEmbeddedShapeBaseline';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {findUniqueAnnotationComment} from '@app/modules/pdf-viewer/runtime/annotations/findUniqueAnnotationComment';
import { usePdfAnnotationColorCommands } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';
import { usePdfAnnotationCommentActions } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentActions';
import { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/public';
import { useAnnotationMutationService } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationService';
import { usePdfViewerPortalAnnotationHandlers } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerPortalAnnotationHandlers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    IShapeAnnotation,
    IAnnotationMarkerRect,
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
import type {
    IPdfDocumentTransition,
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {commitPdfAnnotationParseToStore} from '@app/modules/pdf-viewer/runtime/sessions/commitPdfAnnotationParseToStore';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { TPdfRenderingSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type {
    IAnnotationCreationFailureReport,
    TAnnotationCreationFailureReason,
    TAnnotationCreationOutcome,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import {normalizeAnnotationText} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {getDocumentWorkingCopyCapability} from '@app/utils/platformDocuments';
import { groupBy } from 'es-toolkit/array';
import { useAnnotationMarkerViewModel } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMarkerViewModel';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import { collectLivePdfJsAnnotationChangeIds } from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';
import {
    annotationEditorSurfaceKey,
    usePdfAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import { clamp01 } from '@app/modules/pdf-viewer/engine/annotation-geometry/clamp01';
import { createPdfPagePointResolver } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/createPdfPagePointResolver';
import { useAnnotationTextSelectionCache } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationTextSelectionCache';
import { removeAnnotationCommentDom } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/removeAnnotationCommentDom';
import { createPdfAnnotationEditorCompatibility } from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationEditorCompatibility';
import { isSelectionMarkupTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionMarkupTool';
import {
    createAnnotationCreationFailureReporter,
    emitCanonicalAnnotationOpenNote,
    findCanonicalAnnotationComment,
    sameStringSet,
} from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationSessionHelpers';
import { createPdfAnnotationStampImageResolver } from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationStampImageResolver';
import { createPdfAnnotationOwnershipRefreshWatch } from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationOwnershipRefreshWatch';
import { buildRangeFromPageText } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPageText';
import type {
    ICreateTextMarkupFromTextOptions,
    ICreateTextMarkupFromTextResult,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
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

// Pathless sources are keyed by Blob instance because their metadata can collide.
// The `blob-instance:` prefix avoids collisions with file paths.
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

// The snapshot cache prefers original paths across working-copy rewrites.
// Canonical records must describe the bytes PDF.js currently holds.
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
    const storeOwnedPdfAnnotationIds = shallowRef<ReadonlySet<string>>(new Set());
    const resolveStampImage = createPdfAnnotationStampImageResolver(documentSession);
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
        storeOwnedAnnotationIds: storeOwnedPdfAnnotationIds,
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
    const canonicalMarkupSubtypeHints = new Map<string, TMarkupSubtype>();
    const annotationCommentModel = usePdfAnnotationCommentModel({
        isAnySaving: options.isAnySaving,
        annotationProjection,
        // PDF.js remains responsible for static rendering and links. The
        // writer parse above is the only document ingress into the canonical
        // store, so summary refreshes only return the current projection.
        ingestSummaries: () => undefined,
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
    function projectCanonicalAnnotations() {
        const nextStoreOwnedPdfAnnotationIds = new Set(
            annotationApplication.value.store
                .list({includeDeleted: true})
                .map(entity => normalizePdfJsAnnotationId(entity.identity.pdfRef))
                .filter((id): id is string => Boolean(id)),
        );
        if (!sameStringSet(storeOwnedPdfAnnotationIds.value, nextStoreOwnedPdfAnnotationIds)) {
            storeOwnedPdfAnnotationIds.value = nextStoreOwnedPdfAnnotationIds;
        }
        const projected = annotationApplication.value.listCommentSummaries();
        annotationProjection.value = projected.map(comment => Object.freeze({...comment}));
        deletedEmbeddedAnnotationIds.value = annotationApplication.value.deletedEmbeddedAnnotationIds();
        annotationCommentModel.emitCommentsForSidebar(projected);
    }
    let stopAnnotationApplicationProjection = annotationApplication.value.store.subscribe(projectCanonicalAnnotations);
    const annotationDocumentIdentity = computed(() => (
        resolveAnnotationStoreDocumentIdentity({
            workingCopyPath: options.workingCopyPath.value,
            source: options.src.value,
        })
    ));
    function resetAnnotationApplication(documentKey: string) {
        stopAnnotationApplicationProjection();
        canonicalMarkupSubtypeHints.clear();
        annotationCommentModel.clearProjection();
        annotationApplication.value = createAnnotationApplication(documentKey);
        stopAnnotationApplicationProjection = annotationApplication.value.store.subscribe(projectCanonicalAnnotations);
    }
    watch(annotationDocumentIdentity, resetAnnotationApplication, {immediate: true});
    // Canonical records describe the bytes PDF.js currently holds. Save and
    // file-history undo can rewrite the working copy in place and reload the
    // same path, so path-keyed identity cannot identify the loaded document or
    // preserve commands that invert edits. Reload clears the proxy before
    // publishing the next one, so the swap only affects the loaded document.
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
    const linkAnnotations = ref<ILinkAnnotation[]>([]);
    const linksByPage = computed<Record<number, ILinkAnnotation[]>>(() =>
        groupBy(linkAnnotations.value, link => link.pageNumber),
    );
    const annotationEnrichmentState = shallowRef<IAnnotationEnrichmentState>({
        status: 'enriched',
        reason: null,
        canRetry: false,
    });
    const commentSync = {
        annotationEnrichmentState,
        scheduleAnnotationCommentsSync: () => {
            annotationCommentModel.emitCommentsForSidebar(annotationProjection.value);
        },
        syncAnnotationComments: () => {
            annotationCommentModel.emitCommentsForSidebar(annotationProjection.value);
            return Promise.resolve();
        },
        flushEditorCommentsForSave: async () => {},
        ensurePdfAnnotationNameReconciliation: (
            _reason: 'annotations-ui-open' | 'existing-annotation-mutation',
        ) => Promise.resolve('already-reconciled' as const),
        incrementSyncToken: () => {},
        discardInFlightSync: () => {},
        clearSyncState: () => {},
        setActiveCommentStableKey: (key: string | null) => {
            activeCommentStableKey.value = key;
        },
    };
    watch(
        commentSync.annotationEnrichmentState,
        state => options.emitAnnotationEnrichmentState(state),
        { immediate: true },
    );
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

    const {
        editor,
        selectionMarkupStyle,
    } = createPdfAnnotationEditorCompatibility({
        annotationApplication,
        annotationSettings: options.annotationSettings,
        canonicalMarkupSubtypeHints,
    });
    function emitAnnotationOpenNoteWithReconciliation(comment: IAnnotationCommentSummary) {
        emitCanonicalAnnotationOpenNote({
            annotationApplication,
            annotationProjection,
            comment,
            emitAnnotationOpenNote: options.emitAnnotationOpenNote,
        });
    }
    const pagePointResolver = createPdfPagePointResolver({
        viewerContainer: options.viewerContainer,
        currentPage: viewport.currentPage,
    });
    const textSelectionCache = useAnnotationTextSelectionCache({
        viewerContainer: options.viewerContainer,
        currentPage: viewport.currentPage,
    });
    const annotationEditorSurface = usePdfAnnotationEditorSurface({
        annotationApplication,
        activeTool: options.annotationTool,
        settings: options.annotationSettings,
        resolveStampImage,
        emitAnnotationModified: options.emitAnnotationModified,
        emitOpenNote: entity => {
            if (entity.kind !== 'note') {
                return;
            }
            const comment = annotationProjection.value.find(candidate => (
                candidate.appAnnotationId === entity.identity.id
            ));
            if (comment) {
                emitAnnotationOpenNoteWithReconciliation(comment);
            }
        },
    });
    provide(annotationEditorSurfaceKey, annotationEditorSurface);
    function pageContainerForNumber(pageNumber: number) {
        return options.viewerContainer.value?.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        ) ?? null;
    }
    function markerRectFromClientRect(pageContainer: HTMLElement, clientRect: DOMRect) {
        const pageRect = pageContainer.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0 || clientRect.width <= 0 || clientRect.height <= 0) {
            return null;
        }
        return {
            left: clamp01((clientRect.left - pageRect.left) / pageRect.width),
            top: clamp01((clientRect.top - pageRect.top) / pageRect.height),
            width: clamp01(clientRect.width / pageRect.width),
            height: clamp01(clientRect.height / pageRect.height),
        } satisfies IAnnotationMarkerRect;
    }
    function resolveSelectionGeometry(range: Range) {
        const clientRects = Array.from(range.getClientRects?.() ?? []);
        const rects = clientRects.length > 0 ? clientRects : [range.getBoundingClientRect()];
        const byPage = new Map<number, IAnnotationMarkerRect[]>();
        rects.forEach((clientRect) => {
            const centerX = clientRect.left + clientRect.width / 2;
            const centerY = clientRect.top + clientRect.height / 2;
            const pageContainer = pagePointResolver.findPageContainerFromClientPoint(centerX, centerY);
            const pageNumber = pageContainer?.dataset.page ? Number(pageContainer.dataset.page) : null;
            const markerRect = pageContainer ? markerRectFromClientRect(pageContainer, clientRect) : null;
            if (!pageNumber || !markerRect) {
                return;
            }
            const pageRects = byPage.get(pageNumber);
            if (pageRects) {
                pageRects.push(markerRect);
            } else {
                byPage.set(pageNumber, [markerRect]);
            }
        });
        if (byPage.size !== 1) {
            return null;
        }
        const entry = [...byPage.entries()][0];
        return entry ? {
            pageNumber: entry[0],
            geometry: entry[1],
        } : null;
    }
    function subtypeForTool(tool: TAnnotationTool): TMarkupSubtype {
        switch (tool) {
            case 'underline':
                return 'Underline';
            case 'strikethrough':
                return 'StrikeOut';
            case 'squiggly':
                return 'Squiggly';
            case 'highlight':
            default:
                return 'Highlight';
        }
    }
    function createSelectionMarkup(range: Range, withNote: boolean, requestedSubtype?: TMarkupSubtype): TAnnotationCreationOutcome {
        const geometry = resolveSelectionGeometry(range);
        if (!geometry) {
            return {
                status: 'failed',
                reason: 'selection-spans-pages',
            };
        }
        const subtype = requestedSubtype ?? subtypeForTool(options.annotationTool.value);
        const style = selectionMarkupStyle(subtype);
        const created = annotationEditorSurface.createHighlightFromSelection(
            geometry.pageNumber - 1,
            geometry.geometry,
            {
                subtype,
                color: style.color,
                opacity: style.opacity,
                selectedText: range.toString(),
            },
        );
        annotationEditorSurface.select([created.identity.id]);
        options.emitAnnotationModified();
        if (withNote) {
            const comment = findCanonicalAnnotationComment(annotationApplication.value, created.identity.id);
            emitAnnotationOpenNoteWithReconciliation(comment);
        }
        return {
            status: 'created',
            annotationId: created.identity.id,
        };
    }
    const isPlacingComment = ref(false);
    const failCommentAtPoint = createAnnotationCreationFailureReporter(options.reportAnnotationFailure);
    function setCommentPlacement(active: boolean) {
        if (isPlacingComment.value === active) {
            return;
        }
        isPlacingComment.value = active;
        options.emitAnnotationNotePlacementChange(active);
    }
    async function commentAtPoint(
        pageNumber: number,
        pageX: number,
        pageY: number,
        _pointOptions: {preferTextAnchor?: boolean} = {},
    ): Promise<TAnnotationCreationOutcome> {
        await Promise.resolve();
        if (!options.viewerContainer.value) {
            return failCommentAtPoint('viewer-not-ready', pageNumber);
        }
        if (!pageContainerForNumber(pageNumber)) {
            return failCommentAtPoint('page-not-rendered', pageNumber);
        }
        const created = annotationEditorSurface.createNoteAt(
            Math.max(0, Math.trunc(pageNumber) - 1),
            {
                left: clamp01(pageX),
                top: clamp01(pageY),
                width: 0.018,
                height: 0.018,
            },
            {open: true},
        );
        annotationEditorSurface.select([created.identity.id]);
        options.emitAnnotationModified();
        const comment = findCanonicalAnnotationComment(annotationApplication.value, created.identity.id);
        emitAnnotationOpenNoteWithReconciliation(comment);
        setCommentPlacement(false);
        return {
            status: 'created',
            annotationId: created.identity.id,
        };
    }
    async function highlightSelectionInternal(withNote = false, explicitRange?: Range | null) {
        await Promise.resolve();
        const range = explicitRange ?? textSelectionCache.getSelectionRangeForCommentAction();
        if (!range) {
            return {
                status: 'failed',
                reason: 'no-selection',
            } as const;
        }
        return createSelectionMarkup(range, withNote);
    }
    async function highlightSelection() {
        return (await highlightSelectionInternal()).status === 'created';
    }
    async function commentSelection() {
        return (await highlightSelectionInternal(true)).status === 'created';
    }
    async function maybeApplySelectionMarkup(explicitRange: Range | null = null) {
        if (!isSelectionMarkupTool(options.annotationTool.value) || isPlacingComment.value) {
            return false;
        }
        return (await highlightSelectionInternal(false, explicitRange)).status === 'created';
    }
    async function createTextMarkupFromText(
        target: ICreateTextMarkupFromTextOptions,
    ): Promise<ICreateTextMarkupFromTextResult> {
        await Promise.resolve();
        const pageNumber = Number.isFinite(target.pageNumber)
            ? Math.max(1, Math.trunc(target.pageNumber))
            : viewport.currentPage.value;
        const requestedText = target.text.trim();
        const occurrence = typeof target.occurrence === 'number' && Number.isFinite(target.occurrence)
            ? Math.max(1, Math.trunc(target.occurrence))
            : 1;
        const subtype: ICreateTextMarkupFromTextResult['subtype'] = target.markup === 'underline'
            ? 'Underline'
            : target.markup === 'strikethrough'
                ? 'StrikeOut'
                : target.markup === 'squiggly'
                    ? 'Squiggly'
                    : 'Highlight';
        const result = (
            created: boolean,
            matchedText: string | null,
            reason?: string,
            failureReason?: TAnnotationCreationFailureReason,
        ) => ({
            created,
            pageNumber,
            requestedText,
            matchedText,
            occurrence,
            subtype,
            ...(reason ? {reason} : {}),
            ...(failureReason ? {failureReason} : {}),
        });
        if (!requestedText) {
            return result(false, null, 'Text is required.');
        }
        if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
            return result(false, null, `Page ${pageNumber} is outside the document.`);
        }
        const pageContainer = pageContainerForNumber(pageNumber);
        if (!pageContainer) {
            return result(false, null, `Page ${pageNumber} is not rendered.`);
        }
        const textLayer = pageContainer.querySelector<HTMLElement>('.text-layer, .textLayer');
        if (!textLayer) {
            return result(false, null, `Text was not found on page ${pageNumber}.`);
        }
        const match = buildRangeFromPageText(pageContainer, {
            text: requestedText,
            occurrence,
            caseSensitive: target.caseSensitive !== false,
            wholeWord: target.wholeWord,
        });
        if (!match) {
            return result(false, null, `Text was not found on page ${pageNumber}.`);
        }
        const outcome = createSelectionMarkup(match.range, target.withNote === true, subtype);
        if (outcome.status === 'failed') {
            return result(
                false,
                match.matchedText,
                'The selection spans more than one page.',
                outcome.reason,
            );
        }
        return result(true, match.matchedText);
    }
    async function placeCommentAtClientPoint(
        clientX: number,
        clientY: number,
        targetElement?: HTMLElement | null,
    ) {
        const target = pagePointResolver.resolvePagePointTarget(clientX, clientY, targetElement);
        if (!target) {
            return false;
        }
        const outcome = await commentAtPoint(target.pageNumber, target.pageX, target.pageY, {preferTextAnchor: false});
        return outcome.status === 'created';
    }
    function buildAnnotationContextMenuPayload(
        comment: IAnnotationCommentSummary | null,
        clientX: number,
        clientY: number,
    ): IAnnotationContextMenuPayload {
        const selectionRange = textSelectionCache.getSelectionRangeForCommentAction();
        const target = pagePointResolver.resolvePagePointTarget(clientX, clientY);
        return {
            comment,
            clientX,
            clientY,
            hasSelection: Boolean(selectionRange),
            selectionText: selectionRange?.toString() ?? '',
            pageNumber: target?.pageNumber ?? null,
            pageX: target?.pageX ?? null,
            pageY: target?.pageY ?? null,
        };
    }
    const highlight = {
        isPlacingComment,
        highlightSelection,
        commentSelection,
        createTextMarkupFromText,
        commentAtPoint,
        placeCommentAtClientPoint,
        startCommentPlacement: () => {
            options.stopDrag();
            setCommentPlacement(true);
        },
        cancelCommentPlacement: () => setCommentPlacement(false),
        maybeApplySelectionMarkup,
        buildAnnotationContextMenuPayload,
        resolvePagePointTarget: pagePointResolver.resolvePagePointTarget,
        findPageContainerFromClientPoint: pagePointResolver.findPageContainerFromClientPoint,
        clearSelectionCache: textSelectionCache.clearSelectionCache,
        highlightSelectionInternal,
    };
    function summaryFromTarget(target: EventTarget | null) {
        if (!(target instanceof Element)) {
            return null;
        }
        const id = target.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId;
        if (!id) {
            return null;
        }
        return annotationProjection.value.find(comment => comment.appAnnotationId === id)
            ?? annotationApplication.value.listCommentSummaries().find(comment => comment.appAnnotationId === id)
            ?? null;
    }
    function setActiveSummary(comment: IAnnotationCommentSummary | null) {
        activeCommentStableKey.value = comment?.stableKey ?? null;
        inlineIndicators.debouncedSyncInlineCommentIndicators();
    }
    const crud = {
        findEditorForComment: (_comment: IAnnotationCommentSummary) => null,
        findEditorByAnnotationElementId: (_pageIndex: number, _annotationId: string) => null,
        focusAnnotationComment: async (comment: IAnnotationCommentSummary) => {
            const id = annotationApplication.value.annotationIdForSummary(comment);
            if (id) {
                annotationEditorSurface.select([id]);
            }
            setActiveSummary(comment);
            viewport.singlePageScroll.scrollToPage(comment.pageNumber, {markerRect: comment.markerRect});
            await nextTick();
        },
        updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => {
            const id = annotationApplication.value.annotationIdForSummary(comment);
            const entity = id ? annotationApplication.value.store.get(id) : null;
            if (!id || !entity) {
                return false;
            }
            const normalizedText = normalizeAnnotationText(text);
            if (entity.kind === 'text-box') {
                return Boolean(annotationApplication.value.store.updateTextBox(id, {text: normalizedText}));
            }
            if (entity.kind === 'note') {
                return Boolean(annotationApplication.value.store.updateNote(id, {contents: normalizedText}));
            }
            if (entity.kind === 'text-markup') {
                return Boolean(annotationApplication.value.store.updateTextMarkup(id, {contents: normalizedText}));
            }
            return false;
        },
        deleteAnnotationComment: async (comment: IAnnotationCommentSummary) => {
            await Promise.resolve();
            const id = annotationApplication.value.annotationIdForSummary(comment);
            if (!id || !annotationApplication.value.store.get(id)) {
                return false;
            }
            annotationApplication.value.store.delete(id);
            options.emitAnnotationModified();
            return true;
        },
        handleAnnotationCommentClick: async (event: MouseEvent) => {
            await Promise.resolve();
            const comment = summaryFromTarget(event.target);
            if (!comment) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setActiveSummary(comment);
            options.emitAnnotationCommentClick(comment);
        },
        handleAnnotationEditorDblClick: (event: MouseEvent) => {
            const comment = summaryFromTarget(event.target);
            if (!comment) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setActiveSummary(comment);
            if (comment.subtype === 'Text' || comment.hasNote === true) {
                emitAnnotationOpenNoteWithReconciliation(comment);
            } else {
                options.emitAnnotationCommentClick(comment);
            }
        },
        handleAnnotationCommentContextMenu: (event: MouseEvent) => {
            const comment = summaryFromTarget(event.target);
            event.preventDefault();
            event.stopPropagation();
            setActiveSummary(comment);
            options.emitAnnotationContextMenu(buildAnnotationContextMenuPayload(comment, event.clientX, event.clientY));
        },
        findEditorFromTarget: (_target: EventTarget | null) => null,
        findEditorSummaryFromTarget: summaryFromTarget,
        findAnnotationSummaryFromTarget: summaryFromTarget,
        findAnnotationSummaryFromPoint: (_target: EventTarget | null, clientX: number, clientY: number) => {
            const element = document.elementFromPoint(clientX, clientY);
            return summaryFromTarget(element);
        },
        ensureEditorInteractionModeFromTarget: async () => {},
        resolveCommentFromIndicatorClickTarget: (target: EventTarget | null) => summaryFromTarget(target),
        clearSelection: annotationEditorSurface.clearSelection,
    };
    const annotations = {
        editor,
        commentSync,
        inlineIndicators,
        markersByPage,
        linksByPage,
        highlight,
        crud,
    };
    appAnnotationHistory.setReplayEffect(() => {
        annotations.commentSync.discardInFlightSync();
        annotations.commentSync.scheduleAnnotationCommentsSync();
    });
    onScopeDispose(() => {
        appAnnotationHistory.setReplayEffect(null);
    });
    const highlightComposable = annotations.highlight;
    const commentCrud = annotations.crud;
    const annotationColorCommands = usePdfAnnotationColorCommands({
        annotationApplication,
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
        removeAnnotationFromDom: (comment) => {
            const container = options.viewerContainer.value;
            if (!container) {
                return;
            }
            removeAnnotationCommentDom(container, comment);
            if (comment.pageNumber > 0) {
                rendering.invalidatePages([comment.pageNumber]);
            }
        },
        findAnnotationCommentByStableKey: stableKey => findUniqueAnnotationComment(
            annotationCommentsCache.value,
            comment => comment.stableKey === stableKey,
        ),
        clearPendingMarkerMoves: annotationCommentModel.clearPendingMarkerMoves,
        handleMarkerMove: annotationCommentModel.handleMarkerMove,
        findEditorForComment: commentCrud.findEditorForComment,
        markModified: emitForcedAnnotationMutation,
        flushAnnotationCommentsForSave: annotations.commentSync.flushEditorCommentsForSave,
        resolveCanonicalAnnotationId: comment => annotationApplication.value.annotationIdForSummary(comment),
        setCanonicalNoteText: (id, text) => {
            const entity = annotationApplication.value.store.get(id);
            if (!entity || entity.kind === 'shape' || entity.kind === 'placed-image') {
                return;
            }
            const normalizedText = normalizeAnnotationText(text);
            if (entity.kind === 'text-box' && entity.text !== normalizedText) {
                annotationApplication.value.store.updateTextBox(id, {text: normalizedText});
            } else if (entity.kind === 'note' && entity.contents !== normalizedText) {
                annotationApplication.value.store.updateNote(id, {contents: normalizedText});
            } else if (entity.kind === 'text-markup' && entity.contents !== normalizedText) {
                annotationApplication.value.store.updateTextMarkup(id, {contents: normalizedText});
            }
        },
        deleteCanonicalAnnotation: id => {
            if (!annotationApplication.value.store.get(id)?.deleted) {
                annotationApplication.value.store.delete(id);
            }
        },
        moveCanonicalAnchor: (id, rect) => {
            const entity = annotationApplication.value.store.get(id);
            if (!entity || (entity.kind !== 'note' && entity.kind !== 'text-box')) {
                return;
            }
            const previous = entity.kind === 'note' ? entity.position : entity.rect;
            if (
                previous.left === rect.left
                && previous.top === rect.top
                && previous.width === rect.width
                && previous.height === rect.height
            ) {
                return;
            }
            if (entity.kind === 'note') {
                annotationApplication.value.store.updateNote(id, {position: rect});
            } else {
                annotationApplication.value.store.updateTextBox(id, {rect});
            }
        },
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
    const canvasHiddenAnnotationIds = computed(() => new Set([
        ...storeOwnedPdfAnnotationIds.value,
        ...managedEmbeddedPdfShapes.renderHiddenEmbeddedAnnotationIds.value,
    ]));
    const annotationProjectionReady = ref(!(options.workingCopyPath.value && options.documentRevisionToken.value && documentSession.pdfDocument.value));
    const detachProjection = rendering.attachAnnotationProjection({
        hiddenAnnotationIds: managedEmbeddedPdfShapes.renderHiddenEmbeddedAnnotationIds,
        annotationProjectionReady,
        canvasHiddenAnnotationIds,
        pageCommitted: managedEmbeddedPdfShapes.syncAfterPageRendered,
    });
    const stopStoreOwnershipRefreshWatch = createPdfAnnotationOwnershipRefreshWatch({
        documentSession,
        viewport,
        rendering,
        storeOwnedPdfAnnotationIds,
        annotationProjectionReady,
        nextTick,
    });
    const scheduleSetAnnotationTool = (_tool: TAnnotationTool, _reason: string) => {};
    function clearAnnotationProjectionState() {
        annotationCommentModel.clearProjection();
        activeCommentStableKey.value = null;
        options.emitAnnotationComments([]);
        options.emitAnnotationInventory(null);
    }
    let writerParseRequest = 0;
    let writerParseAbortController: AbortController | null = null;
    function cancelWriterParse() {
        writerParseRequest += 1;
        writerParseAbortController?.abort();
        writerParseAbortController = null;
    }
    async function feedStoreFromWriterParse(transition: IPdfDocumentTransition) {
        const workingCopyPath = options.workingCopyPath.value;
        const expectedRevisionToken = options.documentRevisionToken.value;
        const isProvisionalRevisionFence = transition.fence.documentRevision?.startsWith('load:') ?? false;
        if (
            !workingCopyPath
            || !expectedRevisionToken
            || !documentSession.pdfDocument.value
            || (
                transition.fence.documentRevision !== expectedRevisionToken
                && !isProvisionalRevisionFence
            )
        ) {
            annotationProjectionReady.value = true;
            return;
        }
        writerParseAbortController?.abort();
        const request = ++writerParseRequest;
        const abortController = new AbortController();
        writerParseAbortController = abortController;
        const targetStore = annotationApplication.value.store;
        const targetStoreMutationEpoch = targetStore.mutationEpoch;
        try {
            const result = await getDocumentWorkingCopyCapability().parsePdfAnnotations(
                workingCopyPath,
                {
                    expectedDocumentRevisionToken: expectedRevisionToken,
                    signal: abortController.signal,
                },
            );
            commitPdfAnnotationParseToStore({
                result,
                request,
                currentRequest: writerParseRequest,
                isTransitionCurrent: () => transition.isCurrent(),
                targetStore,
                currentStore: annotationApplication.value.store,
                targetStoreMutationEpoch,
                workingCopyPath,
                currentWorkingCopyPath: options.workingCopyPath.value,
                expectedRevisionToken,
                currentRevisionToken: options.documentRevisionToken.value,
            });
        } catch (error) {
            if (!abortController.signal.aborted) {
                BrowserLogger.warn('annotations', 'Failed to import writer PDF annotations', error);
            }
        } finally {
            if (writerParseAbortController === abortController) {
                writerParseAbortController = null;
                // A failed or rejected parse must not leave the PDF.js layer
                // hidden forever. The current transition owns the fallback to
                // the embedded read-only annotations when no projection was
                // committed.
                if (request === writerParseRequest && transition.isCurrent()) {
                    annotationProjectionReady.value = true;
                }
            }
        }
    }
    const unsubscribeDocumentTransitions = documentSession.subscribe(async (transition) => {
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.phase === 'invalidated') {
            cancelWriterParse();
            annotationProjectionReady.value = true;
            annotations.commentSync.incrementSyncToken();
            annotations.highlight.clearSelectionCache();
            if (transition.reason === 'source-cleared' || transition.reason === 'empty-source') {
                clearAnnotationProjectionState();
            }
            return;
        }
        if (transition.phase === 'ready') {
            annotationProjectionReady.value = false;
            await feedStoreFromWriterParse(transition);
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
    watch(() => [
        options.workingCopyPath.value,
        options.documentRevisionToken.value,
        documentSession.pdfDocument.value,
    ] as const, (next, previous) => {
        if (next.some((value, index) => value !== previous[index])) {
            annotationProjectionReady.value = false;
            cancelWriterParse();
        }
    }, {flush: 'sync'});
    documentSession.registerDisposable(() => {
        cancelWriterParse();
        unsubscribeDocumentTransitions();
        stopStoreOwnershipRefreshWatch();
        detachProjection();
        annotations.inlineIndicators.cleanup();
        annotations.highlight.clearSelectionCache();
        clearAnnotationProjectionState();
    });
    onMounted(() => {
        annotations.inlineIndicators.attachInlineCommentMarkerObserver();
    });
    const saveTransaction = usePdfViewerSaveTransaction({
        pdfDocument: documentSession.pdfDocument,
        annotationApplication,
        documentRevisionToken: options.documentRevisionToken,
        documentSession,
        flushAnnotationMutationsForSave: annotationMutationService.flushForSave,
        commitPendingEditorDraftsForSave: annotations.editor.commitPendingFreeTextDraftsForSave,
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
            // Keep the framework dependency on the canonical projection.
            void annotationProjection.value;
            return annotationApplication.value.store.hasChangesSinceSavedBaseline();
        },
        hasCanonicalShapeChanges: () => {
            // Keep the framework dependency on the canonical projection.
            void annotationProjection.value;
            return annotationApplication.value.store.hasChangesSinceSavedBaseline('shape');
        },
        collectLiveAnnotationChanges: () => collectLivePdfJsAnnotationChangeIds(
            documentSession.pdfDocument.value,
            {annotationStore: annotationApplication.value.store},
        ),
        getDeletedCanonicalAnnotationIds: () => Array.from(new Set(
            annotationApplication.value.store
                .list({includeDeleted: true})
                .filter(entity => entity.deleted)
                .flatMap(entity => [
                    entity.identity.id,
                    entity.identity.pdfRef,
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
        hiddenEmbeddedAnnotationIds: managedEmbeddedPdfShapes.hiddenEmbeddedAnnotationIds,
        renderHiddenEmbeddedAnnotationIds: managedEmbeddedPdfShapes.renderHiddenEmbeddedAnnotationIds,
        adoptPersistedManagedShapesOnNextImport: () => undefined,
        clearPendingManagedShapeImportAdoption: () => undefined,
        ensureManagedShapeBaselineReady: managedEmbeddedPdfShapes.ensureManagedShapeBaselineReady,
        preparePersistedManagedShapesForSave: managedEmbeddedPdfShapes.preparePersistedManagedShapesForSave,
        restorePreparedManagedShapesAfterFailedSave: managedEmbeddedPdfShapes.restorePreparedManagedShapesAfterFailedSave,
        highlightComposable,
        commentCrud,
        markersByPage: annotations.markersByPage,
        linksByPage: annotations.linksByPage,
        annotationEditorSurface,
        registerShapeHistoryCommand,
        handleSourceChanged,
        appAnnotationHistory,
        pdfjsAnnotationEditorState,
        canvasHiddenAnnotationIds,
        scheduleSetAnnotationTool,
        ...saveTransaction,
        ...portalHandlers,
    };
};

export type TPdfAnnotationSession = ReturnType<typeof createPdfAnnotationSession>;
