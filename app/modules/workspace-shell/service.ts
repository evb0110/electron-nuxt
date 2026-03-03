import type { Ref } from 'vue';
import {
    syncRef,
    useStorage,
} from '@vueuse/core';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import { ZOOM } from '@app/constants/pdf-layout';
import { STORAGE_KEYS } from '@app/constants/storage-keys';
import { useAnnotationContextMenu } from '@app/composables/pdf/useAnnotationContextMenu';
import { BrowserLogger } from '@app/utils/browser-logger';
import { usePageContextMenu } from '@app/composables/pdf/usePageContextMenu';
import { useAnnotationNoteWindows } from '@app/composables/pdf/useAnnotationNoteWindows';
import { usePageLabelState } from '@app/composables/pdf/usePageLabelState';
import { useBookmarkState } from '@app/composables/pdf/useBookmarkState';
import { usePdfHistory } from '@app/composables/usePdfHistory';
import { usePageAnnotationTools } from '@app/composables/usePageAnnotationTools';
import { usePageAnnotationActions } from '@app/composables/usePageAnnotationActions';
import { usePageSaveOrchestration } from '@app/composables/usePageSaveOrchestration';
import { usePageStatusBar } from '@app/composables/usePageStatusBar';
import { usePageOpsHandlers } from '@app/composables/usePageOpsHandlers';
import { usePageShortcuts } from '@app/composables/usePageShortcuts';
import { useDocumentTransitions } from '@app/composables/page/useDocumentTransitions';
import { useWorkspaceExport } from '@app/composables/page/useWorkspaceExport';
import {
    useWorkspaceFileLifecycleController,
    useWorkspaceFileOperationController,
} from '@app/composables/page/workspace-file-lifecycle-controller';
import { useWorkspaceSidebarSearchSyncController } from '@app/composables/page/workspace-sidebar-search-sync-controller';
import { setupWorkspaceUiSyncWatchers } from '@app/composables/page/workspace-ui-sync';
import { hasAnnotationChanges as detectAnnotationChanges } from '@app/composables/page/workspace-annotation-utils';
import type { TOpenFileResult } from '@contracts/electron-api';
import type { TTabUpdate } from '@app/types/tabs';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';
import { useWorkspaceViewState } from '@app/composables/page/workspace-view-state';
import { useDocxExport } from '@app/composables/useDocxExport';
import type { TSplitPayload } from '@contracts/window-tabs';

interface IWorkspaceOrchestrationDeps {
    isActive: Ref<boolean>;
    emit: {
        (e: 'update-tab', updates: TTabUpdate): void;
        (e: 'open-in-new-tab', result: TOpenFileResult): void;
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

    const {
        isDjvuMode,
        djvuSourcePath,
        conversionState,
        djvuIsLoadingPages,
        djvuLoadingProgress,
        djvuShowBanner,
        showConvertDialog,
        djvuError,
        openDjvuFile,
        openConvertDialog,
        djvuDismissBanner,
        handleDjvuConvert,
        handleDjvuCancel,
        recentFiles,
        loadRecentFiles,
        removeRecentFile,
        clearRecentFiles,
        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
        hasPdf,
        initFromStorage,
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        isDirty,
        pdfError,
        isElectron,
        pendingDjvu,
        openBatchProgress,
        loadPdfFromPath,
        loadPdfFromData,
        persistPdfDataSilently,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markDirty,
        canUndoFile,
        canRedoFile,
        undo,
        redo,
    } = useWorkspaceFileLifecycleController();

    const {
        pdfViewerRef,
        zoomDropdownOpen,
        pageDropdownOpen,
        ocrPopupOpen,
        overflowMenuOpen,
        closeAllDropdowns,
        closeOtherDropdowns,
        handleDropdownOpenChange,
        openDropdown,
        selectedThumbnailPages,
        thumbnailInvalidationRequest,
        setSelectedThumbnailPages,
        requestThumbnailInvalidation,
        handleSelectedThumbnailPagesUpdate,
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
        searchQuery,
        results,
        pageMatches,
        currentResultIndex,
        currentResult,
        isSearching,
        totalMatches,
        searchProgress,
        isTruncated,
        minQueryLength,
        openSearch,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,
        resetSearchCache,
        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        startSidebarResize,
        cleanupSidebarResizeListeners,
    } = useWorkspaceSidebarSearchSyncController({workingCopyPath});

    const { settings: appSettings } = useSettings();
    const isSaving = ref(false);
    const isSavingAs = ref(false);
    const isHistoryBusy = ref(false);

    const {
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        markPageLabelsSaved,
        handlePageLabelRangesUpdate,
    } = usePageLabelState({
        pdfDocument,
        totalPages,
        markDirty,
    });

    const {
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        markBookmarksSaved,
        handleBookmarksChange,
    } = useBookmarkState({ markDirty });

    const {
        isExportInProgress,
        exportScopeDialogOpen,
        exportScopeDialogMode,
        exportScopeDialogSelectedPages,
        handleExportScopeDialogSubmit,
        handleExportScopeDialogOpenChange,
        handleExportImages,
        handleExportMultiPageTiff,
    } = useWorkspaceExport({
        workingCopyPath,
        totalPages,
    });

    const {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
    } = useAnnotationContextMenu();

    const {
        pageContextMenu,
        pageContextMenuStyle,
        showPageContextMenu,
        closePageContextMenu,
    } = usePageContextMenu();

    function clearAnnotationChanges() {
        try {
            pdfDocument.value?.annotationStorage?.resetModified();
        } catch (error) {
            BrowserLogger.debug('workspace', 'Failed to reset annotation storage modified state', error);
        }
    }

    function hasAnnotationChanges() {
        return detectAnnotationChanges({
            pdfViewerRef,
            pdfDocument,
        });
    }

    const {
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationDirty,
        markAnnotationSaved,
        resetAnnotationTracking,
    } = usePageAnnotationTools({
        pdfViewerRef,
        dragMode,
        markDirty,
        clearAnnotationChanges,
        closeAnnotationContextMenu,
        hasAnnotationChanges,
    });

    const annotationKeepActiveStorage = useStorage<string>(
        STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE,
        '0',
        undefined,
        { initOnMounted: true },
    );
    syncRef(annotationKeepActive, annotationKeepActiveStorage, {transform: {
        ltr: value => (value ? '1' : '0'),
        rtl: stored => stored === '1',
    }});

    const { clearCache: clearOcrCache } = useOcrTextContent();
    const {
        isExportingDocx: isDocxExporting,
        docxExportError,
        exportDocx,
        clearDocxExportError,
    } = useDocxExport();

    const {
        handleSave,
        handleSaveAs,
        handleExportDocx,
        handleOcrComplete,
        isAnySaving,
        isExportingDocx,
        canSave,
        deleteEmbeddedByRef,
    } = usePageSaveOrchestration({
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
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        persistAllAnnotationNotes: (force: boolean) => persistAllAnnotationNotes(force),
        consumePendingEmbeddedTextUpdates: () => consumePendingEmbeddedTextUpdates(),
        loadRecentFiles,
        clearOcrCache: (path: string) => clearOcrCache(path),
        loadPdfFromData,
        currentPage,
        waitForPdfReload: (page: number) => waitForPdfReload(page),
    });

    const hasOpenAnnotationNotes = ref(false);

    const {
        isFitWidthActive,
        isFitHeightActive,
        isAnnotationUndoContext,
        annotationCursorMode,
        canUndo,
        canRedo,
        handleFitMode,
        enableDragMode,
        handleGoToPage,
    } = useWorkspaceViewState({
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
        canUndoFile,
        canRedoFile,
        pdfViewerRef,
    });

    const {
        waitForPdfReload,
        handleUndo,
        handleRedo,
    } = usePdfHistory({
        pdfDocument,
        pdfViewerRef,
        currentPage,
        isAnySaving,
        isHistoryBusy,
        canUndo,
        canRedo,
        isAnnotationUndoContext,
        workingCopyPath,
        resetSearchCache,
        clearOcrCache: (path: string) => clearOcrCache(path),
        undo,
        redo,
    });


    const {
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        isAnyAnnotationNoteSaving,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        closeAllAnnotationNotes,
        handleOpenAnnotationNote: openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
        consumePendingEmbeddedTextUpdates,
    } = useAnnotationNoteWindows({
        annotationComments,
        markAnnotationDirty,
        updateAnnotationCommentInViewer: (comment, text) => pdfViewerRef.value?.updateAnnotationComment(comment, text) ?? false,
    });

    // Bridge note window count to annotationCursorMode so the editor layer
    // stays active while any note window is open (see docs/freetext-note-persistence.md)
    watch(() => annotationNoteWindows.value.length, (count) => {
        hasOpenAnnotationNotes.value = count > 0;
    }, { immediate: true });

    const hasPendingTabChanges = computed(() => (
        annotationDirty.value
        || isDirty.value
        || hasAnnotationChanges()
        || pageLabelsDirty.value
        || bookmarksDirty.value
    ));

    const {
        shapePropertiesPopover,
        selectedShapeForProperties,
        handleCommentSelection,
        handleQuickNoteAction,
        handleStartPlaceNote,
        handleAnnotationFocusComment,
        handleAnnotationCommentClick,
        handleOpenAnnotationNote,
        closeShapeProperties,
        handleShapePropertyUpdate,
        handleShapeContextMenu,
        handleViewerAnnotationContextMenu,
        openContextMenuNote,
        copyContextMenuNoteText,
        copyContextMenuSelectionText,
        deleteContextMenuComment,
        createContextMenuFreeNote,
        createContextMenuSelectionNote,
        createContextMenuMarkup,
        handleCopyAnnotationComment,
        handleDeleteAnnotationComment,
    } = usePageAnnotationActions({
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
        deleteEmbeddedByRef,
        loadPdfFromData,
        waitForPdfReload,
        removeAnnotationFromCache: (stableKey: string) => {
            annotationComments.value = annotationComments.value.filter(c => c.stableKey !== stableKey);
        },
        persistPdfDataSilently,
        markAnnotationSaved,
        resetAnnotationStorageModified: () => {
            pdfDocument.value?.annotationStorage?.resetModified();
        },
    });

    const {
        statusFilePath,
        statusFileSizeLabel,
        statusZoomLabel,
        statusCanShowInFolder,
        statusShowInFolderTooltip,
        statusShowInFolderAriaLabel,
        statusSaveDotClass,
        statusSaveDotCanSave,
        statusSaveDotTooltip,
        statusSaveDotAriaLabel,
        handleStatusSaveClick,
        handleStatusShowInFolderClick,
    } = usePageStatusBar({
        pdfSrc,
        pdfData,
        originalPath,
        workingCopyPath,
        effectiveZoom,
        canSave,
        isAnySaving,
        isHistoryBusy,
        handleSave,
    });

    const {
        isPageOperationInProgress,
        pageOpsDelete,
        pageOpsExtract,
        pageOpsInsert,
        pageOpsReorder,
        handlePageContextMenuDelete,
        handlePageContextMenuExtract,
        handlePageContextMenuExport,
        handlePageRotate,
        handlePageContextMenuRotateCw,
        handlePageContextMenuRotateCcw,
        handlePageContextMenuInsertBefore,
        handlePageContextMenuInsertAfter,
        handlePageFileDrop,
        handlePageContextMenuSelectAll,
        handlePageContextMenuInvertSelection,
    } = usePageOpsHandlers({
        workingCopyPath,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        invalidateThumbnailPages: requestThumbnailInvalidation,
        pdfViewerRef,
        pageContextMenu,
        closePageContextMenu,
        onExportPages: (pages: number[]) => {
            void handleExportImages(pages);
        },
        loadPdfFromPath,
        clearOcrCache: (path: string) => clearOcrCache(path),
        resetSearchCache,
    });

    const {
        handleOpenFileFromUi,
        handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult,
        handleCloseFileFromUi,
        openRecentFile,
    } = useWorkspaceFileOperationController({
        pdfSrc,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        hasAnnotationChanges,
        persistAllAnnotationNotes,
        handleSave,
        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab: (result: TOpenFileResult) => {
            emit('open-in-new-tab', result);
        },
    });

    function clampWorkspaceZoomLevel(level: number) {
        if (!Number.isFinite(level)) {
            return 1;
        }
        return Math.min(ZOOM.MAX, Math.max(ZOOM.MIN, level));
    }

    function resolveDisplayZoom() {
        if (Number.isFinite(effectiveZoom.value) && effectiveZoom.value > 0) {
            return effectiveZoom.value;
        }
        return clampWorkspaceZoomLevel(zoom.value);
    }

    function resolveZoomBaselineScale() {
        if (!Number.isFinite(zoom.value) || Math.abs(zoom.value) < 0.0001) {
            return 1;
        }
        const baseline = resolveDisplayZoom() / zoom.value;
        if (!Number.isFinite(baseline) || baseline <= 0) {
            return 1;
        }
        return baseline;
    }

    function setCustomZoomFromDisplay(displayZoom: number) {
        const targetDisplayZoom = clampWorkspaceZoomLevel(displayZoom);
        const baselineScale = resolveZoomBaselineScale();
        zoom.value = clampWorkspaceZoomLevel(
            targetDisplayZoom / baselineScale,
        );
        effectiveZoom.value = targetDisplayZoom;
        zoomMode.value = 'custom';
    }

    const {
        setupShortcuts,
        cleanupShortcuts,
    } = usePageShortcuts({
        isActive,
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
        handleZoomIn: () => {
            setCustomZoomFromDisplay(resolveDisplayZoom() + ZOOM.STEP);
        },
        handleZoomOut: () => {
            setCustomZoomFromDisplay(resolveDisplayZoom() - ZOOM.STEP);
        },
        handleActualSize: () => {
            setCustomZoomFromDisplay(1);
        },
    });

    setupWorkspaceUiSyncWatchers({
        pendingDjvu,
        openDjvuFile,
        loadPdfFromPath,
        currentPage,
        pdfViewerRef,
        originalPath,
        isActive,
        fileName,
        isDirty: hasPendingTabChanges,
        isDjvuMode,
        djvuSourcePath,
        openBatchProgress,
        showSettings,
        emitUpdateTab: (updates) => emit('update-tab', updates),
        emitOpenSettings: () => emit('open-settings'),
        onOpenDjvuError: (error) => {
            pdfError.value = error instanceof Error ? error.message : t('errors.djvu.open');
        },
    });

    useDocumentTransitions({
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
        pdfViewerRef,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
    });

    // --- Helper functions ---

    const isCapturingRegion = computed(() => pdfViewerRef.value?.isCapturingRegion ?? false);

    function handleCaptureRegion() {
        if (!pdfViewerRef.value) {
            return;
        }
        void pdfViewerRef.value.captureRegionToClipboard();
    }

    function handleDropdownOpen(
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow',
        isOpen: boolean,
    ) {
        handleDropdownOpenChange(dropdown, isOpen);
        if (isOpen && dropdown === 'ocr') {
            clearDocxExportError();
        }
    }

    function normalizeSplitPayloadPage(page: number | undefined) {
        if (typeof page !== 'number' || !Number.isFinite(page)) {
            return null;
        }

        return Math.max(1, Math.floor(page));
    }

    function normalizeSplitPayloadTotalPages(total: number | undefined, fallbackPage: number) {
        if (typeof total !== 'number' || !Number.isFinite(total)) {
            return fallbackPage;
        }

        return Math.max(fallbackPage, Math.floor(total));
    }

    async function captureSplitPayload(): Promise<TSplitPayload> {
        if (!pdfSrc.value) {
            return { kind: 'empty' };
        }

        if (isDjvuMode.value && djvuSourcePath.value) {
            return {
                kind: 'djvu',
                sourcePath: djvuSourcePath.value,
            };
        }

        const normalizedCurrentPage = normalizeSplitPayloadPage(currentPage.value) ?? 1;
        if (!hasElectronAPI()) {
            return { kind: 'empty' };
        }

        const api = getElectronAPI();
        const normalizedFileName = fileName.value ?? 'document.pdf';

        if (workingCopyPath.value && !hasPendingTabChanges.value) {
            try {
                const snapshotPath = await api.documents.createWorkingCopyFromPath(
                    workingCopyPath.value,
                    originalPath.value ?? undefined,
                );
                return {
                    kind: 'pdfSnapshot',
                    fileName: normalizedFileName,
                    originalPath: originalPath.value,
                    snapshotPath,
                    isDirty: false,
                    currentPage: normalizedCurrentPage,
                    totalPages: normalizeSplitPayloadTotalPages(totalPages.value, normalizedCurrentPage),
                };
            } catch (error) {
                BrowserLogger.warn('workspace', 'Failed to create split payload from working copy path', {
                    path: workingCopyPath.value,
                    error,
                });
            }
        }

        let snapshot = await pdfViewerRef.value?.saveDocument?.() ?? null;
        if (!snapshot && pdfData.value) {
            snapshot = pdfData.value.slice();
        }

        if (!snapshot && workingCopyPath.value) {
            try {
                snapshot = await api.documents.readFile(workingCopyPath.value);
            } catch (error) {
                BrowserLogger.warn('workspace', 'Failed to read working copy for split payload', {
                    path: workingCopyPath.value,
                    error,
                });
            }
        }

        if (!snapshot) {
            return { kind: 'empty' };
        }

        const snapshotPath = await api.documents.createWorkingCopyFromData(
            normalizedFileName,
            snapshot,
            originalPath.value ?? undefined,
        );
        return {
            kind: 'pdfSnapshot',
            fileName: normalizedFileName,
            originalPath: originalPath.value,
            snapshotPath,
            isDirty: hasPendingTabChanges.value,
            currentPage: normalizedCurrentPage,
            totalPages: normalizeSplitPayloadTotalPages(totalPages.value, normalizedCurrentPage),
        };
    }

    async function restoreSplitPayload(payload: TSplitPayload): Promise<void> {
        if (payload.kind === 'empty') {
            return;
        }

        if (payload.kind === 'djvu') {
            await openFileWithDjvuCleanup({
                kind: 'djvu',
                workingPath: '',
                originalPath: payload.sourcePath,
            });
            return;
        }

        const pageToRestore = normalizeSplitPayloadPage(payload.currentPage);
        if (payload.totalPages && Number.isFinite(payload.totalPages)) {
            totalPages.value = Math.max(totalPages.value, Math.floor(payload.totalPages));
        }
        const restorePagePromise = pageToRestore && pageToRestore > 1
            ? waitForPdfReload(pageToRestore).catch((error) => {
                BrowserLogger.debug('workspace', 'Split payload page restore wait failed', {
                    pageToRestore,
                    error,
                });
            })
            : null;

        if (!hasElectronAPI()) {
            return;
        }

        await loadPdfFromPath(payload.snapshotPath, { markDirty: payload.isDirty });
        originalPath.value = payload.originalPath;

        if (restorePagePromise) {
            await restorePagePromise;
        }
    }

    return {
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        isDirty,
        pdfError,
        isElectron,
        openBatchProgress,
        loadPdfFromData,

        isDjvuMode,
        djvuSourcePath,
        conversionState,
        djvuIsLoadingPages,
        djvuLoadingProgress,
        djvuShowBanner,
        djvuError,
        showConvertDialog,
        openConvertDialog,
        djvuDismissBanner,
        handleDjvuConvert,
        handleDjvuCancel,

        recentFiles,
        removeRecentFile,
        clearRecentFiles,

        pdfViewerRef,
        zoomDropdownOpen,
        pageDropdownOpen,
        ocrPopupOpen,
        overflowMenuOpen,
        selectedThumbnailPages,
        thumbnailInvalidationRequest,
        handleSelectedThumbnailPagesUpdate,
        handleDropdownOpen,
        closeAllDropdowns,
        closeOtherDropdowns,

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
        appSettings,
        showSidebar,
        sidebarTab,
        isSaving,
        isSavingAs,
        isHistoryBusy,
        isExportInProgress,
        exportScopeDialogOpen,
        exportScopeDialogMode,
        exportScopeDialogSelectedPages,

        pageLabels,
        pageLabelRanges,
        handlePageLabelRangesUpdate,
        bookmarkEditMode,
        handleBookmarksChange,

        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,

        pageContextMenu,
        pageContextMenuStyle,
        showPageContextMenu,

        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationActiveCommentStableKey,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,

        searchQuery,
        results,
        pageMatches,
        currentResultIndex,
        currentResult,
        isSearching,
        totalMatches,
        searchProgress,
        isTruncated,
        minQueryLength,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,

        handleSave,
        handleSaveAs,
        handleExportDocx,
        handleExportImages,
        handleExportMultiPageTiff,
        handleExportScopeDialogSubmit,
        handleExportScopeDialogOpenChange,
        handleOcrComplete,
        docxExportError,
        isAnySaving,
        isExportingDocx,
        canSave,

        isFitWidthActive,
        isFitHeightActive,
        annotationCursorMode,
        canUndo,
        canRedo,
        handleUndo,
        handleRedo,
        handleCaptureRegion,
        isCapturingRegion,

        annotationNotePositions,
        sortedAnnotationNoteWindows,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        closeAnnotationNote,
        bringAnnotationNoteToFront,

        shapePropertiesPopover,
        selectedShapeForProperties,
        handleCommentSelection,
        handleQuickNoteAction,
        handleStartPlaceNote,
        handleAnnotationFocusComment,
        handleAnnotationCommentClick,
        handleOpenAnnotationNote,
        closeShapeProperties,
        handleShapePropertyUpdate,
        handleShapeContextMenu,
        handleViewerAnnotationContextMenu,
        openContextMenuNote,
        copyContextMenuNoteText,
        copyContextMenuSelectionText,
        deleteContextMenuComment,
        createContextMenuFreeNote,
        createContextMenuSelectionNote,
        createContextMenuMarkup,
        handleCopyAnnotationComment,
        handleDeleteAnnotationComment,

        statusFilePath,
        statusFileSizeLabel,
        statusZoomLabel,
        statusCanShowInFolder,
        statusShowInFolderTooltip,
        statusShowInFolderAriaLabel,
        statusSaveDotClass,
        statusSaveDotCanSave,
        statusSaveDotTooltip,
        statusSaveDotAriaLabel,
        handleStatusSaveClick,
        handleStatusShowInFolderClick,

        isPageOperationInProgress,
        pageOpsDelete,
        pageOpsExtract,
        pageOpsInsert,
        pageOpsReorder,
        handlePageContextMenuDelete,
        handlePageContextMenuExtract,
        handlePageContextMenuExport,
        handlePageRotate,
        handlePageContextMenuRotateCw,
        handlePageContextMenuRotateCcw,
        handlePageContextMenuInsertBefore,
        handlePageContextMenuInsertAfter,
        handlePageFileDrop,
        handlePageContextMenuSelectAll,
        handlePageContextMenuInvertSelection,

        handleOpenFileFromUi,
        handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult,
        handleCloseFileFromUi,
        openRecentFile,
        captureSplitPayload,
        restoreSplitPayload,

        setupShortcuts,
        cleanupShortcuts,

        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        startSidebarResize,
        cleanupSidebarResizeListeners,

        handleFitMode,
        enableDragMode,
        handleGoToPage,
        initFromStorage,
        hasPdf,
    };
};
