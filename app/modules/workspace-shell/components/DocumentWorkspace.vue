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
                :show-sidebar="toolbarShowSidebar"
                :can-toggle-sidebar="canToggleSidebar"
                :drag-mode="dragMode"
                :continuous-scroll="continuousScroll"
                :is-djvu-mode="isDjvuMode"
                :is-capturing-region="isCapturingRegion"
                :is-crop-selecting="isCropSelecting"
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
                @crop="handleToolbarCrop"
                @quick-note="handleToolbarQuickNote"
            >
                <template #app-menu>
                    <ToolbarAppMenu
                        :open="appMenuOpen"
                        :has-pdf="toolbarHasPdf"
                        :can-save="canSave"
                        :can-undo="canUndo"
                        :can-redo="canRedo"
                        :can-export-docx="canExportDocx"
                        :is-any-saving="isAnySaving"
                        :is-history-busy="isHistoryBusy"
                        :is-exporting-docx="isExportingDocx"
                        :is-djvu-mode="isDjvuMode"
                        :can-use-djvu="canUseDjvu"
                        @update:open="handleDropdownOpen('appMenu', $event)"
                        @open-file="handleOpenFileFromUi"
                        @save="handleToolbarSave"
                        @save-as="handleToolbarSaveAs"
                        @combine-images="handleCombineImages"
                        @export-docx="handleToolbarExportDocx"
                        @export-images="handleExportImages()"
                        @export-multi-page-tiff="handleExportMultiPageTiff()"
                        @convert-to-pdf="openConvertDialog"
                        @undo="handleToolbarUndo"
                        @redo="handleToolbarRedo"
                        @insert-image-from-file="handleInsertImageFromFile"
                        @paste-image-from-clipboard="handlePasteImageFromClipboard"
                        @delete-pages="handleDeletePages"
                        @extract-pages="handleExtractPages"
                        @rotate-cw="handleRotateCw"
                        @rotate-ccw="handleRotateCcw"
                        @insert-pages="handleInsertPages"
                    />
                </template>
                <template v-if="canUseOcr" #ocr="{ isCollapsed }">
                    <OcrPopup
                        :pdf-document="pdfDocument"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :working-copy-path="workingCopyPath"
                        :open="ocrPopupOpen"
                        :is-exporting-docx="isExportingDocx"
                        :external-error="docxExportError"
                        :disabled="isDjvuMode || !toolbarHasPdf"
                        :hide-trigger="isCollapsed(2)"
                        @update:open="handleDropdownOpen('ocr', $event)"
                        @export-docx="handleExportDocx"
                        @ocr-complete="handleOcrComplete"
                    />
                </template>
                <template #zoom-dropdown>
                    <PdfZoomDropdown
                        v-model:zoom="zoom"
                        v-model:zoom-mode="zoomMode"
                        v-model:fit-mode="fitMode"
                        v-model:view-mode="viewMode"
                        :effective-zoom="effectiveZoom"
                        :open="zoomDropdownOpen"
                        :disabled="!toolbarHasPdf"
                        :compact-level="0"
                        @update:effective-zoom="effectiveZoom = $event"
                        @update:open="handleDropdownOpen('zoom', $event)"
                    />
                </template>
                <template #page-dropdown="{ collapseTier }">
                    <PdfPageDropdown
                        v-model="currentPage"
                        :open="pageDropdownOpen"
                        :total-pages="totalPages"
                        :view-mode="viewMode"
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
                        :can-use-ocr="canUseOcr"
                        :drag-mode="dragMode"
                        :continuous-scroll="continuousScroll"
                        :view-mode="viewMode"
                        :is-djvu-mode="isDjvuMode"
                        :is-fit-width-active="isFitWidthActive"
                        :is-fit-height-active="isFitHeightActive"
                        :is-capturing-region="isCapturingRegion"
                        :is-crop-selecting="isCropSelecting"
                        @update:open="handleDropdownOpen('overflow', $event)"
                        @capture-region="handleToolbarCaptureRegion"
                        @crop="handleToolbarCrop"
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
            v-if="canUseDjvu && isDjvuMode && djvuError"
            color="error"
            variant="soft"
            class="mx-3 mt-2"
            :description="String(djvuError)"
            :ui="{ title: 'sr-only' }"
        />

        <DjvuBanner
            v-if="canUseDjvu && isDjvuMode"
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
                    :search-options="searchOptions"
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
                    @update:search-options="searchOptions = $event"
                    @go-to-page="handleGoToPage"
                    @go-to-result="handleGoToResult"
                    @update:page-label-ranges="handlePageLabelRangesUpdate"
                    @update:annotation-tool="handleAnnotationToolChange"
                    @update:annotation-keep-active="annotationKeepActive = $event"
                    @annotation-setting="handleAnnotationSettingChange"
                    @update:selected-thumbnail-pages="handleSelectedThumbnailPagesUpdate"
                    @annotation-focus-comment="handleAnnotationFocusComment"
                    @annotation-open-note="handleOpenAnnotationNote"
                    @annotation-delete-comment="handleDeleteAnnotationComment"
                    @annotation-place-note="handleStartPlaceNote"
                    @bookmarks-change="handleBookmarksChange"
                    @update:bookmark-edit-mode="bookmarkEditMode = $event"
                    @page-context-menu="showPageContextMenu"
                    @page-rotate-cw="(pages: number[]) => handlePageRotate(pages, 90)"
                    @page-rotate-ccw="(pages: number[]) => handlePageRotate(pages, 270)"
                    @page-extract="(pages: number[]) => pageOpsExtract(pages)"
                    @page-export="(pages: number[]) => handleExportImages(pages)"
                    @page-delete="(pages: number[]) => pageOpsDelete(pages, totalPages)"
                    @page-reorder="(order: number[]) => pageOpsReorder(order)"
                    @page-file-drop="handlePageFileDrop"
                />
            </template>

            <WorkspaceViewerHost
                :has-document="Boolean(pdfSrc) || showNativeDjvuViewer"
                :suppress-empty-state="suppressEmptyState || isDjvuOpening"
            >
                <template #document>
                    <PdfViewer
                        v-if="pdfSrc"
                        ref="pdfViewerRef"
                        :src="pdfSrc!"
                        :is-any-saving="isAnySaving"
                        :zoom="zoom"
                        :zoom-mode="zoomMode"
                        :fit-mode="fitMode"
                        :view-mode="viewMode"
                        :drag-mode="dragMode"
                        :continuous-scroll="continuousScroll"
                        :is-resizing="isResizingSidebar"
                        :annotation-tool="annotationTool"
                        :annotation-cursor-mode="annotationCursorMode"
                        :annotation-keep-active="annotationKeepActive"
                        :annotation-settings="annotationSettings"
                        :search-page-matches="pageMatches"
                        :current-search-match="currentResult"
                        :working-copy-path="workingCopyPath"
                        :author-name="appSettings.authorName"
                        @update:zoom="zoom = $event"
                        @update:zoom-mode="zoomMode = $event"
                        @update:fit-mode="fitMode = $event"
                        @update:effective-zoom="effectiveZoom = $event"
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
                        @image-placement-finalize="handleFinalizePlacedImage"
                    />
                    <DjvuViewer
                        v-else-if="showNativeDjvuViewer"
                        ref="pdfViewerRef"
                        :src="djvuSourcePath!"
                        :zoom="zoom"
                        :zoom-mode="zoomMode"
                        :fit-mode="fitMode"
                        :view-mode="viewMode"
                        :continuous-scroll="continuousScroll"
                        :drag-mode="dragMode"
                        @update:effective-zoom="effectiveZoom = $event"
                        @update:current-page="handleViewerCurrentPageUpdate"
                        @update:total-pages="handleViewerTotalPagesUpdate"
                        @update:document="pdfDocument = $event"
                        @loading="isLoading = $event"
                    />
                </template>
                <template #empty>
                    <PdfEmptyState
                        :recent-files="recentFiles"
                        :recent-files-resolved="recentFilesResolved"
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
            :annotation-zoom="effectiveZoom"
            :annotation-context-menu="annotationContextMenu"
            :annotation-context-menu-style="annotationContextMenuStyle"
            :annotation-context-menu-can-copy="annotationContextMenuCanCopy"
            :annotation-context-menu-can-copy-selection="annotationContextMenuCanCopySelection"
            :annotation-context-menu-can-create-free="annotationContextMenuCanCreateFree"
            :annotation-context-menu-can-insert-image="annotationContextMenuCanInsertImage"
            :annotation-context-menu-is-image="annotationContextMenuIsImage"
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
            @context-insert-image-from-file="insertContextMenuImageFromFile"
            @context-paste-image-from-clipboard="pasteContextMenuImageFromClipboard"
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
            v-if="canUseDjvu"
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

        <PdfCropDialog
            v-model:open="cropDialogOpen"
            :loading="cropDialogLoading"
            :total-pages="totalPages"
            :current-page="cropDialogPageNumber"
            :selected-pages="selectedThumbnailPages"
            :initial-margins="cropDialogMargins"
            :media-box="cropDialogMediaBox"
            :current-visible-box="cropDialogCurrentBox"
            :rotation="cropDialogRotation"
            @apply="handleCropApply"
            @remove="handleCropRemove"
        />

        <DjvuConvertDialog
            v-if="canUseDjvu && isDjvuMode"
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
import PdfEmptyState from '@app/components/pdf/PdfEmptyState.vue';
import PdfCropDialog from '@app/components/pdf/PdfCropDialog.vue';
import PdfExportScopeDialog from '@app/components/pdf/PdfExportScopeDialog.vue';
import PdfPageDropdown from '@app/components/pdf/PdfPageDropdown.vue';
import PdfSidebar from '@app/components/pdf/PdfSidebar.vue';
import PdfStatusBar from '@app/components/pdf/PdfStatusBar.vue';
import PdfToolbar from '@app/components/pdf/PdfToolbar.vue';
import PdfViewer from '@app/components/pdf/PdfViewer.vue';
import PdfZoomDropdown from '@app/components/pdf/PdfZoomDropdown.vue';
import ToolbarAppMenu from '@app/components/toolbar/ToolbarAppMenu.vue';
import ToolbarOverflowMenu from '@app/components/toolbar/ToolbarOverflowMenu.vue';
import { useAnalytics } from '@app/composables/useAnalytics';
import { bucketPageCount } from '@app/utils/analytics';
import { createWorkspaceExpose } from '@app/modules/workspace-shell/composables/createWorkspaceExpose';
import WorkspaceAnnotationOverlays from '@app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue';
import WorkspaceShell from '@app/modules/workspace-shell/components/layout/WorkspaceShell.vue';
import WorkspaceSidebarHost from '@app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue';
import WorkspaceToolbarHost from '@app/modules/workspace-shell/components/layout/WorkspaceToolbarHost.vue';
import WorkspaceViewerHost from '@app/modules/workspace-shell/components/layout/WorkspaceViewerHost.vue';
import { useDocumentWorkspaceSplitRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore';
import { useDocumentWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceToolbar';
import { useWorkspaceOrchestration } from '@app/modules/workspace-shell/useWorkspaceOrchestration';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import type { TOpenFileResult } from '@contracts/platform-api';
import type { TTabUpdate } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import { BrowserLogger } from '@app/utils/browser-logger';
import { hasElectronAPI } from '@app/utils/platform';

const OcrPopup = defineAsyncComponent(() => import('@app/components/ocr/OcrPopup.vue'));
const DjvuBanner = defineAsyncComponent(() => import('@app/components/djvu/DjvuBanner.vue'));
const DjvuConversionOverlay = defineAsyncComponent(() => import('@app/components/djvu/DjvuConversionOverlay.vue'));
const DjvuConvertDialog = defineAsyncComponent(() => import('@app/components/djvu/DjvuConvertDialog.vue'));
const DjvuViewer = defineAsyncComponent(() => import('@app/components/djvu/DjvuViewer.vue'));

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
const hasDesktopRuntime = hasElectronAPI();
const canUseOcr = hasDesktopRuntime;
const canUseDjvu = true;

const emit = defineEmits<{
    'update-tab': [updates: TTabUpdate];
    'open-in-new-tab': [result: TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
}>();

const { t } = useTypedI18n();
const analytics = useAnalytics();
const { isResolved: recentFilesResolved } = useRecentFiles();
const workspaceSplitCache = useWorkspaceSplitCache();
const workspaceRestoreTracker = useWorkspaceRestoreTracker();
const isRestoringSplitPayload = ref(false);
const currentPageTransitionHistory = ref<Array<{
    page: number;
    at: number 
}>>([]);
const pendingDocumentOpen = computed(() => props.pendingDocumentOpen === true);

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
    djvuOpeningPath,
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
    appMenuOpen,
    selectedThumbnailPages,
    thumbnailInvalidationRequest,
    handleSelectedThumbnailPagesUpdate,
    handleDropdownOpen,
    closeAllDropdowns,
    zoom,
    effectiveZoom,
    zoomMode,
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
    annotationContextMenuCanInsertImage,
    annotationContextMenuIsImage,
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
    searchOptions,
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
    handleCrop,
    isCropSelecting,
    cropDialogOpen,
    cropDialogLoading,
    cropDialogMargins,
    cropDialogMediaBox,
    cropDialogCurrentBox,
    cropDialogPageNumber,
    cropDialogRotation,
    handleCropPages,
    handleRemoveCrop,
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
    handleInsertImageFromFile,
    handlePasteImageFromClipboard,
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
    insertContextMenuImageFromFile,
    pasteContextMenuImageFromClipboard,
    createContextMenuMarkup,
    handleFinalizePlacedImage,
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
    handleCombineImages,
    handleOpenFileDirectWithPersist,
    handleOpenFileDirectBatchWithPersist,
    handleOpenFileWithResult,
    handleCloseFileFromUi,
    openRecentFile,
    captureSplitPayload,
    restoreSplitPayload,
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

const showNativeDjvuViewer = computed(() => (
    isDjvuMode.value
    && Boolean(djvuSourcePath.value)
    && !pdfSrc.value
));
const isDjvuOpening = computed(() => (
    Boolean(djvuOpeningPath.value)
    && !showNativeDjvuViewer.value
));
const toolbarHasPdf = computed(() => (
    hasPdf.value
    || showNativeDjvuViewer.value
    || isDjvuOpening.value
    || hasQueuedSplitRestore.value
    || isRestoringSplitPayload.value
    || isExternallyRestoring.value
));
const toolbarShowSidebar = computed(() => (
    showSidebar.value
    && !showNativeDjvuViewer.value
));
const canToggleSidebar = computed(() => (
    toolbarHasPdf.value
    && !showNativeDjvuViewer.value
));
function handleViewerTotalPagesUpdate(value: number) {
    // During split restore the PdfViewer emits totalPages=0 while it starts
    // loading the "new" source, overwriting the pre-seeded cache value.
    // Suppress the transient 0 whenever a document is already loaded — the
    // viewer will emit the real count once parsing finishes.
    if (value === 0 && Boolean(pdfSrc.value)) {
        return;
    }
    totalPages.value = value;
    if (value > 0) {
        analytics.mergeDocumentContext({
            pageCountBucket: bucketPageCount(value),
            totalPages: value,
        });
    }
}

const {
    canExportDocx,
    clearSidebarToggleCheckpointTimers,
    handleCropApply,
    handleCropRemove,
    handleOverflowOpenSettings,
    handleOverflowSetViewMode,
    handleToolbarCaptureRegion,
    handleToolbarCrop,
    handleToolbarDisableDrag,
    handleToolbarEnableDrag,
    handleToolbarExportDocx,
    handleToolbarFitHeight,
    handleToolbarFitWidth,
    handleToolbarQuickNote,
    handleToolbarRedo,
    handleToolbarSave,
    handleToolbarSaveAs,
    handleToolbarToggleContinuousScroll,
    handleToolbarToggleSidebar,
    handleToolbarUndo,
} = useDocumentWorkspaceToolbar({
    tabId: props.tabId,
    emitOpenSettings: () => emit('open-settings'),
    closeAllDropdowns,
    handleSave,
    handleSaveAs,
    handleExportDocx,
    handleUndo,
    handleRedo,
    handleCaptureRegion,
    handleCrop,
    handleQuickNoteAction,
    handleFitMode,
    handleAnnotationToolChange,
    enableDragMode,
    handleRemoveCrop,
    handleCropPages,
    workingCopyPath,
    isAnySaving,
    isHistoryBusy,
    isExportingDocx,
    showSidebar,
    sidebarTab,
    currentPage,
    totalPages,
    isLoading,
    continuousScroll,
    fitMode,
    viewMode,
    zoom,
    pdfViewerRef,
    isResizingSidebar,
});

function handleDeletePages() {
    const pages = selectedThumbnailPages.value;
    if (pages.length > 0) {
        void pageOpsDelete(pages, totalPages.value);
    }
}

function handleExtractPages() {
    const pages = selectedThumbnailPages.value;
    if (pages.length > 0) {
        void pageOpsExtract(pages);
    }
}

function handleRotateCw() {
    const pages = selectedThumbnailPages.value;
    if (pages.length > 0) {
        void handlePageRotate(pages, 90);
    }
}

function handleRotateCcw() {
    const pages = selectedThumbnailPages.value;
    if (pages.length > 0) {
        void handlePageRotate(pages, 270);
    }
}

function handleInsertPages() {
    void pageOpsInsert(totalPages.value, totalPages.value);
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

const {
    hasQueuedSplitRestore,
    isExternallyRestoring,
    suppressEmptyState,
} = useDocumentWorkspaceSplitRestore({
    tabId: props.tabId,
    pendingDocumentOpen,
    isTabTransitionBusy: computed(() => props.isTabTransitionBusy === true),
    workspaceSplitCache,
    workspaceRestoreTracker,
    hasPdf,
    currentPage,
    totalPages,
    showSidebar,
    sidebarTab,
    isResizingSidebar,
    isLoading,
    continuousScroll,
    fitMode,
    viewMode,
    zoom,
    pdfViewerRef,
    initFromStorage,
    cleanupSidebarResizeListeners,
    captureSplitPayload,
    restoreSplitPayload,
    isRestoringSplitPayload,
    currentPageTransitionHistory,
    clearSidebarToggleCheckpointTimers,
});

const workspaceExpose: IWorkspaceExpose = createWorkspaceExpose({
    handleSave,
    handleSaveAs,
    handleUndo: () => {
        void handleUndo();
    },
    handleRedo: () => {
        void handleRedo();
    },
    handleOpenFileFromUi,
    handleCombineImages,
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
    isCropSelecting,
    isPlacingPageNote: annotationPlacingPageNote,
    closeAllDropdowns,
    zoom,
    effectiveZoom,
    zoomMode,
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
    handleInsertImageFromFile: async () => {
        await handleInsertImageFromFile();
    },
    handlePasteImageFromClipboard: async () => {
        await handlePasteImageFromClipboard();
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
