<template>
    <WorkspaceShell>
        <WorkspaceToolbarHost :is-active="isActive" :can-teleport="canTeleportToolbar">
            <PdfToolbar
                :has-pdf="toolbarHasPdf"
                :can-save="canSave"
                :can-undo="canUndo"
                :can-redo="canRedo"
                :can-export-docx="canExportDocx"
                :is-saving="isSaving"
                :is-saving-as="isSavingAs"
                :is-any-saving="isAnySaving"
                :is-history-busy="isHistoryBusy"
                :is-exporting-docx="isExportingDocx"
                :is-fit-width-active="isFitWidthActive"
                :is-fit-height-active="isFitHeightActive"
                :show-sidebar="showSidebar"
                :drag-mode="dragMode"
                :continuous-scroll="continuousScroll"
                :is-djvu-mode="isDjvuMode"
                :is-capturing-region="isCapturingRegion"
                :is-placing-page-note="annotationPlacingPageNote"
                @open-file="handleOpenFileFromUi"
                @open-settings="emit('open-settings')"
                @save="handleToolbarSave"
                @save-as="handleToolbarSaveAs"
                @export-docx="handleToolbarExportDocx"
                @undo="handleToolbarUndo"
                @redo="handleToolbarRedo"
                @toggle-sidebar="handleToolbarToggleSidebar"
                @fit-width="handleToolbarFitWidth"
                @fit-height="handleToolbarFitHeight"
                @toggle-continuous-scroll="handleToolbarToggleContinuousScroll"
                @enable-drag="handleToolbarEnableDrag"
                @disable-drag="handleToolbarDisableDrag"
                @capture-region="handleToolbarCaptureRegion"
                @quick-note="handleToolbarQuickNote"
            >
                <template #ocr="{ isCollapsed }">
                    <OcrPopup
                        :pdf-document="pdfDocument"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :working-copy-path="workingCopyPath"
                        :open="ocrPopupOpen"
                        :is-exporting-docx="isExportingDocx"
                        :external-error="docxExportError"
                        :disabled="isDjvuMode || !toolbarHasPdf"
                        :hide-trigger="isCollapsed(3)"
                        @update:open="handleDropdownOpen('ocr', $event)"
                        @export-docx="handleExportDocx"
                        @ocr-complete="handleOcrComplete"
                    />
                </template>
                <template #zoom-dropdown>
                    <PdfZoomDropdown
                        v-model:zoom="zoom"
                        v-model:fit-mode="fitMode"
                        v-model:view-mode="viewMode"
                        :open="zoomDropdownOpen"
                        :disabled="!toolbarHasPdf"
                        :compact-level="0"
                        @update:open="handleDropdownOpen('zoom', $event)"
                    />
                </template>
                <template #page-dropdown="{ collapseTier }">
                    <PdfPageDropdown
                        v-model="currentPage"
                        :open="pageDropdownOpen"
                        :total-pages="totalPages"
                        :page-labels="pageLabels"
                        :disabled="!toolbarHasPdf"
                        :compact-level="collapseTier >= 5 ? 2 : collapseTier >= 4 ? 1 : 0"
                        @go-to-page="handleGoToPage"
                        @update:open="handleDropdownOpen('page', $event)"
                    />
                </template>
                <template #overflow-menu="{ collapseTier, hasOverflowItems }">
                    <ToolbarOverflowMenu
                        v-if="hasOverflowItems"
                        :open="overflowMenuOpen"
                        :collapse-tier="collapseTier"
                        :can-save="canSave"
                        :can-undo="canUndo"
                        :can-redo="canRedo"
                        :has-pdf="toolbarHasPdf"
                        :is-any-saving="isAnySaving"
                        :is-history-busy="isHistoryBusy"
                        :is-exporting-docx="isExportingDocx"
                        :can-export-docx="canExportDocx"
                        :drag-mode="dragMode"
                        :continuous-scroll="continuousScroll"
                        :view-mode="viewMode"
                        :is-djvu-mode="isDjvuMode"
                        :is-fit-width-active="isFitWidthActive"
                        :is-fit-height-active="isFitHeightActive"
                        @update:open="handleDropdownOpen('overflow', $event)"
                        @save="handleToolbarSave"
                        @save-as="handleToolbarSaveAs"
                        @export-docx="handleToolbarExportDocx"
                        @open-ocr="handleDropdownOpen('ocr', true)"
                        @undo="handleToolbarUndo"
                        @redo="handleToolbarRedo"
                        @fit-width="handleToolbarFitWidth"
                        @fit-height="handleToolbarFitHeight"
                        @enable-drag="handleToolbarEnableDrag"
                        @disable-drag="handleToolbarDisableDrag"
                        @set-view-mode="handleOverflowSetViewMode"
                        @toggle-continuous-scroll="handleToolbarToggleContinuousScroll"
                        @open-settings="handleOverflowOpenSettings"
                    />
                </template>
            </PdfToolbar>
        </WorkspaceToolbarHost>

        <UAlert
            v-if="pdfError"
            color="error"
            variant="soft"
            class="mx-3 mt-2"
            :description="String(pdfError)"
            :ui="{ title: 'sr-only' }"
        />

        <UAlert
            v-if="isDjvuMode && djvuError"
            color="error"
            variant="soft"
            class="mx-3 mt-2"
            :description="String(djvuError)"
            :ui="{ title: 'sr-only' }"
        />

        <DjvuBanner
            v-if="isDjvuMode"
            :visible="djvuShowBanner"
            :is-loading-pages="djvuIsLoadingPages"
            :loading-current="djvuLoadingProgress.current"
            :loading-total="djvuLoadingProgress.total"
            @convert="openConvertDialog"
            @dismiss="djvuDismissBanner"
        />

        <WorkspaceSidebarHost
            :show-sidebar="Boolean(pdfSrc && showSidebar)"
            :sidebar-wrapper-style="sidebarWrapperStyle"
            :is-resizing-sidebar="isResizingSidebar"
            :resize-aria-label="t('sidebar.resize')"
            @resize-start="startSidebarResize"
        >
            <template #sidebar>
                <PdfSidebar
                    v-model:active-tab="sidebarTab"
                    v-model:search-query="searchQuery"
                    :is-open="showSidebar"
                    :pdf-document="pdfDocument"
                    :current-page="currentPage"
                    :total-pages="totalPages"
                    :page-labels="pageLabels"
                    :page-label-ranges="pageLabelRanges"
                    :search-results="results"
                    :current-result-index="currentResultIndex"
                    :total-matches="totalMatches"
                    :is-searching="isSearching"
                    :search-progress="searchProgress"
                    :is-truncated="isTruncated"
                    :min-query-length="minQueryLength"
                    :width="sidebarWidth"
                    :annotation-tool="annotationTool"
                    :annotation-keep-active="annotationKeepActive"
                    :annotation-settings="annotationSettings"
                    :annotation-comments="annotationComments"
                    :annotation-active-comment-stable-key="annotationActiveCommentStableKey"
                    :bookmark-edit-mode="bookmarkEditMode"
                    :is-page-operation-in-progress="isPageOperationInProgress"
                    :is-djvu-mode="isDjvuMode"
                    :selected-thumbnail-pages="selectedThumbnailPages"
                    :thumbnail-invalidation-request="thumbnailInvalidationRequest"
                    @search="handleSearch"
                    @next="handleSearchNext"
                    @previous="handleSearchPrevious"
                    @go-to-page="handleGoToPage"
                    @go-to-result="handleGoToResult"
                    @update:page-label-ranges="handlePageLabelRangesUpdate"
                    @update:annotation-tool="handleAnnotationToolChange"
                    @update:annotation-keep-active="annotationKeepActive = $event"
                    @annotation-setting="handleAnnotationSettingChange"
                    @update:selected-thumbnail-pages="handleSelectedThumbnailPagesUpdate"
                    @annotation-focus-comment="handleAnnotationFocusComment"
                    @annotation-open-note="handleOpenAnnotationNote"
                    @annotation-copy-comment="handleCopyAnnotationComment"
                    @annotation-delete-comment="handleDeleteAnnotationComment"
                    @bookmarks-change="handleBookmarksChange"
                    @update:bookmark-edit-mode="bookmarkEditMode = $event"
                    @page-context-menu="showPageContextMenu"
                    @page-rotate-cw="(pages) => handlePageRotate(pages, 90)"
                    @page-rotate-ccw="(pages) => handlePageRotate(pages, 270)"
                    @page-extract="(pages) => pageOpsExtract(pages)"
                    @page-export="(pages) => handleExportImages(pages)"
                    @page-delete="(pages) => pageOpsDelete(pages, totalPages)"
                    @page-reorder="(order) => pageOpsReorder(order)"
                    @page-file-drop="handlePageFileDrop"
                />
            </template>

            <WorkspaceViewerHost
                :has-document="Boolean(pdfSrc)"
                :suppress-empty-state="suppressEmptyState"
            >
                <template #document>
                    <PdfViewer
                        ref="pdfViewerRef"
                        :src="pdfSrc!"
                        :zoom="zoom"
                        :fit-mode="fitMode"
                        :view-mode="viewMode"
                        :drag-mode="dragMode"
                        :continuous-scroll="continuousScroll"
                        :annotation-tool="annotationTool"
                        :annotation-cursor-mode="annotationCursorMode"
                        :annotation-keep-active="annotationKeepActive"
                        :annotation-settings="annotationSettings"
                        :search-page-matches="pageMatches"
                        :current-search-match="currentResult"
                        :working-copy-path="workingCopyPath"
                        :author-name="appSettings.authorName"
                        @update:zoom="zoom = $event"
                        @update:current-page="handleViewerCurrentPageUpdate"
                        @update:total-pages="handleViewerTotalPagesUpdate"
                        @update:document="pdfDocument = $event"
                        @loading="isLoading = $event"
                        @annotation-state="handleAnnotationState"
                        @annotation-modified="handleAnnotationModified"
                        @annotation-comments="annotationComments = $event"
                        @annotation-open-note="handleOpenAnnotationNote"
                        @annotation-comment-click="handleAnnotationCommentClick"
                        @annotation-context-menu="handleViewerAnnotationContextMenu"
                        @annotation-tool-auto-reset="handleAnnotationToolAutoReset"
                        @annotation-tool-cancel="handleAnnotationToolCancel"
                        @annotation-setting="handleAnnotationSettingChange"
                        @annotation-note-placement-change="annotationPlacingPageNote = $event"
                        @shape-context-menu="handleShapeContextMenu"
                    />
                </template>
                <template #empty>
                    <PdfEmptyState
                        :recent-files="recentFiles"
                        :open-batch-progress="openBatchProgress"
                        @open-file="handleOpenFileFromUi"
                        @open-recent="openRecentFile"
                        @remove-recent="removeRecentFile"
                        @clear-recent="clearRecentFiles"
                    />
                </template>
            </WorkspaceViewerHost>
        </WorkspaceSidebarHost>
        <div
            v-if="isExportInProgress"
            class="pointer-events-none absolute bottom-12 right-4 z-50 flex items-center gap-2 rounded-md border border-default bg-default/95 px-3 py-2 text-xs text-default shadow-lg"
            role="status"
            aria-live="polite"
        >
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
            <span>{{ t('export.inProgress') }}</span>
        </div>
        <Teleport v-if="isActive && canTeleportStatus" to="#editor-global-status-host">
            <PdfStatusBar
                :file-path="statusFilePath"
                :file-size-label="statusFileSizeLabel"
                :zoom-label="statusZoomLabel"
                :can-show-in-folder="statusCanShowInFolder"
                :show-in-folder-tooltip="statusShowInFolderTooltip"
                :show-in-folder-aria-label="statusShowInFolderAriaLabel"
                :save-dot-class="statusSaveDotClass"
                :save-dot-tooltip="statusSaveDotTooltip"
                :save-dot-aria-label="statusSaveDotAriaLabel"
                :can-save="statusSaveDotCanSave"
                @show-in-folder="handleStatusShowInFolderClick"
                @save="handleStatusSaveClick"
            />
        </Teleport>
        <WorkspaceAnnotationOverlays
            :sorted-annotation-note-windows="sortedAnnotationNoteWindows"
            :annotation-note-positions="annotationNotePositions"
            :annotation-viewport-root="pdfViewerRef?.getViewerContainer?.() ?? null"
            :annotation-zoom="zoom"
            :annotation-context-menu="annotationContextMenu"
            :annotation-context-menu-style="annotationContextMenuStyle"
            :annotation-context-menu-can-copy="annotationContextMenuCanCopy"
            :annotation-context-menu-can-copy-selection="annotationContextMenuCanCopySelection"
            :annotation-context-menu-can-create-free="annotationContextMenuCanCreateFree"
            :context-menu-annotation-label="contextMenuAnnotationLabel"
            :context-menu-delete-action-label="contextMenuDeleteActionLabel"
            :page-context-menu="pageContextMenu"
            :page-context-menu-style="pageContextMenuStyle"
            :is-page-operation-in-progress="isPageOperationInProgress"
            :is-djvu-mode="isDjvuMode"
            :selected-shape-for-properties="selectedShapeForProperties"
            :shape-properties-x="shapePropertiesPopover.x"
            :shape-properties-y="shapePropertiesPopover.y"
            @update-note-text="updateAnnotationNoteText"
            @update-note-position="updateAnnotationNotePosition"
            @minimize-note="minimizeAnnotationNote"
            @restore-note="restoreAnnotationNote"
            @delete-comment="handleDeleteAnnotationComment"
            @focus-note="bringAnnotationNoteToFront"
            @context-open-note="openContextMenuNote"
            @context-copy-text="copyContextMenuNoteText"
            @context-copy-selection-text="copyContextMenuSelectionText"
            @context-delete="deleteContextMenuComment"
            @context-markup="createContextMenuMarkup"
            @context-create-free-note="createContextMenuFreeNote"
            @context-create-selection-note="createContextMenuSelectionNote"
            @page-delete="handlePageContextMenuDelete"
            @page-extract="handlePageContextMenuExtract"
            @page-export="handlePageContextMenuExport"
            @page-rotate-cw="handlePageContextMenuRotateCw"
            @page-rotate-ccw="handlePageContextMenuRotateCcw"
            @page-insert-before="handlePageContextMenuInsertBefore"
            @page-insert-after="handlePageContextMenuInsertAfter"
            @page-select-all="handlePageContextMenuSelectAll"
            @page-invert-selection="handlePageContextMenuInvertSelection"
            @shape-update="handleShapePropertyUpdate"
            @shape-close="closeShapeProperties"
        />

        <DjvuConversionOverlay
            :is-converting="conversionState.isConverting && !djvuIsLoadingPages"
            :phase="conversionState.phase"
            :percent="conversionState.percent"
            @cancel="handleDjvuCancel"
        />

        <PdfExportScopeDialog
            v-model:open="exportScopeDialogOpen"
            :mode="exportScopeDialogMode"
            :total-pages="totalPages"
            :current-page="currentPage"
            :selected-pages="exportScopeDialogSelectedPages"
            @submit="handleExportScopeDialogSubmit"
            @update:open="handleExportScopeDialogOpenChange"
        />

        <DjvuConvertDialog
            v-if="isDjvuMode"
            v-model:open="showConvertDialog"
            :djvu-path="djvuSourcePath"
            @convert="handleDjvuConvert"
        />
    </WorkspaceShell>
</template>

<script setup lang="ts">

import '@app/assets/css/pdfjs-overrides.css';
import '@app/assets/css/pdf-comment-markers.css';
import '@app/assets/css/pdf-comment-ui.css';
import '@app/assets/css/pdf-search-highlights.css';
import '@app/assets/css/pdf-animations.css';
import '@app/assets/css/pdf-debug-overlays.css';
import { createWorkspaceExpose } from '@app/composables/page/createWorkspaceExpose';
import { useWorkspaceOrchestration } from '@app/modules/workspace-shell/service';
import { useWorkspaceRestoreTracker } from '@app/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/composables/useWorkspaceSplitCache';
import type { TOpenFileResult } from '@contracts/electron-api';
import type { TTabUpdate } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import { BrowserLogger } from '@app/utils/browser-logger';

const props = defineProps<{
    tabId: string;
    isActive: boolean;
    isTabTransitionBusy: boolean;
    pendingDocumentOpen?: boolean;
}>();

const canTeleportToolbar = computed(() => (
    import.meta.client
    && Boolean(document.getElementById('editor-global-toolbar-host'))
));
const canTeleportStatus = computed(() => (
    import.meta.client
    && Boolean(document.getElementById('editor-global-status-host'))
));

const emit = defineEmits<{
    'update-tab': [updates: TTabUpdate];
    'open-in-new-tab': [result: TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
}>();

const { t } = useTypedI18n();
const workspaceSplitCache = useWorkspaceSplitCache();
const workspaceRestoreTracker = useWorkspaceRestoreTracker();
const SPLIT_CACHE_LOG_SECTION = 'split-cache';
const isRestoringSplitPayload = ref(false);
const currentPageTransitionHistory = ref<Array<{
    page: number;
    at: number 
}>>([]);

const hasQueuedSplitRestore = computed(() => workspaceSplitCache.has(props.tabId));
const isExternallyRestoring = computed(() => workspaceRestoreTracker.has(props.tabId));
const suppressEmptyState = computed(() => (
    isRestoringSplitPayload.value
    || hasQueuedSplitRestore.value
    || isExternallyRestoring.value
    || props.pendingDocumentOpen === true
));

const w = useWorkspaceOrchestration({
    isActive: toRef(props, 'isActive'),
    emit,
});

const {
    pdfSrc,
    pdfError,
    workingCopyPath,
    pdfDocument,
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
    openBatchProgress,
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
    zoom,
    fitMode,
    viewMode,
    currentPage,
    totalPages,
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
    bringAnnotationNoteToFront,
    shapePropertiesPopover,
    selectedShapeForProperties,
    handleQuickNoteAction,
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
} = w;

const toolbarHasPdf = computed(() => (
    hasPdf.value
    || hasQueuedSplitRestore.value
    || isRestoringSplitPayload.value
    || isExternallyRestoring.value
    || props.pendingDocumentOpen === true
));
function handleViewerTotalPagesUpdate(value: number) {
    // During split restore the PdfViewer emits totalPages=0 while it starts
    // loading the "new" source, overwriting the pre-seeded cache value.
    // Suppress the transient 0 whenever a document is already loaded — the
    // viewer will emit the real count once parsing finishes.
    if (value === 0 && hasPdf.value) {
        return;
    }
    totalPages.value = value;
}

const canExportDocx = computed(() => (
    Boolean(workingCopyPath.value)
    && !isAnySaving.value
    && !isHistoryBusy.value
    && !isExportingDocx.value
));

function runToolbarAction(action: () => unknown) {
    const result = action();
    if (result instanceof Promise) {
        void result;
    }
    closeAllDropdowns();
}

function handleToolbarSave() {
    runToolbarAction(handleSave);
}

function handleToolbarSaveAs() {
    runToolbarAction(handleSaveAs);
}

function handleToolbarExportDocx() {
    runToolbarAction(handleExportDocx);
}

function handleToolbarUndo() {
    runToolbarAction(handleUndo);
}

function handleToolbarRedo() {
    runToolbarAction(handleRedo);
}

function handleToolbarToggleSidebar() {
    const attemptId = `sidebar-toggle-${crypto.randomUUID()}`;
    const beforePage = currentPage.value;
    const beforeSidebar = showSidebar.value;
    const viewer = pdfViewerRef.value?.getViewerContainer?.() ?? null;
    const beforeViewerScrollTop = viewer ? Math.round(viewer.scrollTop) : null;
    BrowserLogger.warn('pdf-nav', 'Toolbar sidebar toggle requested', {
        attemptId,
        beforeSidebar,
        beforePage,
        sidebarTab: sidebarTab.value,
        totalPages: totalPages.value,
        isLoading: isLoading.value,
        continuousScroll: continuousScroll.value,
        fitMode: fitMode.value,
        viewMode: viewMode.value,
        zoom: zoom.value,
        viewerScrollTop: beforeViewerScrollTop,
    });
    runToolbarAction(() => {
        showSidebar.value = !showSidebar.value;
        BrowserLogger.warn('pdf-nav', 'Toolbar sidebar toggle applied', {
            attemptId,
            afterSidebar: showSidebar.value,
            pageAfterToggleWrite: currentPage.value,
        });
    });

    const checkpointSchedule = [
        0,
        50,
        150,
        350,
        700,
        1200,
    ];
    checkpointSchedule.forEach((delayMs) => {
        setTimeout(() => {
            const checkpointViewer = pdfViewerRef.value?.getViewerContainer?.() ?? null;
            BrowserLogger.warn(
                'pdf-nav',
                `[sidebar-toggle-checkpoint] attempt=${attemptId} t+${delayMs}ms page=${currentPage.value} sidebar=${showSidebar.value}`,
                {
                    attemptId,
                    delayMs,
                    page: currentPage.value,
                    sidebarOpen: showSidebar.value,
                    sidebarTab: sidebarTab.value,
                    isResizingSidebar: isResizingSidebar.value,
                    fitMode: fitMode.value,
                    viewMode: viewMode.value,
                    continuousScroll: continuousScroll.value,
                    zoom: zoom.value,
                    viewerScrollTop: checkpointViewer ? Math.round(checkpointViewer.scrollTop) : null,
                    viewerScrollLeft: checkpointViewer ? Math.round(checkpointViewer.scrollLeft) : null,
                    viewerClientHeight: checkpointViewer ? Math.round(checkpointViewer.clientHeight) : null,
                },
            );
        }, delayMs);
    });
}

function handleToolbarFitWidth() {
    runToolbarAction(() => {
        handleFitMode('width');
    });
}

function handleToolbarFitHeight() {
    runToolbarAction(() => {
        handleFitMode('height');
    });
}

function handleToolbarToggleContinuousScroll() {
    runToolbarAction(() => {
        continuousScroll.value = !continuousScroll.value;
    });
}

function handleToolbarEnableDrag() {
    runToolbarAction(enableDragMode);
}

function handleToolbarDisableDrag() {
    runToolbarAction(() => {
        handleAnnotationToolChange('none');
    });
}

function handleToolbarCaptureRegion() {
    runToolbarAction(handleCaptureRegion);
}

function handleToolbarQuickNote() {
    runToolbarAction(handleQuickNoteAction);
}

function handleViewerCurrentPageUpdate(page: number) {
    const previousPage = currentPage.value;
    const viewer = pdfViewerRef.value?.getViewerContainer?.() ?? null;
    BrowserLogger.warn('pdf-nav', `[workspace-page-update] viewer->workspace ${previousPage}->${page}`, {
        previousPage,
        nextPage: page,
        changed: page !== previousPage,
        sidebarOpen: showSidebar.value,
        sidebarTab: sidebarTab.value,
        totalPages: totalPages.value,
        isLoading: isLoading.value,
        continuousScroll: continuousScroll.value,
        fitMode: fitMode.value,
        viewMode: viewMode.value,
        zoom: zoom.value,
        viewerScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
        viewerScrollLeft: viewer ? Math.round(viewer.scrollLeft) : null,
    });
    currentPage.value = page;
}

function handleOverflowSetViewMode(mode: typeof viewMode.value) {
    runToolbarAction(() => {
        viewMode.value = mode;
    });
}

function handleOverflowOpenSettings() {
    runToolbarAction(() => {
        emit('open-settings');
    });
}

async function restoreCachedSplitPayloadIfNeeded() {
    if (!workspaceSplitCache.has(props.tabId) || hasPdf.value) {
        return;
    }

    const payload = workspaceSplitCache.consume(props.tabId);
    if (!payload) {
        return;
    }

    isRestoringSplitPayload.value = true;
    try {
        if (payload.kind === 'pdfSnapshot') {
            if (payload.currentPage && Number.isFinite(payload.currentPage)) {
                currentPage.value = Math.max(1, Math.floor(payload.currentPage));
            }
            if (payload.totalPages && Number.isFinite(payload.totalPages)) {
                const normalizedTotalPages = Math.max(
                    currentPage.value,
                    Math.floor(payload.totalPages),
                );
                totalPages.value = Math.max(totalPages.value, normalizedTotalPages);
            }
        }
        BrowserLogger.warn('toolbar-transition', 'Restoring cached split payload', {
            tabId: props.tabId,
            payloadKind: payload.kind,
            hadPdfBeforeRestore: hasPdf.value,
            payloadCurrentPage: payload.kind === 'pdfSnapshot' ? payload.currentPage : null,
            payloadTotalPages: payload.kind === 'pdfSnapshot' ? payload.totalPages : null,
            preseededCurrentPage: currentPage.value,
            preseededTotalPages: totalPages.value,
        });

        await restoreSplitPayload(payload);
    } catch (error) {
        BrowserLogger.warn('workspace', 'Failed to restore cached split payload', {
            tabId: props.tabId,
            payloadKind: payload.kind,
            error,
        });
    } finally {
        isRestoringSplitPayload.value = false;
    }
}

const canCacheSplitPayloadForRemount = computed(() => (
    props.isTabTransitionBusy === true
    && !isRestoringSplitPayload.value
    && !isExternallyRestoring.value
    && props.pendingDocumentOpen !== true
));

async function cacheSplitPayloadForRemount() {
    if (!canCacheSplitPayloadForRemount.value) {
        BrowserLogger.debug(SPLIT_CACHE_LOG_SECTION, 'Skipping split payload cache on unmount', {
            tabId: props.tabId,
            reason: 'guard-blocked',
            isTabTransitionBusy: props.isTabTransitionBusy,
            isRestoringSplitPayload: isRestoringSplitPayload.value,
            isExternallyRestoring: isExternallyRestoring.value,
            pendingDocumentOpen: props.pendingDocumentOpen === true,
        });
        return;
    }

    if (workspaceSplitCache.has(props.tabId)) {
        BrowserLogger.debug(SPLIT_CACHE_LOG_SECTION, 'Skipping split payload cache on unmount', {
            tabId: props.tabId,
            reason: 'cache-already-populated',
        });
        return;
    }

    try {
        const payload = await captureSplitPayload();
        if (payload.kind === 'empty') {
            BrowserLogger.debug(SPLIT_CACHE_LOG_SECTION, 'Skipping split payload cache on unmount', {
                tabId: props.tabId,
                reason: 'captured-empty-payload',
            });
            return;
        }
        workspaceSplitCache.set(props.tabId, payload);
        BrowserLogger.debug(SPLIT_CACHE_LOG_SECTION, 'Cached split payload on unmount', {
            tabId: props.tabId,
            payloadKind: payload.kind,
        });
    } catch (error) {
        BrowserLogger.warn('workspace', 'Failed to cache split payload on unmount', {
            tabId: props.tabId,
            error,
        });
    }
}

onMounted(() => {
    initFromStorage();
    setupShortcuts();
});

watch(
    [
        hasQueuedSplitRestore,
        hasPdf,
        isRestoringSplitPayload,
        isExternallyRestoring,
    ],
    ([
        hasQueued,
        hasLoadedPdf,
        isRestoring,
        isExternalRestoreInProgress,
    ]) => {
        if (!hasQueued || hasLoadedPdf || isRestoring || isExternalRestoreInProgress) {
            return;
        }
        void restoreCachedSplitPayloadIfNeeded();
    },
    { immediate: true },
);

onBeforeUnmount(() => {
    void cacheSplitPayloadForRemount();
});

watch(showSidebar, (next, previous) => {
    if (next === previous) {
        return;
    }
    const viewer = pdfViewerRef.value?.getViewerContainer?.() ?? null;
    BrowserLogger.warn('pdf-nav', `[workspace-sidebar] ${previous ? 'open' : 'closed'} -> ${next ? 'open' : 'closed'}`, {
        previous,
        next,
        currentPage: currentPage.value,
        sidebarTab: sidebarTab.value,
        isResizingSidebar: isResizingSidebar.value,
        totalPages: totalPages.value,
        isLoading: isLoading.value,
        viewerScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
    });
});

watch(currentPage, (next, previous) => {
    if (next === previous) {
        return;
    }
    const viewer = pdfViewerRef.value?.getViewerContainer?.() ?? null;
    BrowserLogger.warn('pdf-nav', `[workspace-page-ref] ${previous}->${next}`, {
        previous,
        next,
        sidebarOpen: showSidebar.value,
        sidebarTab: sidebarTab.value,
        isLoading: isLoading.value,
        continuousScroll: continuousScroll.value,
        fitMode: fitMode.value,
        viewMode: viewMode.value,
        zoom: zoom.value,
        viewerScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
        viewerScrollLeft: viewer ? Math.round(viewer.scrollLeft) : null,
    });

    const now = Date.now();
    currentPageTransitionHistory.value = [
        ...currentPageTransitionHistory.value,
        {
            page: next,
            at: now,
        },
    ].filter((entry) => now - entry.at <= 2000).slice(-8);

    const history = currentPageTransitionHistory.value;
    if (history.length >= 3) {
        const last = history[history.length - 1]!;
        const mid = history[history.length - 2]!;
        const first = history[history.length - 3]!;
        const isBounce = first.page === last.page && first.page !== mid.page;
        if (isBounce) {
            BrowserLogger.warn('pdf-nav', `[workspace-page-bounce] detected ${first.page}->${mid.page}->${last.page}`, {
                history: history.map((entry) => ({
                    page: entry.page,
                    dtMs: now - entry.at,
                })),
                sidebarOpen: showSidebar.value,
                sidebarTab: sidebarTab.value,
                isResizingSidebar: isResizingSidebar.value,
                fitMode: fitMode.value,
                viewMode: viewMode.value,
                continuousScroll: continuousScroll.value,
                zoom: zoom.value,
            });
        }
    }
});

watch(
    () => [
        fitMode.value,
        viewMode.value,
        continuousScroll.value,
        zoom.value,
    ] as const,
    ([
        nextFit,
        nextViewMode,
        nextContinuous,
        nextZoom,
    ], [
        prevFit,
        prevViewMode,
        prevContinuous,
        prevZoom,
    ]) => {
        if (
            nextFit === prevFit
            && nextViewMode === prevViewMode
            && nextContinuous === prevContinuous
            && nextZoom === prevZoom
        ) {
            return;
        }
        BrowserLogger.warn('pdf-nav', 'DocumentWorkspace view controls changed', {
            fitMode: {
                previous: prevFit,
                next: nextFit, 
            },
            viewMode: {
                previous: prevViewMode,
                next: nextViewMode, 
            },
            continuousScroll: {
                previous: prevContinuous,
                next: nextContinuous, 
            },
            zoom: {
                previous: prevZoom,
                next: nextZoom, 
            },
            currentPage: currentPage.value,
            sidebarOpen: showSidebar.value,
        });
    },
);

onUnmounted(() => {
    cleanupSidebarResizeListeners();
    cleanupShortcuts();
});

const workspaceExpose: IWorkspaceExpose = createWorkspaceExpose({
    handleSave,
    handleSaveAs,
    handleUndo,
    handleRedo,
    handleOpenFileFromUi,
    handleOpenFileDirectWithPersist,
    handleOpenFileDirectBatchWithPersist,
    handleOpenFileWithResult,
    handleCloseFileFromUi,
    handleExportDocx,
    handleExportImages,
    handleExportMultiPageTiff,
    hasPdf,
    canSave,
    canUndo,
    canRedo,
    canExportDocx,
    isSaving,
    isSavingAs,
    isAnySaving,
    isHistoryBusy,
    isExportingDocx,
    isFitWidthActive,
    isFitHeightActive,
    showSidebar,
    dragMode,
    continuousScroll,
    isCapturingRegion,
    isPlacingPageNote: annotationPlacingPageNote,
    closeAllDropdowns,
    zoom,
    fitMode,
    viewMode,
    currentPage,
    handleFitMode,
    handleToggleSidebar: () => {
        showSidebar.value = !showSidebar.value;
    },
    handleToggleContinuousScroll: () => {
        continuousScroll.value = !continuousScroll.value;
    },
    handleEnableDragMode: () => {
        enableDragMode();
    },
    handleDisableDragMode: () => {
        handleAnnotationToolChange('none');
    },
    handleCaptureRegion: () => {
        void handleCaptureRegion();
    },
    handleQuickNote: () => {
        void handleQuickNoteAction();
    },
    selectedThumbnailPages,
    pageOpsDelete,
    pageOpsExtract,
    handlePageRotate,
    pageOpsInsert,
    totalPages,
    isDjvuMode,
    openConvertDialog,
    captureSplitPayload,
    restoreSplitPayload,
});

defineExpose(workspaceExpose);
</script>
