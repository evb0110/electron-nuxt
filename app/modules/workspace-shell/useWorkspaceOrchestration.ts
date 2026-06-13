import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { uniq } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import {
    useOcrTextContent,
    usePageContextMenu,
    usePdfHistory,
    isNoteEligibleComment,
} from '@app/modules/pdf-viewer/public';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';
import { usePageSaveOrchestration } from '@app/modules/workspace-shell/composables/usePageSaveOrchestration';
import { useWorkspaceDocumentControls } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentControls';
import { useWorkspaceDocumentLifecycleEffects } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects';
import { useWorkspaceExport } from '@app/modules/workspace-shell/composables/useWorkspaceExport';
import { useWorkspaceInteractionControls } from '@app/modules/workspace-shell/composables/useWorkspaceInteractionControls';
import { useWorkspaceFileLifecycleController } from '@app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController';
import { useWorkspaceSidebarSearchSyncController } from '@app/modules/workspace-shell/composables/useWorkspaceSidebarSearchSyncController';
import { useWorkspaceAnnotationSession } from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import { mergeWorkspaceAnnotationComments } from '@app/modules/workspace-shell/annotations/mergeWorkspaceAnnotationComments';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { TTabUpdate } from '@app/types/tabs';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { useWorkspaceViewState } from '@app/modules/workspace-shell/composables/useWorkspaceViewState';
import { useDocxExport } from '@app/composables/useDocxExport';
import { useWorkspacePrint } from '@app/modules/workspace-shell/composables/useWorkspacePrint';
import { useMetadataSession } from '@app/modules/workspace-shell/composables/useMetadataSession';
import { useDocumentOperationLease } from '@app/modules/workspace-shell/composables/useDocumentOperationLease';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';

interface IWorkspaceOrchestrationDeps {
    isActive: Ref<boolean>;
    initialViewState?: ITabViewSessionState | null;
    emit: {
        (e: 'update-tab', updates: TTabUpdate): void;
        (e: 'open-in-new-tab', result: TDocumentRef | TOpenFileResult): void;
        (e: 'request-close-tab'): void;
        (e: 'open-settings'): void;
    };
}

const WORKSPACE_PAGE_NAVIGATION_LOCK_MS = 10_000;
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;

export const useWorkspaceOrchestration = (deps: IWorkspaceOrchestrationDeps) => {
    const {
        isActive,
        emit,
    } = deps;
    const { t } = useTypedI18n();

    const fileLifecycle = useWorkspaceFileLifecycleController();
    const {
        isDjvuMode,
        djvuSourcePath,
        openDjvuFile,
        loadRecentFiles,
        removeRecentFile,
        pickFileToOpen,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
        hasPdf,
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        isDirty,
        pdfError,
        pendingDjvu,
        openBatchProgress,
        loadPdfFromPath,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        readWorkingCopyBytes,
        closeFile,
        saveFile,
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        markDirty,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        undo,
        redo,
    } = fileLifecycle;
    const toast = useToast();
    function notifyMissingRecentFile(file: IRecentFile) {
        toast.add({
            color: 'error',
            title: t('errors.recent.notFoundTitle'),
            description: t('errors.recent.notFoundDescription', {name: file.fileName}),
        });
    }

    const sidebarSearch = useWorkspaceSidebarSearchSyncController({
        workingCopyPath,
        ...(deps.initialViewState !== undefined ? { initialViewState: deps.initialViewState } : {}),
    });
    const {
        pdfViewerRef,
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
        isLoading,
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
    const documentOperationLease = useDocumentOperationLease();

    const metadataSession = useMetadataSession({
        pdfDocument,
        totalPages,
        markDirty,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        undoFile: undo,
        redoFile: redo,
    });
    const {
        pageLabelState,
        bookmarkState,
        workspaceUndoTimeline,
    } = metadataSession;
    const {
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        markPageLabelsSaved,
    } = pageLabelState;
    const {
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        markBookmarksSaved,
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
        consumePendingEmbeddedTextUpdates,
        restorePendingEmbeddedTextUpdates,
        applyAnnotationComments: applyAnnotationCommentsFromSession,
    } = annotationSession;

    const pendingEmbeddedAnnotationDeletes = shallowRef(new Map<string, IAnnotationCommentSummary>());
    const pendingEmbeddedAnnotationDeleteCount = computed(() => pendingEmbeddedAnnotationDeletes.value.size);
    const nativeSavedFreeTextNoteStableKeys = shallowRef(new Set<string>());
    const undoableOpenEmptyEditorNoteCount = computed(() => (
        annotationNoteWindows.value.some((note) => {
            const comment = note.comment;
            const noteText = typeof note.text === 'string' ? note.text : comment.text;
            return comment.source === 'editor'
                && isNoteEligibleComment(comment)
                && noteText.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim().length === 0;
        })
            ? 1
            : 0
    ));
    const appAnnotationUndoDepth = computed(() => (
        pendingEmbeddedAnnotationDeleteCount.value + undoableOpenEmptyEditorNoteCount.value
    ));
    const thumbnailHiddenAnnotationIds = computed(() => {
        const ids = new Set<string>();
        pendingEmbeddedAnnotationDeletes.value.forEach((comment) => {
            const stableRef = comment.stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/iu)?.[1] ?? null;
            [
                comment.annotationId,
                comment.uid,
                comment.id,
                stableRef,
            ].forEach((candidate) => {
                const normalizedId = normalizePdfJsAnnotationId(candidate);
                if (normalizedId) {
                    ids.add(normalizedId);
                }
            });
        });
        return [...ids];
    });
    const preservedAnnotationSourceDirty = ref(false);

    function applyAnnotationComments(comments: IAnnotationCommentSummary[]) {
        applyAnnotationCommentsFromSession(mergeWorkspaceAnnotationComments({
            incomingComments: comments,
            previousComments: annotationComments.value,
            openNotes: annotationNoteWindows.value,
            isSameAnnotationComment,
        }));
    }

    function queuePendingEmbeddedAnnotationDelete(comment: IAnnotationCommentSummary) {
        pendingEmbeddedAnnotationDeletes.value = new Map([
            ...pendingEmbeddedAnnotationDeletes.value,
            [
                comment.stableKey,
                comment,
            ],
        ]);
    }

    function unqueuePendingEmbeddedAnnotationDelete(stableKey: string) {
        if (!pendingEmbeddedAnnotationDeletes.value.has(stableKey)) {
            return;
        }
        const nextDeletes = new Map(pendingEmbeddedAnnotationDeletes.value);
        nextDeletes.delete(stableKey);
        pendingEmbeddedAnnotationDeletes.value = nextDeletes;
    }

    function consumePendingEmbeddedAnnotationDeletes() {
        if (pendingEmbeddedAnnotationDeletes.value.size === 0) {
            return null;
        }

        const deletions = Array.from(pendingEmbeddedAnnotationDeletes.value.values());
        pendingEmbeddedAnnotationDeletes.value = new Map();
        return deletions;
    }

    function restorePendingEmbeddedAnnotationDeletes(deletions: IAnnotationCommentSummary[] | null | undefined) {
        if (!deletions?.length) {
            return;
        }
        pendingEmbeddedAnnotationDeletes.value = new Map([
            ...pendingEmbeddedAnnotationDeletes.value,
            ...deletions.map(comment => [
                comment.stableKey,
                comment,
            ] as const),
        ]);
    }

    function updateNativeSavedFreeTextNoteStableKeys(mutator: (stableKeys: Set<string>) => void) {
        const nextStableKeys = new Set(nativeSavedFreeTextNoteStableKeys.value);
        mutator(nextStableKeys);
        nativeSavedFreeTextNoteStableKeys.value = nextStableKeys;
    }

    function markNativeFreeTextNotesSaved(notes: Array<{ stableKey: string }>) {
        updateNativeSavedFreeTextNoteStableKeys((stableKeys) => {
            notes.forEach((note) => {
                const stableKey = note.stableKey.trim();
                if (stableKey) {
                    stableKeys.add(stableKey);
                }
            });
        });
    }

    function markNativeFreeTextNotesDeleted(deletes: Array<{ stableKey?: string | null }>) {
        updateNativeSavedFreeTextNoteStableKeys((stableKeys) => {
            deletes.forEach((deleteRequest) => {
                const stableKey = deleteRequest.stableKey?.trim();
                if (stableKey) {
                    stableKeys.delete(stableKey);
                }
            });
        });
    }

    function isNativeFreeTextNoteSaved(comment: IAnnotationCommentSummary) {
        const stableKey = comment.stableKey?.trim();
        return Boolean(stableKey && nativeSavedFreeTextNoteStableKeys.value.has(stableKey));
    }

    function markPreservedAnnotationSourceDirty() {
        preservedAnnotationSourceDirty.value = true;
    }

    function setPreservedAnnotationSourceDirty(dirty: boolean) {
        preservedAnnotationSourceDirty.value = dirty;
    }

    function hasPreservedAnnotationSourceChanges() {
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
        pendingEmbeddedAnnotationDeletes.value = new Map();
        nativeSavedFreeTextNoteStableKeys.value = new Set();
        preservedAnnotationSourceDirty.value = false;
    });

    const hasPendingUnsavedChanges = computed(() => (
        annotationDirty.value
        || isDirty.value
        || hasAnnotationChanges()
        || hasSavedPdfJsAnnotationBaselineChanges()
        || pendingEmbeddedAnnotationDeleteCount.value > 0
        || preservedAnnotationSourceDirty.value
        || pageLabelsDirty.value
        || bookmarksDirty.value
    ));
    const hasPendingPrintSerializationChanges = computed(() => (
        annotationDirty.value
        || hasAnnotationChanges()
        || pendingEmbeddedAnnotationDeleteCount.value > 0
        || preservedAnnotationSourceDirty.value
    ));
    const hasPendingTabChanges = hasPendingUnsavedChanges;

    const pageSaveOrchestration = usePageSaveOrchestration({
        pdfData,
        pdfDocument,
        pdfViewerRef,
        requestDocxExport: (selectedLanguages?: string[]) => exportDocx({
            workingCopyPath: workingCopyPath.value,
            pdfDocument: pdfDocument.value,
            ...(selectedLanguages !== undefined ? { selectedLanguages } : {}),
        }),
        openOcrPopup: () => openDropdown('ocr'),
        isExportingDocx: isDocxExporting,
        workingCopyPath,
        originalPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        isSaving,
        isSavingAs,
        annotationDirty,
        annotationNoteWindowsCount: computed(() => annotationNoteWindows.value.length),
        hasAnnotationChanges,
        hasLivePdfJsAnnotationChanges,
        hasSavedPdfJsAnnotationBaselineChanges,
        hasPreservedAnnotationSourceChanges,
        markNativeFreeTextNotesSaved,
        markNativeFreeTextNotesDeleted,
        markAnnotationSaved: markAnnotationSavedAndClearPreservedSource,
        markPageLabelsSaved,
        markBookmarksSaved,
        isDirty,
        hasPendingUnsavedChanges,
        validatePdfPath: path => getDocumentsCapability().validatePdfPath(path),
        saveFile,
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        persistAllAnnotationNotes: (force) => persistAllAnnotationNotes(force),
        consumePendingEmbeddedTextUpdates: () => consumePendingEmbeddedTextUpdates(),
        restorePendingEmbeddedTextUpdates: updates => restorePendingEmbeddedTextUpdates(updates),
        consumePendingEmbeddedAnnotationDeletes: () => consumePendingEmbeddedAnnotationDeletes(),
        restorePendingEmbeddedAnnotationDeletes: deletions => restorePendingEmbeddedAnnotationDeletes(deletions),
        clearAnnotationHistory: () => pdfViewerRef.value?.clearAnnotationHistory?.(),
        loadRecentFiles: () => {
            void loadRecentFiles();
        },
        clearOcrCache: (path) => clearOcrCache(path),
        reloadWorkingCopyIntoHistory,
        currentPage,
        waitForPdfReload: (page) => waitForPdfReload(page),
        resetSearchCache,
        runWithDocumentOperationLease: documentOperationLease.runExclusive,
    });
    const {
        handleSave,
        isAnySaving,
        isExportingDocx,
        canSave,
        embedPlacedImageToPage,
        serializePdfForSave,
        saveForExternalRead,
    } = pageSaveOrchestration;

    async function ensureWorkingCopyFreshForRead() {
        if (!hasPendingUnsavedChanges.value) {
            return true;
        }
        return saveForExternalRead();
    }

    const exportControls = useWorkspaceExport({
        workingCopyPath,
        totalPages,
        ensureWorkingCopyFreshForRead,
    });
    const { handleExportImages } = exportControls;

    const programmaticPageNavigationTarget = ref<number | null>(null);
    let programmaticPageNavigationTimer: ReturnType<typeof setTimeout> | null = null;

    function clearProgrammaticPageNavigationTarget() {
        if (programmaticPageNavigationTimer !== null) {
            clearTimeout(programmaticPageNavigationTimer);
            programmaticPageNavigationTimer = null;
        }
        programmaticPageNavigationTarget.value = null;
    }

    function beginProgrammaticPageNavigation(page: number) {
        programmaticPageNavigationTarget.value = page;
        if (programmaticPageNavigationTimer !== null) {
            clearTimeout(programmaticPageNavigationTimer);
        }
        programmaticPageNavigationTimer = setTimeout(() => {
            programmaticPageNavigationTimer = null;
            if (programmaticPageNavigationTarget.value === page) {
                programmaticPageNavigationTarget.value = null;
            }
        }, WORKSPACE_PAGE_NAVIGATION_LOCK_MS);
    }

    function shouldAcceptViewerCurrentPageUpdate(page: number) {
        const targetPage = programmaticPageNavigationTarget.value;
        if (targetPage === null) {
            return true;
        }
        if (page !== targetPage) {
            return false;
        }
        clearProgrammaticPageNavigationTarget();
        return true;
    }

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
        beginProgrammaticPageNavigation,
        pdfViewerRef,
    });
    const {
        isAnnotationUndoContext,
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
        isAnnotationUndoContext,
        shouldPreferTimelineUndo: () => (
            !annotationDirty.value
            && !isDirty.value
            && pendingEmbeddedAnnotationDeleteCount.value === 0
            && workspaceUndoTimeline.nextUndoSource.value === 'file'
        ),
        nextUndoSource: workspaceUndoTimeline.nextUndoSource,
        nextRedoSource: workspaceUndoTimeline.nextRedoSource,
        workingCopyPath,
        resetSearchCache,
        clearOcrCache: (path) => clearOcrCache(path),
        undoHistory: workspaceUndoTimeline.undoTimeline,
        redoHistory: workspaceUndoTimeline.redoTimeline,
    });
    const {
        preparePdfReloadWaiter,
        waitForPdfReload,
    } = pdfHistory;

    const hasOpenDocument = computed(() => (
        hasPdf.value
        || (isDjvuMode.value && Boolean(djvuSourcePath.value))
    ));

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
        removeAnnotationFromCache: (stableKey) => {
            annotationComments.value = annotationComments.value.filter(comment => comment.stableKey !== stableKey);
        },
        restoreAnnotationToCache: (comment) => {
            annotationComments.value = [
                ...annotationComments.value.filter(candidate => candidate.stableKey !== comment.stableKey),
                comment,
            ];
        },
        queuePendingEmbeddedAnnotationDelete,
        unqueuePendingEmbeddedAnnotationDelete,
        isNativeFreeTextNoteSaved,
        markPreservedAnnotationSourceDirty,
        setPreservedAnnotationSourceDirty,
        getAnnotationCommentsSnapshot: () => annotationComments.value,
        getAnnotationCommentsStatusSnapshot: () => annotationCommentsStatus.value,
        getEmbeddedMutationBaseData: pageSaveOrchestration.getEmbeddedMutationBaseData,
        embedPlacedImageToPage,
    });
    const {
        insertImageFromFileAt,
        pasteImageFromClipboardAt,
        shapePropertiesPopover,
        closeShapeProperties,
        undoLatestFreshAnnotationNoteCreation,
    } = annotationActions;

    async function handleUndo() {
        if (await undoLatestFreshAnnotationNoteCreation()) {
            return;
        }
        await pdfHistory.handleUndo();
    }

    function handleAnnotationModifiedWithThumbnailInvalidation(
        payload?: Parameters<typeof handleAnnotationModified>[0],
    ) {
        handleAnnotationModified(payload);
        requestThumbnailInvalidation([currentPage.value]);
    }

    const documentControls = useWorkspaceDocumentControls({
        hasDocument: hasOpenDocument,
        pdfData,
        pdfSrc,
        originalPath,
        workingCopyPath,
        currentPage,
        effectiveZoom,
        canSave,
        isAnySaving,
        isHistoryBusy,
        handleSave,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        requestThumbnailInvalidation,
        pdfViewerRef,
        pageContextMenu,
        closePageContextMenu,
        handleExportImages,
        ensureHistoryBaselineForExternalMutation,
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
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab: (pathOrResult) => emit('open-in-new-tab', pathOrResult),
        removeRecentFile,
        notifyMissingRecentFile,
    });

    async function getPrintableSourceData() {
        if (!hasPendingUnsavedChanges.value) {
            return pdfData.value ?? readWorkingCopyBytes();
        }

        await persistAllAnnotationNotes(true);

        const rawData = await pdfViewerRef.value?.saveDocument?.()
            ?? pdfData.value
            ?? await readWorkingCopyBytes();
        if (!rawData) {
            return null;
        }

        return serializePdfForSave(rawData, {
            includeShapes: true,
            rewriteShapeState: true,
        });
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
            const ensured = await viewer.ensurePageMetricsInRange?.(pageNumber, pageNumber);
            if (ensured === false) {
                return null;
            }
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

        return sampledMetrics.length > 0 ? sampledMetrics : null;
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

    const workspacePrint = useWorkspacePrint({
        totalPages,
        currentPage,
        selectedPages: selectedThumbnailPages,
        sourcePdf: pdfSrc,
        workingCopyPath,
        fileName,
        hasPendingUnsavedChanges,
        hasPendingPrintSerializationChanges,
        getQuickPrintPageMetrics,
        getPrintableSourceData,
        renderLoadedPdfPagesForBrowserPrint,
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
        canSave,
        showSettings,
        annotationTool,
        annotationPlacingPageNote,
        pdfViewerRef,
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
        openFileWithDjvuCleanup,
        waitForPdfReload,
        loadPdfFromPath,
        runWithDocumentOperationLease: documentOperationLease.runExclusive,
    });

    useWorkspaceDocumentLifecycleEffects({
        pendingDjvu,
        openDjvuFile,
        loadPdfFromPath,
        currentPage,
        totalPages,
        pdfDocument,
        pdfViewerRef,
        originalPath,
        closeFile,
        openBatchProgress,
        isActive,
        fileName,
        hasPendingTabChanges,
        isDjvuMode,
        djvuSourcePath,
        showSettings,
        emitUpdateTab: (updates) => emit('update-tab', updates),
        emitOpenSettings: () => emit('open-settings'),
        onOpenDjvuError: (error) => {
            pdfError.value = error instanceof Error ? error.message : t('errors.djvu.open');
        },
        pdfSrc,
        workingCopyPath,
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
    });

    return {
        ...fileLifecycle,
        ...sidebarSearch,
        ...annotationSession,
        ...annotationActions,
        ...documentControls,
        ...exportControls,
        ...pageContextMenuControls,
        ...interactionControls,
        ...pageLabelState,
        ...bookmarkState,
        ...viewState,
        ...pdfHistory,
        ...pageSaveOrchestration,
        ...workspacePrint,
        applyAnnotationComments,
        shouldAcceptViewerCurrentPageUpdate,
        thumbnailHiddenAnnotationIds,
        appSettings,
        pdfDocument,
        pdfData,
        currentPage,
        totalPages,
        zoom,
        effectiveZoom,
        zoomMode,
        fitMode,
        viewMode,
        isLoading,
        dragMode,
        continuousScroll,
        showSidebar,
        sidebarTab,
        isSaving,
        isSavingAs,
        isHistoryBusy,
        docxExportError,
        handleInsertImageFromFile: () => insertImageFromFileAt(currentPage.value, 0.5, 0.5),
        handlePasteImageFromClipboard: () => pasteImageFromClipboardAt(currentPage.value, 0.5, 0.5),
        handleUndo,
        handleAnnotationModified: handleAnnotationModifiedWithThumbnailInvalidation,
        handlePrint: workspacePrint.handlePrint,
    };
};
