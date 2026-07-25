import type {
    ComputedRef,
    Ref,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { uniq } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import {
    resolvePdfViewerSaveTransactionFinalBytes,
    type IPdfPageRasterScheduler,
    useOcrTextContent,
    usePageContextMenu,
    usePdfHistory,
} from '@app/modules/pdf-viewer/public';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';
import {deleteAnnotationById} from '@app/modules/workspace-shell/annotations/deleteAnnotationById';
import { usePageSaveOrchestration } from '@app/modules/workspace-shell/composables/usePageSaveOrchestration';
import { useShutdownSaveFlushReporting } from '@app/modules/workspace-shell/composables/useShutdownSaveFlushReporting';
import { useWorkspaceDocumentControls } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentControls';
import { useWorkspaceDocumentLifecycleEffects } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects';
import { useWorkspaceExport } from '@app/modules/workspace-shell/composables/useWorkspaceExport';
import { useWorkspaceInteractionControls } from '@app/modules/workspace-shell/composables/useWorkspaceInteractionControls';
import { useWorkspaceFileLifecycleController } from '@app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController';
import { useWorkspaceSidebarSearchSyncController } from '@app/modules/workspace-shell/composables/useWorkspaceSidebarSearchSyncController';
import { useWorkspaceAnnotationSession } from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { getDocumentPdfCapability } from '@app/utils/platformDocuments';
import { useWorkspaceViewState } from '@app/modules/workspace-shell/composables/useWorkspaceViewState';
import { useDocxExport } from '@app/composables/useDocxExport';
import { useWorkspacePrint } from '@app/modules/workspace-shell/composables/useWorkspacePrint';
import { useMetadataSession } from '@app/modules/workspace-shell/composables/useMetadataSession';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createPageMutationAnnotationMaterializer } from '@app/modules/workspace-shell/composables/createPageMutationAnnotationMaterializer';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import {
    useWorkspaceDocumentDriver,
    useWorkspaceDocumentDriverBinding,
    type IWorkspaceDriverPrintRequest,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import type { IAnalyticsDocumentScope } from '@app/composables/useAnalytics';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type {
    IDocumentPageSource,
    IDocumentSourceCapabilities,
} from '@app/utils/document-viewer/source/documentPageSource';
import type { IDocumentSearchMatch } from '@app/utils/document-viewer/search/documentSearch';
import type { IPdfPageMatches } from '@app/types/pdfUi';
import { getErrorMessage } from '@app/utils/error';
import { createWorkspaceViewerUpdateHandlers } from '@app/modules/workspace-shell/viewers/createWorkspaceViewerUpdateHandlers';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

interface IWorkspaceOrchestrationDeps {
    analyticsDocumentScope: IAnalyticsDocumentScope;
    tabId: string;
    isActive: Ref<boolean>;
    documentSession: IWorkspaceDocumentController;
    initialViewState?: ITabViewSessionState | null;
    pendingDocumentPath?: TReadableRef<TDocumentRef | null> | undefined;
    pendingDocumentSize?: TReadableRef<number | null> | undefined;
    openSurface?: IDocumentOpenSurfaceSession | undefined;
    preserveInitialStateForFirstSource?: boolean | undefined;
    sourceCapabilities: Ref<IDocumentSourceCapabilities>;
    emit: {
        (e: 'open-in-new-tab', result: TDocumentRef | TOpenFileResult): void;
        (e: 'request-close-tab'): void;
        (e: 'open-settings'): void;
    };
}

type TReadableRef<T> = ComputedRef<T> | Ref<T>;
interface IWorkspaceDocumentViewBindingOptions {
    documentSourceCurrentResultIndex: TReadableRef<number>;
    documentSourceSearchResults: TReadableRef<readonly IDocumentSearchMatch[]>;
    isRenderActive: TReadableRef<boolean>;
    isWorkspaceLayoutResizing: TReadableRef<boolean>;
    navigationFeedbackPage: Ref<number | null>;
    onInitialVisualPending: () => void;
    onInitialVisualReady: () => void;
    onPageSourceUpdate: (source: IDocumentPageSource | null) => void;
}
interface IWorkspaceProjectionBindingOptions {
    pendingDocumentPath: Ref<TDocumentRef | null | undefined>;
    toolbarSnapshot: Ref<IWorkspaceToolbarSnapshot>;
    currentViewState: Ref<ITabViewSessionState | null | undefined>;
    formatPendingBatchLabel: (values: {
        processed: number;
        total: number;
    }) => string;
    publishRecord: (record: IWorkspaceDocumentRecord) => void;
}
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;

export const useWorkspaceOrchestration = (deps: IWorkspaceOrchestrationDeps) => {
    const {
        isActive,
        emit,
    } = deps;
    const { t } = useTypedI18n();

    const fileLifecycle = useWorkspaceFileLifecycleController({
        analyticsDocumentScope: deps.analyticsDocumentScope,
        openSurface: deps.openSurface,
    });
    const {
        isDjvuMode,
        djvuSourcePath,
        djvuSourceSizeBytes,
        loadRecentFiles,
        removeRecentFileIfMissing,
        pickFileToOpen,
        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,
        hasPdf,
        pdfSrc,
        pdfData,
        workingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
        originalPath,
        fileName,
        isDirty,
        pdfError,
        loadPdfFromPath,
        ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        readWorkingCopyBytes,
        saveFile,
        repairWorkingCopy,
        optimizeWorkingCopy,
        optimizeWorkingCopyAsCopy,
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        markDirty,
        setWorkspaceCommandSink,
    } = fileLifecycle;
    const documentDriver = useWorkspaceDocumentDriver({
        djvuSourcePath,
        isDjvuMode,
        pdfSrc,
        workingCopyPath,
        ...(deps.pendingDocumentPath === undefined
            ? {}
            : {pendingDocumentPath: deps.pendingDocumentPath}),
        ...(deps.pendingDocumentSize === undefined
            ? {}
            : {pendingDocumentSize: deps.pendingDocumentSize}),
    });
    watch(documentDriver.activeDocumentDriver, (driver) => {
        if (driver?.view.defaultSourceCapabilities) {
            deps.sourceCapabilities.value = driver.view.defaultSourceCapabilities;
        } else if (!driver) {
            deps.sourceCapabilities.value = {
                annotations: false,
                directImageExport: false,
                outline: false,
                pageEdits: false,
                search: false,
                text: false,
            };
        }
    }, {immediate: true});
    const sidebarSearch = useWorkspaceSidebarSearchSyncController({
        workingCopyPath,
        documentRevisionToken,
        ...(deps.initialViewState !== undefined ? { initialViewState: deps.initialViewState } : {}),
    });
    const pdfRasterScheduler = shallowRef<IPdfPageRasterScheduler | null>(null);
    const {
        pdfViewerRef,
        documentViewerRef,
        closeAllDropdowns,
        handleDropdownOpenChange,
        openDropdown,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        requestThumbnailInvalidation,
        zoom,
        effectiveZoom,
        zoomMode,
        fitMode,
        viewMode,
        currentPage,
        totalPages,
        pdfDocument,
        dragMode,
        continuousScroll,
        showSidebar,
        showSettings,
        sidebarTab,
        openSearch,
        openAnnotations,
        closeSearch,
        resetSearchCache,
    } = sidebarSearch;

    const { settings: appSettings } = useSettings();
    const isSaving = ref(false);
    const isSavingAs = ref(false);
    const isHistoryBusy = ref(false);
    const documentOperationLease = deps.documentSession.operationLease;
    const metadataSession = useMetadataSession({
        pdfDocument,
        totalPages,
        markDirty,
        setWorkspaceCommandSink,
    });
    const {
        pageLabelState,
        bookmarkState,
        clearPreservedSourceReloadMetadata,
        consumePreservedSourceReloadMetadata,
        preserveMetadataForNextSourceReload,
        workspaceUndoTimeline,
        workspaceCommandSink,
    } = metadataSession;
    watch(
        () => ({
            viewer: pdfViewerRef.value,
            setCommandSink: pdfViewerRef.value?.setWorkspaceCommandSink,
        }),
        (current, previous) => {
            const viewerTargetChanged = Boolean(
                previous?.viewer
                && (
                    previous.viewer !== current.viewer
                    || previous.setCommandSink !== current.setCommandSink
                ),
            );
            if (viewerTargetChanged) {
                previous?.setCommandSink?.(null);
                workspaceCommandSink.reset('annotation');
            }
            current.setCommandSink?.(workspaceCommandSink);
        },
        {
            flush: 'post',
            immediate: true,
        },
    );
    const {
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        markPageLabelsSaved,
        getPageLabelsRevision,
    } = pageLabelState;
    const {
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        markBookmarksSaved,
        getBookmarksRevision,
    } = bookmarkState;

    const pageContextMenuControls = usePageContextMenu();
    const {
        pageContextMenu,
        closePageContextMenu,
    } = pageContextMenuControls;

    const { clearCache: clearOcrCache } = useOcrTextContent();
    const {
        isExportingDocx: isDocxExporting,
        docxExportError,
        exportDocx,
        clearDocxExportError,
    } = useDocxExport();
    const isExportingDocx = computed(() => isDocxExporting.value);
    async function handleExportDocx(selectedLanguages?: string[]) {
        const exported = await exportDocx({
            workingCopyPath: workingCopyPath.value,
            documentRevisionToken: documentRevisionToken.value,
            pdfDocument: pdfDocument.value,
            ...(selectedLanguages === undefined ? {} : {selectedLanguages}),
        });
        if (!exported) {
            openDropdown('ocr');
        }
    }

    const annotationSession = useWorkspaceAnnotationSession({
        pdfViewerRef,
        pdfDocument,
        dragMode,
    });
    const {
        annotationContextMenu,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
        hasAnnotationChanges,
        hasLivePdfJsAnnotationChanges,
        hasSavedPdfJsAnnotationBaselineChanges,
        hasPreservedLivePdfjsAnnotationSession,
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        markAnnotationCommentsLoading,
        clearAnnotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationToolChange,
        handleAnnotationModified,
        markAnnotationSaved,
        getAnnotationSaveStateToken,
        resetAnnotationTracking,
        annotationNoteWindows,
        hasOpenAnnotationNotes,
        isAnyAnnotationNoteSaving,
        persistAllAnnotationNotes,
        closeAllAnnotationNotes,
        openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        isSameAnnotationComment,
        applyAnnotationComments: applyAnnotationCommentsFromSession,
    } = annotationSession;

    const pendingEmbeddedAnnotationDeleteCount = computed(() => {
        void annotationComments.value;
        return pdfViewerRef.value?.getDeletedPersistedCanonicalAnnotationCount?.() ?? 0;
    });
    const undoableOpenEmptyEditorNoteCount = computed(() => (
        annotationNoteWindows.value.some((note) => {
            const noteText = note.draftText;
            return note.source === 'editor'
                && note.hasNote
                && noteText.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim().length === 0;
        })
            ? 1
            : 0
    ));
    const appAnnotationUndoDepth = computed(() => (
        pendingEmbeddedAnnotationDeleteCount.value + undoableOpenEmptyEditorNoteCount.value
    ));
    const thumbnailHiddenAnnotationIds = computed<string[]>(() => {
        // Canonical projection updates invalidate this computed value while
        // tombstones provide the durable PDF identities that thumbnail
        // operator-list filtering needs.
        void annotationComments.value;
        return pdfViewerRef.value?.getDeletedCanonicalAnnotationIds?.() ?? [];
    });
    const preservedAnnotationSourceDirty = ref(false);

    function applyAnnotationComments(comments: IAnnotationCommentSummary[]) {
        applyAnnotationCommentsFromSession(comments);
    }

    function markPreservedAnnotationSourceDirty() {
        preservedAnnotationSourceDirty.value = true;
    }

    function setPreservedAnnotationSourceDirty(dirty: boolean) {
        preservedAnnotationSourceDirty.value = dirty;
    }

    function hasPreservedAnnotationSourceChanges(): boolean {
        return preservedAnnotationSourceDirty.value;
    }

    function markAnnotationSavedAndClearPreservedSource(opts?: { preserveLivePdfjsSession?: boolean }) {
        markAnnotationSaved(opts);
        preservedAnnotationSourceDirty.value = false;
    }

    function resetAnnotationTrackingAndPreservedSource() {
        preservedAnnotationSourceDirty.value = false;
        resetAnnotationTracking();
    }

    watch(workingCopyPath, () => {
        preservedAnnotationSourceDirty.value = false;
    });

    const hasReactiveAnnotationChanges = computed(() => {
        // Canonical annotation storage is intentionally framework-agnostic.
        // Sidebar projection events provide the reactive invalidation edge;
        // the viewer method remains the source of semantic dirty truth.
        void annotationComments.value;
        return hasAnnotationChanges();
    });
    const hasPendingUnsavedChanges = computed(() => (
        annotationDirty.value
        || isDirty.value
        || hasReactiveAnnotationChanges.value
        || hasSavedPdfJsAnnotationBaselineChanges()
        || pendingEmbeddedAnnotationDeleteCount.value > 0
        || preservedAnnotationSourceDirty.value
        || pageLabelsDirty.value
        || bookmarksDirty.value
    ));
    const hasPendingPrintSerializationChanges = computed(() => (
        annotationDirty.value
        || hasReactiveAnnotationChanges.value
        || pendingEmbeddedAnnotationDeleteCount.value > 0
        || preservedAnnotationSourceDirty.value
    ));
    const hasPendingTabChanges = hasPendingUnsavedChanges;
    const statusOriginalPath = computed(() => deps.pendingDocumentPath?.value ?? originalPath.value);
    const documentKey = computed(() => (
        documentRevisionInfo.value?.documentRef
        ?? originalPath.value
        ?? workingCopyPath.value
    ));

    const pageSaveOrchestration = usePageSaveOrchestration({
        pdfData,
        pdfDocument,
        pdfViewerRef,
        workingCopyPath,
        originalPath,
        documentRevisionToken,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        isSaving,
        isSavingAs,
        annotationDirty,
        annotationNoteWindowsCount: computed(() => annotationNoteWindows.value.length),
        pendingEmbeddedAnnotationDeleteCount,
        hasAnnotationChanges,
        hasLivePdfJsAnnotationChanges,
        hasSavedPdfJsAnnotationBaselineChanges,
        hasPreservedAnnotationSourceChanges,
        markAnnotationSaved: markAnnotationSavedAndClearPreservedSource,
        getAnnotationSaveStateToken,
        markPageLabelsSaved,
        getPageLabelsSaveStateToken: getPageLabelsRevision,
        markBookmarksSaved,
        getBookmarksSaveStateToken: getBookmarksRevision,
        preserveMetadataForNextSourceReload,
        clearPreservedSourceReloadMetadata,
        isDirty,
        hasPendingUnsavedChanges,
        validatePdfPath: path => getDocumentPdfCapability().validatePdfPath(path),
        saveFile,
        ...(repairWorkingCopy ? { repairWorkingCopy } : {}),
        ...(optimizeWorkingCopy ? { optimizeWorkingCopy } : {}),
        ...(optimizeWorkingCopyAsCopy ? { optimizeWorkingCopyAsCopy } : {}),
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        optimizePdfOnSaveAs: computed(() => appSettings.value.optimizePdfOnSaveAs),
        persistAllAnnotationNotes: (force) => persistAllAnnotationNotes(force),
        loadRecentFiles: () => {
            void loadRecentFiles();
        },
        currentPage,
        resetSearchCache,
        runWithDocumentOperationLease: documentOperationLease.runExclusive,
    });
    const {
        handleSave,
        isAnySaving,
        canSave,
        embedPlacedImageToPage,
        getSourcePdfData,
        serializePdfForSave,
        saveForExternalRead,
    } = pageSaveOrchestration;
    useShutdownSaveFlushReporting({
        workingCopyPath,
        hasPendingUnsavedChanges,
        saveForExternalRead,
    });

    async function ensureWorkingCopyFreshForRead() {
        if (!hasPendingUnsavedChanges.value) {
            return true;
        }
        return saveForExternalRead();
    }

    const exportControls = useWorkspaceExport({
        workingCopyPath,
        sourceKind: computed(() => documentDriver.activeDocumentDriver.value?.source.kind ?? 'pdf'),
        sourcePath: computed(() => (
            documentDriver.activeDocumentDriver.value?.source.path ?? workingCopyPath.value
        )),
        totalPages,
        ensureWorkingCopyFreshForRead,
    });
    const { handleExportImages } = exportControls;

    const programmaticPageNavigationTarget = ref<number | null>(null);
    const bookmarkNavigationIntentVersion = ref(0);

    function clearProgrammaticPageNavigationTarget(reason = 'clear') {
        logPdfRenderTrace('workspace-programmatic-page-navigation-cleared', {
            reason,
            targetPage: programmaticPageNavigationTarget.value,
        });
        programmaticPageNavigationTarget.value = null;
    }

    function beginProgrammaticPageNavigation(page: number) {
        const previousTargetPage = programmaticPageNavigationTarget.value;
        programmaticPageNavigationTarget.value = page;
        logPdfRenderTrace('workspace-programmatic-page-navigation-begin', {
            page,
            previousTargetPage,
            currentPage: currentPage.value,
        });
    }

    watch(totalPages, (pageCount) => {
        const requestedPage = programmaticPageNavigationTarget.value;
        if (requestedPage === null || pageCount <= 0) {
            return;
        }
        const clampedPage = clamp(Math.trunc(requestedPage), 1, Math.trunc(pageCount));
        if (clampedPage === requestedPage) {
            return;
        }
        logPdfRenderTrace('workspace-programmatic-page-navigation-metadata-clamp', {
            requestedPage,
            clampedPage,
            pageCount,
        });
        programmaticPageNavigationTarget.value = clampedPage;
    }, {flush: 'sync'});

    function invalidateBookmarkNavigationRequests() {
        bookmarkNavigationIntentVersion.value += 1;
        logPdfRenderTrace('workspace-bookmark-navigation-invalidated', {
            version: bookmarkNavigationIntentVersion.value,
            currentPage: currentPage.value,
            pendingProgrammaticPage: programmaticPageNavigationTarget.value,
        });
    }

    function settleProgrammaticPageNavigationTarget(page: number) {
        logPdfRenderTrace('workspace-programmatic-page-navigation-settle', {
            page,
            currentPage: currentPage.value,
        });
        if (programmaticPageNavigationTarget.value === page) {
            clearProgrammaticPageNavigationTarget('target-settled');
        }
    }

    function shouldAcceptViewerCurrentPageUpdate(page: number) {
        const targetPage = programmaticPageNavigationTarget.value;
        if (targetPage === null) {
            logPdfRenderTrace('workspace-viewer-current-page-update-accepted', {
                page,
                targetPage,
                currentPage: currentPage.value,
                reason: 'no-programmatic-target',
            });
            return true;
        }
        if (page !== targetPage) {
            logPdfRenderTrace('workspace-viewer-current-page-update-rejected', {
                page,
                targetPage,
                currentPage: currentPage.value,
                reason: 'target-pending',
            });
            return false;
        }
        logPdfRenderTrace('workspace-viewer-current-page-update-accepted', {
            page,
            targetPage,
            currentPage: currentPage.value,
            reason: 'target-caught-up',
        });
        settleProgrammaticPageNavigationTarget(page);
        return true;
    }

    // A failed open never reaches the pdfSrc transition that normally resets
    // navigation state, so a target set by early commands would contaminate
    // the next document and reject its legitimate page updates.
    watch(pdfError, (error) => {
        if (error && programmaticPageNavigationTarget.value !== null) {
            clearProgrammaticPageNavigationTarget('open-error');
        }
    });

    tryOnScopeDispose(clearProgrammaticPageNavigationTarget);

    const viewState = useWorkspaceViewState({
        fitMode,
        zoomMode,
        zoom,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
        annotationPlacingPageNote,
        annotationEditorState,
        hasLivePdfJsAnnotationChanges: computed(() => hasLivePdfJsAnnotationChanges()),
        appAnnotationUndoDepth,
        hasOpenAnnotationNotes,
        canUndoHistory: workspaceUndoTimeline.canUndoTimeline,
        canRedoHistory: workspaceUndoTimeline.canRedoTimeline,
        currentPage,
        totalPages,
        invalidateBookmarkNavigationRequests,
        beginProgrammaticPageNavigation,
        requestPageNavigation: page => deps.openSurface?.requestNavigation(page) ?? page,
        documentViewerRef,
    });
    const {
        canUndo,
        canRedo,
    } = viewState;

    const pdfHistory = usePdfHistory({
        pdfDocument,
        pdfViewerRef,
        currentPage,
        isAnySaving,
        isHistoryBusy,
        canUndo,
        canRedo,
        nextUndoSource: workspaceUndoTimeline.nextUndoSource,
        nextRedoSource: workspaceUndoTimeline.nextRedoSource,
        workingCopyPath,
        resetSearchCache,
        clearOcrCache: (path) => clearOcrCache(path),
        undoHistory: workspaceUndoTimeline.undoTimeline,
        redoHistory: workspaceUndoTimeline.redoTimeline,
    });
    const preparePdfReloadWaiter = pdfHistory.preparePdfReloadWaiter;
    const waitForPdfReload = pdfHistory.waitForPdfReload;
    const hasOpenDocument = computed(() => (
        hasPdf.value
        || (
            documentDriver.activeDocumentDriver.value?.capabilities.closeableDocument === true
            && documentDriver.activeDocumentDriver.value.source.path !== null
        )
    ));
    const canMutatePages = computed(() => deps.sourceCapabilities.value.pageEdits);
    const materializeAnnotationsForPageMutation = createPageMutationAnnotationMaterializer({
        annotationDirty,
        hasAnnotationChanges,
        hasLivePdfJsAnnotationChanges,
        hasSavedPdfJsAnnotationBaselineChanges,
        pendingEmbeddedAnnotationDeleteCount,
        preservedAnnotationSourceDirty,
        workingCopyPath,
        documentRevisionToken,
        pdfViewerRef,
        currentPage,
        waitForPdfReload,
        loadPdfFromData,
    });
    const annotationActions = usePageAnnotationActions({
        pdfViewerRef,
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationActiveCommentStableKey,
        annotationContextMenu,
        showSidebar,
        sidebarTab,
        dragMode,
        currentPage,
        workingCopyPath,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
        handleAnnotationToolChange,
        openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        isSameAnnotationComment,
        annotationNoteWindows,
        loadPdfFromData,
        waitForPdfReload,
        invalidateThumbnailPages: requestThumbnailInvalidation,
        markPreservedAnnotationSourceDirty,
        setPreservedAnnotationSourceDirty,
        getAnnotationCommentsSnapshot: () => annotationComments.value,
        getAnnotationCommentsStatusSnapshot: () => annotationCommentsStatus.value,
        getEmbeddedMutationBaseData: pageSaveOrchestration.getEmbeddedMutationBaseData,
        embedPlacedImageToPage,
        runWithDocumentOperationLease: documentOperationLease.runExclusive,
    });
    const {
        insertImageFromFileAt,
        pasteImageFromClipboardAt,
        shapePropertiesPopover,
        closeShapeProperties,
    } = annotationActions;

    async function handleUndo() {
        await pdfHistory.handleUndo();
    }

    function handleAnnotationModifiedWithThumbnailInvalidation(
        payload?: Parameters<typeof handleAnnotationModified>[0],
    ) {
        handleAnnotationModified(payload);
        if (
            hasPreservedLivePdfjsAnnotationSession()
            && (
                annotationDirty.value
                || hasAnnotationChanges()
                || hasLivePdfJsAnnotationChanges()
                || hasSavedPdfJsAnnotationBaselineChanges()
            )
        ) {
            markPreservedAnnotationSourceDirty();
        }
        requestThumbnailInvalidation([currentPage.value]);
    }

    const documentControls = useWorkspaceDocumentControls({
        hasDocument: hasOpenDocument,
        pdfData,
        pdfSrc,
        originalPath: statusOriginalPath,
        workingCopyPath,
        documentRevisionToken,
        pageLabels,
        bookmarkItems,
        currentPage,
        effectiveZoom,
        knownFileSizeBytes: djvuSourceSizeBytes,
        canSave,
        isAnySaving,
        isHistoryBusy,
        handleSave,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        requestThumbnailInvalidation,
        pdfViewerRef,
        canMutatePages,
        pageContextMenu,
        closePageContextMenu,
        handleExportImages,
        ensureHistoryBaselineForMutation,
        materializeAnnotationsForPageMutation,
        reloadWorkingCopyIntoHistory,
        preparePdfReloadWaiter,
        clearOcrCache: (path) => clearOcrCache(path),
        resetSearchCache,
        ensureWorkingCopyFreshForRead,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        isDocumentOperationInProgress: documentOperationLease.isBusy,
        runWithDocumentOperationLease: documentOperationLease.runExclusive,
        annotationNoteWindows,
        hasPendingUnsavedChanges,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        persistAllAnnotationNotes,
        pickFileToOpen,
        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,
        closeAllDropdowns,
        emitOpenInNewTab: (pathOrResult) => emit('open-in-new-tab', pathOrResult),
        removeRecentFileIfMissing,
    });

    async function getPrintableSourceData() {
        if (!hasPendingUnsavedChanges.value) {
            return pdfData.value ?? readWorkingCopyBytes();
        }

        const printTransaction = await pdfViewerRef.value?.runSaveTransaction({
            mode: 'print',
            forcePdfjsMaterialize: true,
            serializeResult: true,
            includeManagedShapes: true,
            rewriteShapeState: true,
            source: {
                getSourcePdfData,
                serializePdfForSave,
            },
        });
        return resolvePdfViewerSaveTransactionFinalBytes(printTransaction)
            ?? pdfData.value
            ?? await readWorkingCopyBytes();
    }

    async function ensurePrintReady() {
        if (!hasOpenAnnotationNotes.value) {
            return true;
        }
        return persistAllAnnotationNotes(true);
    }
    async function getQuickPrintPageMetrics() {
        const viewer = pdfViewerRef.value;
        const total = totalPages.value;
        if (!viewer || total <= 0) {
            return null;
        }
        const samplePages = uniq([
            1,
            clamp(currentPage.value, 1, total),
            Math.max(1, Math.ceil(total / 2)),
            total,
        ]).sort((left, right) => left - right);
        for (const pageNumber of samplePages) {
            await viewer.ensurePageMetricsInRange?.(pageNumber, pageNumber);
        }
        const metrics = viewer.getPageMetricsSnapshot?.() ?? [];
        const sampledMetrics = samplePages.flatMap((pageNumber) => {
            const metric = metrics[pageNumber - 1] ?? null;
            if (
                typeof metric?.width === 'number'
                && Number.isFinite(metric.width)
                && metric.width > 0
                && typeof metric.height === 'number'
                && Number.isFinite(metric.height)
                && metric.height > 0
            ) {
                return [metric];
            }
            return [];
        });
        return sampledMetrics.length === samplePages.length ? sampledMetrics : null;
    }
    async function renderLoadedPdfPagesForBrowserPrint(
        targetDocument: IBrowserPrintDocument,
        pageNumbers: number[],
        options?: { signal?: AbortSignal },
    ) {
        const viewer = pdfViewerRef.value;
        if (!viewer?.renderLoadedPdfPagesForBrowserPrint) {
            throw new Error('Loaded PDF printing is unavailable');
        }
        await viewer.renderLoadedPdfPagesForBrowserPrint(targetDocument, pageNumbers, options);
    }
    async function printDriverSource(
        payload: IWorkspaceDriverPrintRequest,
        options?: {
            onNativePrintHandoffStart?: () => void;
            signal?: AbortSignal;
        },
    ) {
        const driver = documentDriver.activeDocumentDriver.value;
        if (!driver) {
            throw new Error('DjVu printing is unavailable');
        }
        const result = await driver.run({
            kind: 'prepare-print',
            request: payload,
            fileName: fileName.value,
            sourceCapabilities: deps.sourceCapabilities.value,
            ...(options?.onNativePrintHandoffStart === undefined
                ? {}
                : {onNativePrintHandoffStart: options.onNativePrintHandoffStart}),
            ...(options?.signal === undefined ? {} : {signal: options.signal}),
        });
        if (result.status === 'unavailable') {
            throw new Error('DjVu printing is unavailable');
        }
    }
    const workspacePrint = useWorkspacePrint({
        totalPages,
        currentPage,
        selectedPages: selectedThumbnailPages,
        sourcePdf: pdfSrc,
        workingCopyPath,
        fileName,
        hasPendingUnsavedChanges,
        hasPendingPrintSerializationChanges,
        canPrintDjvuSource: computed(() => (
            documentDriver.activeDocumentDriver.value?.canPreparePrint === true
        )),
        getCurrentPrintPage: () => documentViewerRef.value?.getCurrentPage?.() ?? currentPage.value,
        getQuickPrintPageMetrics,
        ensurePrintReady,
        getPrintableSourceData,
        renderLoadedPdfPagesForBrowserPrint,
        printDjvuSource: printDriverSource,
    });
    const interactionControls = useWorkspaceInteractionControls({
        isActive,
        appSettings,
        annotationSettings,
        viewMode,
        continuousScroll,
        fitMode,
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
        canPrint: computed(() => (
            documentDriver.activeDocumentDriver.value?.capabilities.print === true
            && (hasPdf.value || deps.sourceCapabilities.value.directImageExport)
        )),
        canSave,
        showSettings,
        annotationTool,
        annotationPlacingPageNote,
        pdfViewerRef,
        documentViewerRef,
        serializePdfForSave,
        shapePropertiesPopoverVisible: computed(() => shapePropertiesPopover.value.visible),
        annotationContextMenuVisible: computed(() => annotationContextMenu.value.visible),
        pageContextMenuVisible: computed(() => pageContextMenu.value.visible),
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
        openAnnotations,
        handleAnnotationToolChange,
        handleSave,
        handlePrint: workspacePrint.handlePrint,
        handleToggleSidebar: () => {
            showSidebar.value = !showSidebar.value;
        },
        handleDropdownOpenChange,
        clearDocxExportError,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        currentPage,
        totalPages,
        fileName,
        originalPath,
        hasPendingTabChanges,
        pdfData,
        openFileWithViewerLifecycle,
        waitForPdfReload,
        loadPdfFromPath,
        preserveInitialStateForFirstSource: deps.preserveInitialStateForFirstSource,
        runWithDocumentOperationLease: documentOperationLease.runExclusive,
    });
    const {handleOcrComplete} = useWorkspaceDocumentLifecycleEffects({
        currentPage,
        totalPages,
        pdfDocument,
        pdfViewerRef,
        isDjvuMode,
        djvuSourcePath,
        showSettings,
        emitOpenSettings: () => emit('open-settings'),
        pdfSrc,
        workingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
        pdfError,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
        annotationComments,
        markAnnotationCommentsLoading,
        clearAnnotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationPlacingPageNote,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        consumePreservedSourceReloadMetadata,
        hasPendingProgrammaticPageNavigation: () => programmaticPageNavigationTarget.value !== null,
        clearProgrammaticPageNavigation: () => clearProgrammaticPageNavigationTarget('document-closed'),
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        resetAnnotationTracking: resetAnnotationTrackingAndPreservedSource,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles: () => {
            void loadRecentFiles();
        },
        clearOcrCache,
        ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory,
        waitForPdfReload,
        runWithDocumentOperationLease: documentOperationLease.runExclusive,
    });
    function bindDocumentView(options: IWorkspaceDocumentViewBindingOptions) {
        const hiddenSearchPageMatches = new Map<number, IPdfPageMatches>();
        const viewerSearchPageMatches = computed(() => (
            isActive.value && showSidebar.value
                ? sidebarSearch.pageMatches.value
                : hiddenSearchPageMatches
        ));
        const viewerCurrentSearchMatch = computed(() => (
            isActive.value && showSidebar.value
                ? sidebarSearch.currentResult.value
                : null
        ));
        const {
            handleCurrentPage,
            handleTotalPages,
        } = createWorkspaceViewerUpdateHandlers({
            analytics: deps.analyticsDocumentScope,
            tabId: deps.tabId,
            pdfSrc,
            currentPage,
            totalPages,
            showSidebar,
            sidebarTab,
            isLoading: sidebarSearch.isLoading,
            continuousScroll,
            fitMode,
            viewMode,
            zoom,
            viewerRef: documentViewerRef,
            shouldAcceptPage: shouldAcceptViewerCurrentPageUpdate,
        });
        function handleLoadError(error: unknown) {
            if (error === null || error === undefined) {
                pdfError.value = null;
                return;
            }
            const message = getErrorMessage(error).trim();
            pdfError.value = message || t('errors.file.open');
        }
        function handleAnnotationComments(comments: IAnnotationCommentSummary[]) {
            if (
                annotationCommentsStatus.value === 'loading'
                && annotationComments.value.length > 0
                && comments.length === 0
                && sidebarSearch.isLoading.value
            ) {
                return;
            }
            applyAnnotationComments(comments);
        }
        return useWorkspaceDocumentDriverBinding({
            activeDocumentDriver: documentDriver.mountedDocumentDriver,
            annotationCursorMode: viewState.annotationCursorMode,
            annotationKeepActive,
            annotationSettings,
            annotationTool,
            authorName: computed(() => appSettings.value.authorName),
            continuousScroll,
            currentResultNavigationId: sidebarSearch.currentResultNavigationId,
            currentSearchMatch: viewerCurrentSearchMatch,
            documentSourceCurrentResultIndex: options.documentSourceCurrentResultIndex,
            documentSourceSearchResults: options.documentSourceSearchResults,
            currentPage,
            dragMode,
            fitMode,
            isAnySaving,
            isRenderActive: options.isRenderActive,
            isWorkspaceLayoutResizing: options.isWorkspaceLayoutResizing,
            pageMatches: viewerSearchPageMatches,
            pdfReloadSrc: fileLifecycle.pdfReloadSrc,
            pdfRasterDisplayProfile: fileLifecycle.pdfRasterDisplayProfile,
            pdfSrc,
            ...(deps.pendingDocumentPath === undefined
                ? {}
                : {pendingDocumentPath: deps.pendingDocumentPath}),
            pdfViewerRef,
            nativePdfViewerRef: sidebarSearch.nativePdfViewerRef,
            djvuViewerRef: sidebarSearch.djvuViewerRef,
            sourcePdfData: pdfData,
            viewMode,
            workingCopyPath,
            originalPath,
            documentRevisionToken,
            zoom,
            zoomMode,
            onAnnotationCommentClick: annotationActions.handleAnnotationCommentClick,
            onAnnotationComments: handleAnnotationComments,
            onAnnotationContextMenu: annotationActions.handleViewerAnnotationContextMenu,
            onAnnotationModified: handleAnnotationModifiedWithThumbnailInvalidation,
            onAnnotationNotePlacementChange: value => { annotationPlacingPageNote.value = value; },
            onAnnotationOpenNote: annotationActions.handleOpenAnnotationNote,
            onAnnotationSetting: annotationSession.handleAnnotationSettingChange,
            onAnnotationState: annotationSession.handleAnnotationState,
            onAnnotationToolAutoReset: annotationSession.handleAnnotationToolAutoReset,
            onAnnotationToolCancel: annotationSession.handleAnnotationToolCancel,
            onCurrentPageUpdate: handleCurrentPage,
            onDocumentUpdate: value => { pdfDocument.value = value as typeof pdfDocument.value; },
            onRasterSchedulerUpdate: (scheduler) => {
                pdfRasterScheduler.value = scheduler;
            },
            onEffectiveZoomUpdate: value => { effectiveZoom.value = value; },
            onFitModeUpdate: value => { fitMode.value = value; },
            onImagePlacementFinalize: annotationActions.handleFinalizePlacedImage,
            onInitialVisualPending: options.onInitialVisualPending,
            onInitialVisualReady: options.onInitialVisualReady,
            onLoadError: handleLoadError,
            onLoading: value => { sidebarSearch.isLoading.value = value; },
            onNavigationFeedbackPageUpdate: (value) => {
                options.navigationFeedbackPage.value = value;
                if (value !== null) beginProgrammaticPageNavigation(value);
            },
            onShapeContextMenu: annotationActions.handleShapeContextMenu,
            onSourceCapabilitiesUpdate: (capabilities) => {
                if (documentDriver.activeDocumentDriver.value) {
                    deps.sourceCapabilities.value = capabilities;
                }
            },
            onPageSourceUpdate: options.onPageSourceUpdate,
            onTotalPagesUpdate: (value) => {
                if (documentDriver.activeDocumentDriver.value || value === 0) {
                    handleTotalPages(value);
                }
            },
            onZoomModeUpdate: value => { zoomMode.value = value; },
            onZoomUpdate: value => { zoom.value = value; },
        });
    }
    function bindWorkspaceProjection(options: IWorkspaceProjectionBindingOptions) {
        deps.documentSession.bindWorkspaceProjection({
            pendingDocumentPath: options.pendingDocumentPath,
            openBatchProgress: fileLifecycle.openBatchProgress,
            hasPdf,
            isDjvuMode,
            fileName,
            originalPath,
            documentIdentity: documentRevisionInfo,
            isDirty: hasPendingUnsavedChanges,
            djvuSourcePath,
            toolbarSnapshot: options.toolbarSnapshot,
            currentViewState: options.currentViewState,
            formatPendingBatchLabel: options.formatPendingBatchLabel,
            publishRecord: options.publishRecord,
        });
    }
    return {
        documentDriver: {
            ...documentDriver,
            bindView: bindDocumentView,
        },
        fileLifecycle: {
            ...fileLifecycle,
            bindWorkspaceProjection,
            documentKey,
        },
        viewerShell: {
            ...sidebarSearch,
            pdfRasterScheduler,
        },
        annotationSession: {
            ...annotationSession,
            ...annotationActions,
            handleDeleteAnnotationById: (annotationId: string) => deleteAnnotationById(
                annotationComments.value,
                annotationId,
                annotationActions.handleDeleteAnnotationComment,
            ),
            applyAnnotationComments,
            thumbnailHiddenAnnotationIds,
            handleInsertImageFromFile: () => insertImageFromFileAt(currentPage.value, 0.5, 0.5),
            handlePasteImageFromClipboard: () => pasteImageFromClipboardAt(currentPage.value, 0.5, 0.5),
            handleAnnotationModified: handleAnnotationModifiedWithThumbnailInvalidation,
            hasPreservedAnnotationSourceChanges,
            pendingEmbeddedAnnotationDeleteCount,
        },
        documentControls,
        exportWorkflow: exportControls,
        pageContextMenuControls,
        interactionControls,
        metadata: {
            ...pageLabelState,
            ...bookmarkState,
            bookmarkNavigationIntentVersion,
        },
        viewNavigation: {
            ...viewState,
            ...pdfHistory,
            handleUndo,
            beginProgrammaticPageNavigation,
            shouldAcceptViewerCurrentPageUpdate,
        },
        saveWorkflow: {
            ...pageSaveOrchestration,
            isSaving,
            isSavingAs,
            isHistoryBusy,
            docxExportError,
            hasPendingUnsavedChanges,
            handleExportDocx,
            handleOcrComplete,
            isExportingDocx,
        },
        printWorkflow: workspacePrint,
    };
};
export type TWorkspaceOrchestration = ReturnType<typeof useWorkspaceOrchestration>;
