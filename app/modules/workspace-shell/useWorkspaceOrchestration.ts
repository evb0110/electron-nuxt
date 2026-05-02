import type { Ref } from 'vue';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import { usePageContextMenu } from '@app/composables/pdf/usePageContextMenu';
import { usePageLabelState } from '@app/composables/pdf/usePageLabelState';
import { useBookmarkState } from '@app/composables/pdf/useBookmarkState';
import { usePdfHistory } from '@app/composables/usePdfHistory';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';
import { usePageSaveOrchestration } from '@app/modules/workspace-shell/composables/usePageSaveOrchestration';
import { useWorkspaceDocumentControls } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentControls';
import { useWorkspaceDocumentLifecycleEffects } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects';
import { useWorkspaceExport } from '@app/modules/workspace-shell/composables/useWorkspaceExport';
import { useWorkspaceInteractionControls } from '@app/modules/workspace-shell/composables/useWorkspaceInteractionControls';
import { useWorkspaceFileLifecycleController } from '@app/modules/workspace-shell/composables/workspace-file-lifecycle-controller';
import { useWorkspaceSidebarSearchSyncController } from '@app/modules/workspace-shell/composables/workspace-sidebar-search-sync-controller';
import { useWorkspaceAnnotationSession } from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { TTabUpdate } from '@app/types/tabs';
import { getDocumentsCapability } from '@app/utils/platform-documents';
import { useWorkspaceViewState } from '@app/modules/workspace-shell/composables/workspace-view-state';
import { useDocxExport } from '@app/composables/useDocxExport';
import { useWorkspaceMetadataHistory } from '@app/modules/workspace-shell/composables/useWorkspaceMetadataHistory';
import { useWorkspaceUndoTimeline } from '@app/modules/workspace-shell/composables/useWorkspaceUndoTimeline';
import { useWorkspacePrint } from '@app/modules/workspace-shell/composables/useWorkspacePrint';

interface IWorkspaceOrchestrationDeps {
    isActive: Ref<boolean>;
    emit: {
        (e: 'update-tab', updates: TTabUpdate): void;
        (e: 'open-in-new-tab', result: TDocumentRef | TOpenFileResult): void;
        (e: 'request-close-tab'): void;
        (e: 'open-settings'): void;
    };
}

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
        pickFileToOpenWithDjvuCleanup,
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
        saveWorkingCopyAs,
        markDirty,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        undo,
        redo,
    } = fileLifecycle;

    const sidebarSearch = useWorkspaceSidebarSearchSyncController({workingCopyPath});
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

    let metadataHistory: ReturnType<typeof useWorkspaceMetadataHistory> | null = null;

    const pageLabelState = usePageLabelState({
        pdfDocument,
        totalPages,
        markDirty,
        onPageLabelsSynchronized: () => metadataHistory?.resetToCurrentState(),
        onPageLabelsDirty: () => metadataHistory?.recordCurrentState(),
        onPageLabelsSaved: () => metadataHistory?.resetToCurrentState(),
    });
    const {
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        markPageLabelsSaved,
    } = pageLabelState;

    const bookmarkState = useBookmarkState({
        markDirty,
        onBookmarksSynchronized: () => metadataHistory?.resetToCurrentState(),
        onBookmarksDirty: () => metadataHistory?.recordCurrentState(),
        onBookmarksSaved: () => metadataHistory?.resetToCurrentState(),
    });
    const {
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        markBookmarksSaved,
    } = bookmarkState;
    metadataHistory = useWorkspaceMetadataHistory({
        bookmarkItems,
        bookmarksDirty,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        totalPages,
    });
    metadataHistory.resetToCurrentState();

    const workspaceUndoTimeline = useWorkspaceUndoTimeline({
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        metadataHistoryMutationVersion: metadataHistory.metadataHistoryMutationVersion,
        metadataHistoryResetVersion: metadataHistory.metadataHistoryResetVersion,
        undoFile: undo,
        redoFile: redo,
        undoMetadata: () => metadataHistory?.undoMetadata() ?? false,
        redoMetadata: () => metadataHistory?.redoMetadata() ?? false,
    });

    const exportControls = useWorkspaceExport({
        workingCopyPath,
        totalPages,
    });
    const { handleExportImages } = exportControls;

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
        markDirty,
    });
    const {
        annotationContextMenu,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
        hasAnnotationChanges,
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationToolChange,
        markAnnotationDirty,
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
    } = annotationSession;

    const pendingEmbeddedAnnotationDeletes = new Map<string, IAnnotationCommentSummary>();

    function queuePendingEmbeddedAnnotationDelete(comment: IAnnotationCommentSummary) {
        pendingEmbeddedAnnotationDeletes.set(comment.stableKey, comment);
    }

    function consumePendingEmbeddedAnnotationDeletes() {
        if (pendingEmbeddedAnnotationDeletes.size === 0) {
            return null;
        }

        const deletions = Array.from(pendingEmbeddedAnnotationDeletes.values());
        pendingEmbeddedAnnotationDeletes.clear();
        return deletions;
    }

    function restorePendingEmbeddedAnnotationDeletes(deletions: IAnnotationCommentSummary[] | null | undefined) {
        deletions?.forEach((comment) => {
            if (!pendingEmbeddedAnnotationDeletes.has(comment.stableKey)) {
                pendingEmbeddedAnnotationDeletes.set(comment.stableKey, comment);
            }
        });
    }

    watch(workingCopyPath, () => {
        pendingEmbeddedAnnotationDeletes.clear();
    });

    const hasPendingUnsavedChanges = computed(() => (
        annotationDirty.value
        || isDirty.value
        || hasAnnotationChanges()
        || pendingEmbeddedAnnotationDeletes.size > 0
        || pageLabelsDirty.value
        || bookmarksDirty.value
    ));
    const hasPendingTabChanges = hasPendingUnsavedChanges;

    const pageSaveOrchestration = usePageSaveOrchestration({
        pdfData,
        pdfDocument,
        pdfViewerRef,
        requestDocxExport: (selectedLanguages?: string[]) => exportDocx({
            workingCopyPath: workingCopyPath.value,
            pdfDocument: pdfDocument.value,
            selectedLanguages,
        }),
        openOcrPopup: () => openDropdown('ocr'),
        isExportingDocx: isDocxExporting,
        workingCopyPath,
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
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        isDirty,
        hasPendingUnsavedChanges,
        readWorkingCopyBytes,
        validatePdfData: (data, fileName) => getDocumentsCapability().validatePdfData(data, fileName),
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        persistAllAnnotationNotes: (force: boolean) => persistAllAnnotationNotes(force),
        consumePendingEmbeddedTextUpdates: () => consumePendingEmbeddedTextUpdates(),
        restorePendingEmbeddedTextUpdates: updates => restorePendingEmbeddedTextUpdates(updates),
        consumePendingEmbeddedAnnotationDeletes: () => consumePendingEmbeddedAnnotationDeletes(),
        restorePendingEmbeddedAnnotationDeletes: deletions => restorePendingEmbeddedAnnotationDeletes(deletions),
        loadRecentFiles: () => {
            void loadRecentFiles();
        },
        clearOcrCache: (path: string) => clearOcrCache(path),
        loadPdfFromData,
        currentPage,
        waitForPdfReload: (page: number) => waitForPdfReload(page),
        resetSearchCache,
    });
    const {
        handleSave,
        isAnySaving,
        isExportingDocx,
        canSave,
        embedPlacedImageToPage,
        serializePdfForSave,
    } = pageSaveOrchestration;

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
        hasOpenAnnotationNotes,
        canUndoHistory: workspaceUndoTimeline.canUndoTimeline,
        canRedoHistory: workspaceUndoTimeline.canRedoTimeline,
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
        nextUndoSource: workspaceUndoTimeline.nextUndoSource,
        nextRedoSource: workspaceUndoTimeline.nextRedoSource,
        workingCopyPath,
        resetSearchCache,
        clearOcrCache: (path: string) => clearOcrCache(path),
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
        removeAnnotationFromCache: (stableKey: string) => {
            annotationComments.value = annotationComments.value.filter(comment => comment.stableKey !== stableKey);
        },
        markAnnotationDirty,
        queuePendingEmbeddedAnnotationDelete,
        getEmbeddedMutationBaseData: pageSaveOrchestration.getEmbeddedMutationBaseData,
        embedPlacedImageToPage,
    });
    const {
        insertImageFromFileAt,
        pasteImageFromClipboardAt,
        shapePropertiesPopover,
        closeShapeProperties,
    } = annotationActions;

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
        clearOcrCache: (path: string) => clearOcrCache(path),
        resetSearchCache,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        hasAnnotationChanges,
        persistAllAnnotationNotes,
        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab: (pathOrResult: TDocumentRef | TOpenFileResult) => emit('open-in-new-tab', pathOrResult),
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

        const samplePages = Array.from(new Set([
            1,
            Math.min(total, Math.max(1, currentPage.value)),
            Math.max(1, Math.ceil(total / 2)),
            total,
        ])).sort((left, right) => left - right);

        for (const pageNumber of samplePages) {
            const ensured = await viewer.ensurePageMetricsInRange?.(pageNumber, pageNumber);
            if (ensured === false) {
                return null;
            }
        }

        const metrics = viewer.getPageMetricsSnapshot?.() ?? [];
        const sampledMetrics = samplePages
            .map(pageNumber => metrics[pageNumber - 1] ?? null)
            .filter((metric): metric is NonNullable<typeof metric> => (
                typeof metric?.width === 'number'
                && Number.isFinite(metric.width)
                && metric.width > 0
                && typeof metric.height === 'number'
                && Number.isFinite(metric.height)
                && metric.height > 0
            ));

        return sampledMetrics.length > 0 ? sampledMetrics : null;
    }

    const workspacePrint = useWorkspacePrint({
        totalPages,
        selectedPages: selectedThumbnailPages,
        sourcePdf: pdfSrc,
        workingCopyPath,
        fileName,
        hasPendingUnsavedChanges,
        getQuickPrintPageMetrics,
        getPrintableSourceData,
    });

    const { handleQuickPrint } = workspacePrint;

    function handlePrint() {
        void handleQuickPrint();
    }

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
        handlePrint,
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
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationPlacingPageNote,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        resetAnnotationTracking,
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
        handlePrint,
    };
};
