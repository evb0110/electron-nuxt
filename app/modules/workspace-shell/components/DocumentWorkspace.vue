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
                :is-opening-document="pendingDocumentOpen"
                :is-preparing-print="isPreparingPrint"
                :is-preparing-current-page-print="isPreparingCurrentPagePrint"
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
                :document-busy="isDocumentBusy"
                :has-ocr-action="canUseOcr"
                :surface="toolbarSurface"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                @open-file="handleOpenFileFromUi"
                @open-settings="emit('open-settings')"
                @save="handleToolbarSave"
                @save-as="handleToolbarSaveAs"
                @print="handlePrint"
                @print-current-page="handlePrintCurrentPage"
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
                @toggle-fullscreen="emit('toggle-fullscreen')"
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
                        :is-preparing-print="isPreparingPrint"
                        :is-preparing-current-page-print="isPreparingCurrentPagePrint"
                        :is-djvu-mode="isDjvuMode"
                        :can-use-djvu="canUseDjvu"
                        :document-busy="isDocumentBusy"
                        @update:open="handleDropdownOpen('appMenu', $event)"
                        @open-file="handleOpenFileFromUi"
                        @save="handleToolbarSave"
                        @save-as="handleToolbarSaveAs"
                        @print="handlePrint"
                        @print-current-page="handlePrintCurrentPage"
                        @combine-images="emit('open-combine')"
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
                        :disabled="isDjvuMode || isConversionBusy || !toolbarHasPdf"
                        :hide-trigger="isCollapsed(3)"
                        @update:open="handleDropdownOpen('ocr', $event)"
                        @update:running="isOcrRunning = $event"
                        @export-docx="handleExportDocx"
                        @ocr-complete="handleOcrComplete"
                    />
                </template>
                <template #zoom-dropdown="{ collapseTier }">
                    <PdfZoomDropdown
                        v-model:zoom="zoom"
                        v-model:zoom-mode="zoomMode"
                        v-model:fit-mode="fitMode"
                        v-model:view-mode="viewMode"
                        :effective-zoom="effectiveZoom"
                        :open="zoomDropdownOpen"
                        :disabled="!toolbarHasPdf || isDocumentBusy"
                        :compact-level="collapseTier >= 1 ? 1 : 0"
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
                        :disabled="!toolbarHasPdf || isDocumentBusy"
                        :compact-level="collapseTier >= 3 ? 3 : collapseTier >= 2 ? 2 : collapseTier >= 1 ? 1 : 0"
                        @go-to-page="handleGoToPage"
                        @update:open="handleDropdownOpen('page', $event)"
                    />
                </template>
                <template #overflow-menu="{ collapseTier, hasOverflowItems }">
                    <ToolbarOverflowMenu
                        v-if="hasOverflowItems"
                        :open="overflowMenuOpen"
                        :collapse-tier="collapseTier"
                        :can-toggle-sidebar="canToggleSidebar"
                        can-capture-region
                        can-crop
                        can-quick-note
                        :has-pdf="toolbarHasPdf"
                        :can-use-ocr="canUseOcr"
                        :show-sidebar="toolbarShowSidebar"
                        :drag-mode="dragMode"
                        :continuous-scroll="continuousScroll"
                        :view-mode="viewMode"
                        :is-djvu-mode="isDjvuMode"
                        :is-fit-width-active="isFitWidthActive"
                        :is-fit-height-active="isFitHeightActive"
                        :is-capturing-region="isCapturingRegion"
                        :is-crop-selecting="isCropSelecting"
                        :is-placing-page-note="annotationPlacingPageNote"
                        :document-busy="isDocumentBusy"
                        :surface="toolbarSurface"
                        :show-document-section="isDesktopRuntime"
                        can-combine-files
                        can-print-current-page
                        :can-convert-to-pdf="canUseDjvu && isDjvuMode"
                        :is-preparing-print="isPreparingPrint"
                        :is-preparing-current-page-print="isPreparingCurrentPagePrint"
                        :is-fullscreen="isFullscreen"
                        :fullscreen-supported="fullscreenSupported"
                        trigger-icon="i-ph-dots-three"
                        @update:open="handleDropdownOpen('overflow', $event)"
                        @capture-region="handleToolbarCaptureRegion"
                        @crop="handleToolbarCrop"
                        @open-ocr="handleDropdownOpen('ocr', true)"
                        @toggle-sidebar="handleToolbarToggleSidebar"
                        @fit-width="handleToolbarFitWidth"
                        @fit-height="handleToolbarFitHeight"
                        @enable-drag="handleToolbarEnableDrag"
                        @disable-drag="handleToolbarDisableDrag"
                        @set-view-mode="handleOverflowSetViewMode"
                        @toggle-continuous-scroll="handleToolbarToggleContinuousScroll"
                        @quick-note="handleToolbarQuickNote"
                        @open-settings="handleOverflowOpenSettings"
                        @combine-images="emit('open-combine')"
                        @print-current-page="handlePrintCurrentPage"
                        @convert-to-pdf="openConvertDialog"
                        @toggle-fullscreen="emit('toggle-fullscreen')"
                    />
                </template>
            </PdfToolbar>
        </WorkspaceToolbarHost>

        <UAlert
            v-if="pdfError && pdfSrc"
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
                    :submitted-search-query="submittedSearchQuery"
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
                    :search-error="searchError"
                    :search-focus-request="searchFocusRequest"
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
                :suppress-empty-state="suppressEmptyState || isDocumentOpenPlaceholderVisible"
            >
                <template #document>
                    <PdfViewer
                        v-if="pdfSrc"
                        ref="pdfViewerRef"
                        :src="pdfSrc!"
                        :source-pdf-data="viewerSourcePdfData"
                        :suppress-loading-overlay="pendingDocumentOpen"
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
                        :search-page-matches="viewerSearchPageMatches"
                        :current-search-match="viewerCurrentSearchMatch"
                        :current-search-match-navigation-id="currentResultNavigationId"
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
                        :open-in-progress="pendingDocumentOpen"
                        :start-section="startSection"
                        can-combine-files
                        @update:start-section="emit('update:start-section', $event)"
                        @open-file="handleOpenFileFromUi"
                        @open-folder="handleOpenFolderFromUi"
                        @open-recent="openRecentFile"
                        @remove-recent="removeRecentFile"
                        @reveal-recent="revealRecentFile"
                        @clear-recent="clearRecentFiles"
                        @open-settings="emit('open-settings')"
                        @combine-files="emit('open-combine')"
                        @open-combine-result="handleOpenFileWithResult"
                    />
                </template>
            </WorkspaceViewerHost>
        </WorkspaceSidebarHost>
        <WorkspacePageOpProgressOverlay
            :progress="pageOpBatchProgress"
            :eta-text="pageOpBatchEtaText"
            :is-page-operation-in-progress="isPageOperationInProgress"
        />
        <WorkspaceExportProgressOverlay :overlay="exportOverlay" />
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
            @shape-delete="handleDeleteSelectedShape"
            @shape-close="closeShapeProperties"
        />

        <DjvuConversionOverlay
            v-if="canUseDjvu"
            :is-converting="conversionState.isConverting && !djvuIsLoadingPages"
            :phase="conversionState.phase"
            :percent="conversionState.percent"
            @cancel="handleDjvuCancel"
        />

        <WorkspaceSaveDialogHost
            :export-scope-dialog-open="exportScopeDialogOpen"
            :export-scope-dialog-mode="exportScopeDialogMode"
            :export-scope-dialog-selected-pages="exportScopeDialogSelectedPages"
            :print-dialog-open="printDialogOpen"
            :print-dialog-selected-pages="printDialogSelectedPages"
            :print-status="printStatus"
            :print-error="printError"
            :is-preparing-print="isPreparingPrint"
            :crop-dialog-open="cropDialogOpen"
            :crop-dialog-loading="cropDialogLoading"
            :crop-dialog-page-number="cropDialogPageNumber"
            :crop-dialog-margins="cropDialogMargins"
            :crop-dialog-media-box="cropDialogMediaBox"
            :crop-dialog-current-box="cropDialogCurrentBox"
            :crop-dialog-rotation="cropDialogRotation"
            :selected-thumbnail-pages="selectedThumbnailPages"
            :total-pages="totalPages"
            :current-page="currentPage"
            :view-mode="viewMode"
            :can-use-djvu="canUseDjvu"
            :is-djvu-mode="isDjvuMode"
            :show-convert-dialog="showConvertDialog"
            :djvu-path="djvuSourcePath"
            @export-submit="handleExportScopeDialogSubmit"
            @export-open-change="handleExportScopeDialogOpenChange"
            @print-submit="handlePrintDialogSubmit"
            @print-open-change="handlePrintDialogOpenChange"
            @crop-apply="handleCropApply"
            @crop-remove="handleCropRemove"
            @crop-open-change="cropDialogOpen = $event"
            @djvu-convert="handleDjvuConvert"
            @convert-open-change="showConvertDialog = $event"
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
import WorkspaceExportProgressOverlay from '@app/modules/workspace-shell/components/WorkspaceExportProgressOverlay.vue';
import WorkspacePageOpProgressOverlay from '@app/modules/workspace-shell/components/WorkspacePageOpProgressOverlay.vue';
import WorkspaceSaveDialogHost from '@app/modules/workspace-shell/components/WorkspaceSaveDialogHost.vue';
import WorkspaceShell from '@app/modules/workspace-shell/components/layout/WorkspaceShell.vue';
import WorkspaceSidebarHost from '@app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue';
import WorkspaceToolbarHost from '@app/modules/workspace-shell/components/layout/WorkspaceToolbarHost.vue';
import WorkspaceViewerHost from '@app/modules/workspace-shell/components/layout/WorkspaceViewerHost.vue';
import { useDocumentWorkspaceSplitRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore';
import { useDocumentWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceToolbar';
import { useWorkspaceStartupReadiness } from '@app/modules/workspace-shell/composables/useWorkspaceStartupReadiness';
import { useWorkspaceOrchestration } from '@app/modules/workspace-shell/useWorkspaceOrchestration';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import type { TTabUpdate } from '@app/types/tabs';
import type { TStartSection } from '@app/types/start-page';
import type { IPdfPageMatches } from '@app/types/pdf';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getDocumentsCapability } from '@app/utils/platform-documents';
import { formatEtaDuration } from '@app/utils/progress-formatting';
import { DESKTOP_EDITOR_READER_COMMAND_SURFACE } from '@app/utils/reader-command-surface';
import type { IRecentFile } from '@contracts/shared';

const OcrPopup = defineAsyncComponent(() => import('@app/components/ocr/OcrPopup.vue'));
const DjvuBanner = defineAsyncComponent(() => import('@app/components/djvu/DjvuBanner.vue'));
const DjvuConversionOverlay = defineAsyncComponent(() => import('@app/components/djvu/DjvuConversionOverlay.vue'));
const DjvuViewer = defineAsyncComponent(() => import('@app/components/djvu/DjvuViewer.vue'));
const props = defineProps<{
    tabId: string;
    isActive: boolean;
    isTabTransitionBusy: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    pendingDocumentOpen?: boolean;
    startSection?: TStartSection;
}>();

const canTeleportToolbar = computed(() => (
    import.meta.client
    && Boolean(document.getElementById('editor-global-toolbar-host'))
));
const canTeleportStatus = computed(() => (
    import.meta.client
    && Boolean(document.getElementById('editor-global-status-host'))
));
const { isDesktopRuntime } = useRuntimeEnvironment();
const hasDesktopRuntime = computed(() => isDesktopRuntime.value);
const canUseOcr = hasDesktopRuntime;
const canUseDjvu = true;
const toolbarSurface = DESKTOP_EDITOR_READER_COMMAND_SURFACE;
const isOcrRunning = ref(false);

const emit = defineEmits<{
    'update-tab': [updates: TTabUpdate];
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
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
    pdfData,
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
    exportOverlay,
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
    submittedSearchQuery,
    searchOptions,
    results,
    pageMatches,
    currentResultIndex,
    currentResultNavigationId,
    currentResult,
    isSearching,
    searchError,
    totalMatches,
    searchProgress,
    isTruncated,
    minQueryLength,
    handleSearch,
    handleSearchNext,
    handleSearchPrevious,
    handleGoToResult,
    searchFocusRequest,
    handleSave,
    handleSaveAs,
    handlePrint,
    handlePrintCurrentPage,
    handlePrintDialogOpenChange,
    handlePrintDialogSubmit,
    handleExportDocx,
    handleExportImages,
    handleExportMultiPageTiff,
    handleExportScopeDialogSubmit,
    handleExportScopeDialogOpenChange,
    handleOcrComplete,
    docxExportError,
    isAnySaving,
    isExportingDocx,
    isPreparingPrint,
    isPreparingCurrentPagePrint,
    printDialogOpen,
    printDialogSelectedPages,
    printError,
    printStatus,
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
    handleDeleteSelectedShape,
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
    pageOpBatchProgress,
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
    handleOpenFolderFromUi,
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

const hiddenSearchPageMatches = new Map<number, IPdfPageMatches>();
const viewerSearchPageMatches = computed(() => (
    showSidebar.value ? pageMatches.value : hiddenSearchPageMatches
));
const viewerCurrentSearchMatch = computed(() => (
    showSidebar.value ? currentResult.value : null
));

const viewerSourcePdfData = computed(() => pdfData.value);

const showNativeDjvuViewer = computed(() => (
    isDjvuMode.value
    && Boolean(djvuSourcePath.value)
    && !pdfSrc.value
));
const {
    scheduleStartupOpenVisualReady,
    dispatchStartupOpenVisualReady,
} = useWorkspaceStartupReadiness({
    pdfViewerRef,
    showNativeDjvuViewer,
});
const isDjvuOpening = computed(() => (
    Boolean(djvuOpeningPath.value)
    && !showNativeDjvuViewer.value
));
const isDocumentOpenPlaceholderVisible = computed(() => (
    pendingDocumentOpen.value
    || isDjvuOpening.value
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
    && !isDocumentBusy.value
));
const isConversionBusy = computed(() => conversionState.value.isConverting);
const isDocumentBusy = computed(() => isConversionBusy.value || isOcrRunning.value);

async function revealRecentFile(file: IRecentFile) {
    try {
        await getDocumentsCapability().showItemInFolder(file.originalPath);
    } catch {
        // Best-effort; ignore failures (path may have moved or permissions changed).
    }
}

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
const pageOpBatchEtaText = computed(() => formatEtaDuration(pageOpBatchProgress.value?.estimatedRemainingMs ?? null));

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

watch(pdfSrc, (src) => {
    if (src) {
        scheduleStartupOpenVisualReady('pdf-src');
    }
});

watch(showNativeDjvuViewer, (visible) => {
    if (visible) {
        scheduleStartupOpenVisualReady('djvu-src');
    }
});

watch([
    pdfError,
    djvuError,
], ([
    nextPdfError,
    nextDjvuError,
]) => {
    if (nextPdfError || nextDjvuError) {
        dispatchStartupOpenVisualReady('document-error', true);
    }
});

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
    handlePrint,
    handlePrintCurrentPage: () => {
        void handlePrintCurrentPage();
    },
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
    isOpeningDocument: computed(() => (
        pendingDocumentOpen.value
        || isDjvuOpening.value
        || isRestoringSplitPayload.value
    )),
    isPreparingPrint,
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
