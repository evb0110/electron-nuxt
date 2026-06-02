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
                :document-busy="toolbarDocumentBusy"
                :has-ocr-action="canUseOcr"
                :surface="toolbarSurface"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                @open-file="handleOpenFileFromUi"
                @open-settings="handleOpenSettings"
                @save="handleToolbarSave"
                @save-as="handleToolbarSaveAs"
                @print="handlePrint"
                @print-current-page="handlePrintCurrentPage"
                @export-docx="handleToolbarExportDocx"
                @undo="handleToolbarUndo"
                @redo="handleToolbarRedo"
                @toggle-sidebar="handleToolbarToggleSidebar"
                @actual-size="handleActualSize"
                @fit-width="handleToolbarFitWidth"
                @fit-height="handleToolbarFitHeight"
                @toggle-continuous-scroll="handleToolbarToggleContinuousScroll"
                @enable-drag="handleToolbarEnableDrag"
                @disable-drag="handleToolbarDisableDrag"
                @capture-region="handleToolbarCaptureRegion"
                @crop="handleToolbarCrop"
                @quick-note="handleToolbarQuickNote"
                @toggle-fullscreen="handleToggleFullscreen"
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
                        :document-busy="toolbarDocumentBusy"
                        @update:open="handleDropdownOpen('appMenu', $event)"
                        @open-file="handleOpenFileFromUi"
                        @save="handleToolbarSave"
                        @save-as="handleToolbarSaveAs"
                        @print="handlePrint"
                        @print-current-page="handlePrintCurrentPage"
                        @combine-images="handleOpenCombine"
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
                        ref="ocrPopupRef"
                        :pdf-document="pdfDocument"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :working-copy-path="workingCopyPath"
                        :open="ocrPopupOpen"
                        :is-exporting-docx="isExportingDocx"
                        :external-error="docxExportError"
                        :disabled="isDjvuMode || toolbarControlsDisabled"
                        :hide-trigger="isCollapsed(3)"
                        @update:open="handleDropdownOpen('ocr', $event)"
                        @update:running="isOcrRunning = $event"
                        @export-docx="handleExportDocx"
                        @ocr-complete="handleOcrComplete"
                    />
                </template>
                <template #zoom-dropdown="{ compactLevel }">
                    <PdfZoomDropdown
                        v-model:zoom="zoom"
                        v-model:zoom-mode="zoomMode"
                        v-model:fit-mode="fitMode"
                        v-model:view-mode="viewMode"
                        :effective-zoom="effectiveZoom"
                        :open="zoomDropdownOpen"
                        :disabled="toolbarControlsDisabled"
                        :compact-level="compactLevel"
                        @update:effective-zoom="effectiveZoom = $event"
                        @update:open="handleDropdownOpen('zoom', $event)"
                    />
                </template>
                <template #page-dropdown="{ compactLevel }">
                    <PdfPageDropdown
                        v-model="currentPage"
                        :open="pageDropdownOpen"
                        :total-pages="documentMetadataReady ? totalPages : 0"
                        :view-mode="viewMode"
                        :page-labels="toolbarPageLabels"
                        :disabled="toolbarControlsDisabled"
                        :compact-level="compactLevel"
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
                        :document-busy="toolbarDocumentBusy"
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
                        @actual-size="handleActualSize"
                        @fit-width="handleToolbarFitWidth"
                        @fit-height="handleToolbarFitHeight"
                        @enable-drag="handleToolbarEnableDrag"
                        @disable-drag="handleToolbarDisableDrag"
                        @set-view-mode="handleOverflowSetViewMode"
                        @toggle-continuous-scroll="handleToolbarToggleContinuousScroll"
                        @quick-note="handleToolbarQuickNote"
                        @open-settings="handleOverflowOpenSettings"
                        @combine-images="handleOpenCombine"
                        @print-current-page="handlePrintCurrentPage"
                        @convert-to-pdf="openConvertDialog"
                        @toggle-fullscreen="handleToggleFullscreen"
                    />
                </template>
            </PdfToolbar>
        </WorkspaceToolbarHost>

        <UAlert
            v-if="pdfError"
            color="error"
            variant="soft"
            class="mx-3 mt-2"
            :title="t('errors.file.open')"
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
                    :current-result-navigation-id="currentResultNavigationId"
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
                    :annotation-comments-status="annotationCommentsStatus"
                    :annotation-active-comment-stable-key="annotationActiveCommentStableKey"
                    :bookmark-edit-mode="bookmarkEditMode"
                    :is-page-operation-in-progress="isPageOperationInProgress"
                    :is-djvu-mode="isDjvuMode"
                    :selected-thumbnail-pages="selectedThumbnailPages"
                    :thumbnail-invalidation-request="thumbnailInvalidationRequest"
                    :thumbnail-hidden-annotation-ids="thumbnailHiddenAnnotationIds"
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
                    @page-rotate-cw="handlePageRotateCw"
                    @page-rotate-ccw="handlePageRotateCcw"
                    @page-extract="handlePageExtract"
                    @page-export="handlePageExport"
                    @page-delete="handlePageDelete"
                    @page-reorder="handlePageReorder"
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
                        :current-page="currentPage"
                        :drag-mode="dragMode"
                        :continuous-scroll="continuousScroll"
                        :is-resizing="isResizingSidebar"
                        :is-active="isRenderActive"
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
                        @initial-visual-pending="handlePdfInitialVisualPending"
                        @initial-visual-ready="handlePdfInitialVisualReady"
                        @annotation-state="handleAnnotationState"
                        @annotation-modified="handleAnnotationModified"
                        @annotation-comments="handleAnnotationComments"
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
                        :is-active="isRenderActive"
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
                        @update:start-section="handleStartSectionUpdate"
                        @open-file="handleOpenFileFromUi"
                        @open-folder="handleOpenFolderFromUi"
                        @open-recent="openRecentFile"
                        @remove-recent="removeRecentFile"
                        @reveal-recent="revealRecentFile"
                        @clear-recent="clearRecentFiles"
                        @open-settings="handleOpenSettings"
                        @combine-files="handleOpenCombine"
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
            :annotation-comments="annotationComments"
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
            :selected-text-markup-for-properties="selectedTextMarkupForProperties"
            :text-markup-properties-x="textMarkupPropertiesPopover.x"
            :text-markup-properties-y="textMarkupPropertiesPopover.y"
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
            @context-update-color="handleContextTextMarkupColorUpdate"
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
            @text-markup-color-update="handleTextMarkupColorUpdate"
            @text-markup-close="closeTextMarkupProperties"
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
import '@app/assets/css/pdf-comment-ui.scss';
import '@app/assets/css/pdf-search-highlights.scss';
import '@app/assets/css/pdf-animations.css';
import '@app/assets/css/pdf-debug-overlays.css';
import { useMutationObserver } from '@vueuse/core';
import { delay } from 'es-toolkit/promise';
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
import { resolveVisiblePageLabelsDuringMetadataRefresh } from '@app/composables/pdf/usePageLabelState';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platformApi';
import type { TTabUpdate } from '@app/types/tabs';
import type { TStartSection } from '@app/types/startPage';
import type { IPdfPageMatches } from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import { formatEtaDuration } from '@app/utils/progressFormatting';
import { DESKTOP_EDITOR_READER_COMMAND_SURFACE } from '@app/utils/readerCommandSurface';
import type { IRecentFile } from '@contracts/shared';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/composables/useTabSessionStore';

const OcrPopup = defineAsyncComponent(() => import('@app/components/ocr/OcrPopup.vue'));
const DjvuBanner = defineAsyncComponent(() => import('@app/components/djvu/DjvuBanner.vue'));
const DjvuConversionOverlay = defineAsyncComponent(() => import('@app/components/djvu/DjvuConversionOverlay.vue'));
const DjvuViewer = defineAsyncComponent(() => import('@app/components/djvu/DjvuViewer.vue'));

type TAgentOcrPageRange = 'all' | 'current' | 'custom';

interface IAgentOcrRunOptions {
    pageRange?: TAgentOcrPageRange;
    customRange?: string;
    languages?: string[];
    open?: boolean;
}

interface IOcrPopupAgentExpose {
    runOcrForAgent: (options?: IAgentOcrRunOptions) => Promise<Record<string, unknown>>;
    cancelOcrForAgent: () => Record<string, unknown>;
    getAgentOcrSnapshot: () => Record<string, unknown>;
}

const {
    fullscreenSupported,
    isActive,
    isFullscreen,
    isRenderActive = isActive,
    isTabTransitionBusy,
    initialViewState = null,
    pendingDocumentOpen: pendingDocumentOpenProp = false,
    startSection = 'recent',
    tabId,
} = defineProps<{
    tabId: string;
    isActive: boolean;
    isRenderActive?: boolean | undefined;
    isTabTransitionBusy: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    initialViewState?: ITabViewSessionState | null | undefined;
    pendingDocumentOpen?: boolean | undefined;
    startSection?: TStartSection | undefined;
}>();

const canTeleportToolbar = ref(false);
const canTeleportStatus = ref(false);

function refreshTeleportHosts() {
    if (!import.meta.client) {
        return;
    }

    canTeleportToolbar.value = Boolean(document.getElementById('editor-global-toolbar-host'));
    canTeleportStatus.value = Boolean(document.getElementById('editor-global-status-host'));
}

onMounted(refreshTeleportHosts);

useMutationObserver(
    () => import.meta.client ? document.body : null,
    refreshTeleportHosts,
    {
        childList: true,
        subtree: true,
    },
);
const { isDesktopRuntime } = useRuntimeEnvironment();
const hasDesktopRuntime = computed(() => isDesktopRuntime.value);
const canUseOcr = hasDesktopRuntime;
const canUseDjvu = true;
const toolbarSurface = DESKTOP_EDITOR_READER_COMMAND_SURFACE;
const isOcrRunning = ref(false);
const ocrPopupRef = ref<IOcrPopupAgentExpose | null>(null);

const emit = defineEmits<{
    'update-tab': [updates: TTabUpdate];
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
}>();

function handleStartSectionUpdate(section: TStartSection) {
    emit('update:start-section', section);
}

function handleOpenSettings() {
    emit('open-settings');
}

function handleOpenCombine() {
    emit('open-combine');
}

function handleToggleFullscreen() {
    emit('toggle-fullscreen');
}

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
const pendingDocumentOpen = computed(() => pendingDocumentOpenProp === true);
const isActiveRef = computed({
    get: () => isActive,
    set: () => {},
});

const w = useWorkspaceOrchestration({
    isActive: isActiveRef,
    initialViewState,
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
    pageLabelsResolved,
    handlePageLabelRangesUpdate,
    bookmarkEditMode,
    bookmarkItems,
    bookmarksDirty,
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
    annotationCommentsStatus,
    annotationActiveCommentStableKey,
    thumbnailHiddenAnnotationIds,
    applyAnnotationComments,
    markAnnotationCommentsLoading,
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
    hasOpenAnnotationNotes,
    annotationNotePositions,
    sortedAnnotationNoteWindows,
    updateAnnotationNoteText,
    updateAnnotationNotePosition,
    minimizeAnnotationNote,
    restoreAnnotationNote,
    bringAnnotationNoteToFront,
    shapePropertiesPopover,
    selectedShapeForProperties,
    textMarkupPropertiesPopover,
    selectedTextMarkupForProperties,
    handleQuickNoteAction,
    handleInsertImageFromFile,
    handlePasteImageFromClipboard,
    handleStartPlaceNote,
    handleAnnotationFocusComment,
    handleAnnotationCommentClick,
    handleOpenAnnotationNote,
    closeShapeProperties,
    closeTextMarkupProperties,
    handleDeleteSelectedShape,
    handleShapePropertyUpdate,
    handleTextMarkupColorUpdate,
    handleShapeContextMenu,
    handleViewerAnnotationContextMenu,
    openContextMenuNote,
    copyContextMenuNoteText,
    copyContextMenuSelectionText,
    deleteContextMenuComment,
    handleContextTextMarkupColorUpdate,
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
    handleZoomIn,
    handleZoomOut,
    handleActualSize,
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
    shouldAcceptViewerCurrentPageUpdate,
    hasPdf,
} = w;

const hiddenSearchPageMatches = new Map<number, IPdfPageMatches>();
const viewerSearchPageMatches = computed(() => (
    isActiveRef.value && showSidebar.value ? pageMatches.value : hiddenSearchPageMatches
));
const viewerCurrentSearchMatch = computed(() => (
    isActiveRef.value && showSidebar.value ? currentResult.value : null
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
const isOpeningDocumentForToolbar = computed(() => (
    isDocumentOpenPlaceholderVisible.value
    || isRestoringSplitPayload.value
    || isExternallyRestoring.value
));
const toolbarHasPdf = computed(() => (
    hasPdf.value
    || pendingDocumentOpen.value
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
    && !toolbarDocumentBusy.value
));
const isConversionBusy = computed(() => conversionState.value.isConverting);
const isDocumentBusy = computed(() => isConversionBusy.value || isOcrRunning.value);
const toolbarDocumentBusy = computed(() => isDocumentBusy.value || isOpeningDocumentForToolbar.value);
const documentMetadataAvailable = computed(() => (
    toolbarHasPdf.value
    && totalPages.value > 0
));
const documentMetadataReady = computed(() => (
    documentMetadataAvailable.value
    && !isOpeningDocumentForToolbar.value
));
const toolbarPageLabels = computed(() => {
    if (!documentMetadataReady.value) {
        return null;
    }
    return resolveVisiblePageLabelsDuringMetadataRefresh({
        pageLabels: pageLabels.value,
        pageLabelsResolved: pageLabelsResolved.value,
        isSaving: isAnySaving.value,
        totalPages: totalPages.value,
    });
});
const toolbarControlsDisabled = computed(() => (
    !documentMetadataReady.value || toolbarDocumentBusy.value
));

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
    tabId: tabId,
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

function handlePageRotateCw(pages: number[]) {
    void handlePageRotate(pages, 90);
}

function handlePageRotateCcw(pages: number[]) {
    void handlePageRotate(pages, 270);
}

function handlePageExtract(pages: number[]) {
    void pageOpsExtract(pages);
}

function handlePageExport(pages: number[]) {
    void handleExportImages(pages);
}

function handlePageDelete(pages: number[]) {
    void pageOpsDelete(pages, totalPages.value);
}

function handlePageReorder(order: number[]) {
    void pageOpsReorder(order);
}

function handleInsertPages() {
    void pageOpsInsert(totalPages.value, totalPages.value);
}

function handleViewerCurrentPageUpdate(page: number) {
    const previousPage = currentPage.value;
    const viewer = pdfViewerRef.value?.getViewerContainer?.() ?? null;
    if (!shouldAcceptViewerCurrentPageUpdate(page)) {
        BrowserLogger.warn('pdf-nav', `[workspace-page-update] ignored stale viewer page ${previousPage}->${page}`, {
            previousPage,
            ignoredPage: page,
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
        return;
    }
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
        resetDocumentOpenVisualSettleWaiter();
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
        resolveDocumentOpenVisualSettleIfReady();
    }
});

const {
    hasQueuedSplitRestore,
    isExternallyRestoring,
    suppressEmptyState,
} = useDocumentWorkspaceSplitRestore({
    tabId: tabId,
    pendingDocumentOpen,
    isTabTransitionBusy: computed(() => isTabTransitionBusy === true),
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
});

const DOCUMENT_OPEN_VISUAL_SETTLE_TIMEOUT_MS = 4_000;
const initialDocumentVisualReady = ref(false);
let documentOpenVisualSettlePromise: Promise<void> | null = null;
let resolveDocumentOpenVisualSettlePromise: (() => void) | null = null;

function ensureDocumentOpenVisualSettlePromise() {
    if (!documentOpenVisualSettlePromise) {
        documentOpenVisualSettlePromise = new Promise<void>((resolve) => {
            resolveDocumentOpenVisualSettlePromise = resolve;
        });
    }

    return documentOpenVisualSettlePromise;
}

function resolveDocumentOpenVisualSettle() {
    resolveDocumentOpenVisualSettlePromise?.();
    documentOpenVisualSettlePromise = null;
    resolveDocumentOpenVisualSettlePromise = null;
}

function resetDocumentOpenVisualSettleWaiter() {
    initialDocumentVisualReady.value = false;
}

function hasSettledDocumentOpenVisualState() {
    if (pdfError.value || djvuError.value) {
        return true;
    }

    if (showNativeDjvuViewer.value) {
        return true;
    }

    return Boolean(
        pdfSrc.value
        && pdfDocument.value
        && totalPages.value > 0
        && !isLoading.value
        && initialDocumentVisualReady.value,
    );
}

function resolveDocumentOpenVisualSettleIfReady() {
    if (hasSettledDocumentOpenVisualState()) {
        resolveDocumentOpenVisualSettle();
    }
}

function handlePdfInitialVisualReady() {
    initialDocumentVisualReady.value = true;
    resolveDocumentOpenVisualSettleIfReady();
}

function handlePdfInitialVisualPending() {
    markAnnotationCommentsLoading();
    resetDocumentOpenVisualSettleWaiter();
}

function handleAnnotationComments(comments: IAnnotationCommentSummary[]) {
    if (
        annotationCommentsStatus.value === 'loading'
        && annotationComments.value.length > 0
        && comments.length === 0
        && isLoading.value
    ) {
        return;
    }
    applyAnnotationComments(comments);
}

function waitForDocumentOpenVisualSettleTimeout() {
    return delay(DOCUMENT_OPEN_VISUAL_SETTLE_TIMEOUT_MS).then(() => 'timeout' as const);
}

async function waitForDocumentOpenSettled() {
    await nextTick();
    resolveDocumentOpenVisualSettleIfReady();
    if (hasSettledDocumentOpenVisualState()) {
        return;
    }

    await Promise.race([
        ensureDocumentOpenVisualSettlePromise(),
        waitForDocumentOpenVisualSettleTimeout(),
    ]);
    await nextTick();

    if (hasSettledDocumentOpenVisualState()) {
        return;
    }

    BrowserLogger.warn('recent-open', 'Document open visual settle timed out', {
        tabId: tabId,
        hasPdf: hasPdf.value,
        hasPdfSrc: Boolean(pdfSrc.value),
        hasPdfDocument: Boolean(pdfDocument.value),
        totalPages: totalPages.value,
        pageLabelsResolved: pageLabelsResolved.value,
        isLoading: isLoading.value,
        showNativeDjvuViewer: showNativeDjvuViewer.value,
        hasPdfError: Boolean(pdfError.value),
        hasDjvuError: Boolean(djvuError.value),
    });
    resolveDocumentOpenVisualSettle();
}

watch([
    pdfDocument,
    totalPages,
    pageLabelsResolved,
    isLoading,
    showNativeDjvuViewer,
    initialDocumentVisualReady,
], () => {
    resolveDocumentOpenVisualSettleIfReady();
});

const AGENT_ANNOTATION_TOOLS = [
    'none',
    'select',
    'highlight',
    'underline',
    'strikethrough',
    'squiggly',
    'text',
    'draw',
    'rectangle',
    'circle',
    'line',
    'arrow',
    'stamp',
] as const satisfies readonly TAnnotationTool[];
const AGENT_SIDEBAR_TABS = [
    'annotations',
    'bookmarks',
    'thumbnails',
    'search',
] as const;

function isAgentRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAgentStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null;
}

function getAgentNumberInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function getAgentStringArrayInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strings = value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);
    return strings.length > 0 ? Array.from(new Set(strings)) : undefined;
}

function isAgentAnnotationTool(value: unknown): value is TAnnotationTool {
    return typeof value === 'string' && AGENT_ANNOTATION_TOOLS.includes(value as TAnnotationTool);
}

function isAgentSidebarTab(value: unknown): value is typeof AGENT_SIDEBAR_TABS[number] {
    return typeof value === 'string' && AGENT_SIDEBAR_TABS.includes(value as typeof AGENT_SIDEBAR_TABS[number]);
}

function isAgentOcrPageRange(value: unknown): value is TAgentOcrPageRange {
    return value === 'all' || value === 'current' || value === 'custom';
}

function getAgentOcrRunOptions(input: Record<string, unknown>): IAgentOcrRunOptions {
    const pageRange = getAgentStringInput(input, 'pageRange');
    const customRange = getAgentStringInput(input, 'customRange');
    const languages = getAgentStringArrayInput(input, 'languages')
        ?? getAgentStringArrayInput(input, 'selectedLanguages');
    return {
        ...(isAgentOcrPageRange(pageRange) ? {pageRange} : {}),
        ...(customRange === null ? {} : {customRange}),
        ...(languages === undefined ? {} : {languages}),
        open: true,
    };
}

function normalizeAgentAnnotationComment(comment: IAnnotationCommentSummary) {
    return {
        id: comment.id,
        stableKey: comment.stableKey,
        pageIndex: comment.pageIndex,
        pageNumber: comment.pageNumber,
        text: comment.text,
        displayText: comment.displayText ?? null,
        previewText: comment.previewText ?? null,
        kindLabel: comment.kindLabel ?? null,
        subtype: comment.subtype ?? null,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        modifiedAt: comment.modifiedAt,
        color: comment.color,
        fillColor: comment.fillColor ?? null,
        opacity: comment.opacity ?? null,
        strokeWidth: comment.strokeWidth ?? null,
        uid: comment.uid,
        annotationId: comment.annotationId,
        source: comment.source,
        hasNote: comment.hasNote === true,
        markerRect: comment.markerRect ?? null,
    };
}

function normalizeAgentBookmark(
    bookmark: typeof bookmarkItems.value[number],
): Record<string, unknown> {
    return {
        title: bookmark.title,
        pageIndex: bookmark.pageIndex,
        pageNumber: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
        namedDest: bookmark.namedDest,
        bold: bookmark.bold,
        italic: bookmark.italic,
        color: bookmark.color,
        items: bookmark.items.map(normalizeAgentBookmark),
    };
}

function findAgentAnnotationComment(input: Record<string, unknown> | undefined) {
    const stableKey = getAgentStringInput(input, 'stableKey');
    const annotationId = getAgentStringInput(input, 'annotationId');
    const id = getAgentStringInput(input, 'id');
    const comment = annotationComments.value.find(candidate => (
        (stableKey !== null && candidate.stableKey === stableKey)
        || (annotationId !== null && candidate.annotationId === annotationId)
        || (id !== null && candidate.id === id)
    ));
    if (!comment) {
        throw new Error('Annotation comment was not found. Use evb://document/{tabId}/annotations to get stable keys.');
    }
    return comment;
}

function parseAgentResourceUri(uri: string) {
    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        throw new Error(`Invalid EVB resource URI: ${uri}`);
    }
    if (parsed.protocol !== 'evb:') {
        throw new Error(`Unsupported EVB resource URI protocol: ${parsed.protocol}`);
    }
    const parts = parsed.pathname
        .split('/')
        .filter(Boolean)
        .map(part => decodeURIComponent(part));
    return {
        host: parsed.hostname,
        parts,
    };
}

function createAgentResource(uri: string): Record<string, unknown> {
    const parsed = parseAgentResourceUri(uri);
    if (parsed.host !== 'document') {
        throw new Error(`Unsupported workspace resource host: ${parsed.host}`);
    }
    const [
        resourceTabId,
        resourceKind,
    ] = parsed.parts;
    if (resourceTabId && resourceTabId !== tabId) {
        throw new Error(`Resource tab ${resourceTabId} does not match workspace tab ${tabId}.`);
    }

    if (resourceKind === 'annotations') {
        return {
            uri,
            tabId,
            status: annotationCommentsStatus.value,
            count: annotationComments.value.length,
            annotations: annotationComments.value.map(normalizeAgentAnnotationComment),
        };
    }

    if (resourceKind === 'notes') {
        const openNoteByStableKey = new Map(
            sortedAnnotationNoteWindows.value.map(note => [
                note.comment.stableKey,
                note,
            ] as const),
        );
        const notes = annotationComments.value
            .filter(comment => (
                comment.hasNote === true
                || comment.text.trim().length > 0
                || openNoteByStableKey.has(comment.stableKey)
            ))
            .map((comment) => {
                const openNote = openNoteByStableKey.get(comment.stableKey) ?? null;
                return {
                    ...normalizeAgentAnnotationComment(comment),
                    text: openNote?.text ?? comment.text,
                    isOpen: openNote !== null,
                    isMinimized: openNote?.isMinimized ?? false,
                    saving: openNote?.saving ?? false,
                    error: openNote?.error ?? null,
                    saveMode: openNote?.saveMode ?? null,
                };
            });
        return {
            uri,
            tabId,
            status: annotationCommentsStatus.value,
            count: notes.length,
            notes,
        };
    }

    if (resourceKind === 'toc' || resourceKind === 'bookmarks') {
        return {
            uri,
            tabId,
            status: 'ready',
            count: bookmarkItems.value.length,
            dirty: bookmarksDirty.value,
            toc: bookmarkItems.value.map(normalizeAgentBookmark),
        };
    }

    throw new Error(`Unsupported workspace document resource: ${resourceKind}`);
}

function readAgentResource(uri: string): Promise<Record<string, unknown>> {
    return Promise.resolve(createAgentResource(uri));
}

function createAgentActionResult(
    actionId: string,
    extra: Record<string, unknown> = {},
) {
    return {
        ok: true,
        actionId,
        tabId,
        currentPage: currentPage.value,
        totalPages: totalPages.value,
        ...extra,
    };
}

async function runAgentAction(
    actionId: string,
    input: Record<string, unknown> | undefined = {},
    options: {dryRun?: boolean} = {},
): Promise<Record<string, unknown>> {
    if (!isAgentRecord(input)) {
        throw new Error('Agent action input must be an object.');
    }
    if (options.dryRun) {
        return createAgentActionResult(actionId, {
            dryRun: true,
            wouldRun: true,
        });
    }

    switch (actionId) {
        case 'ui.open_sidebar_tab': {
            const nextTab = getAgentStringInput(input, 'tab') ?? getAgentStringInput(input, 'sidebarTab');
            if (!isAgentSidebarTab(nextTab)) {
                throw new Error('ui.open_sidebar_tab requires input.tab: annotations, bookmarks, thumbnails, or search.');
            }
            showSidebar.value = true;
            sidebarTab.value = nextTab;
            await nextTick();
            return createAgentActionResult(actionId, {
                showSidebar: showSidebar.value,
                sidebarTab: sidebarTab.value,
            });
        }
        case 'ui.toggle_sidebar':
            showSidebar.value = !showSidebar.value;
            await nextTick();
            return createAgentActionResult(actionId, {showSidebar: showSidebar.value});
        case 'ui.close_popups':
            closeAllDropdowns();
            closeShapeProperties();
            closeTextMarkupProperties();
            await nextTick();
            return createAgentActionResult(actionId);
        case 'ocr.open_popup':
            handleDropdownOpen('ocr', true);
            await nextTick();
            return createAgentActionResult(actionId, {ocrPopupOpen: ocrPopupOpen.value});
        case 'ocr.status':
            return createAgentActionResult(actionId, {
                ocrPopupOpen: ocrPopupOpen.value,
                ocr: ocrPopupRef.value?.getAgentOcrSnapshot() ?? null,
            });
        case 'ocr.start': {
            handleDropdownOpen('ocr', true);
            await nextTick();
            const result = await ocrPopupRef.value?.runOcrForAgent(getAgentOcrRunOptions(input));
            if (!result) {
                return createAgentActionResult(actionId, {
                    ok: false,
                    error: 'OCR popup is not mounted.',
                });
            }
            return createAgentActionResult(actionId, result);
        }
        case 'ocr.cancel':
            return createAgentActionResult(actionId, ocrPopupRef.value?.cancelOcrForAgent() ?? {
                ok: false,
                error: 'OCR popup is not mounted.',
            });
        case 'annotation.open_note': {
            const comment = findAgentAnnotationComment(input);
            handleOpenAnnotationNote(comment);
            await nextTick();
            return createAgentActionResult(actionId, {comment: normalizeAgentAnnotationComment(comment)});
        }
        case 'annotation.focus': {
            const comment = findAgentAnnotationComment(input);
            await handleAnnotationFocusComment(comment);
            return createAgentActionResult(actionId, {comment: normalizeAgentAnnotationComment(comment)});
        }
        case 'annotation.delete': {
            const comment = findAgentAnnotationComment(input);
            await handleDeleteAnnotationComment(comment);
            return createAgentActionResult(actionId, {deletedStableKey: comment.stableKey});
        }
        case 'annotation.create_note':
        case 'annotation.start_note_placement':
            await handleQuickNoteAction();
            await nextTick();
            return createAgentActionResult(actionId, {isPlacingPageNote: annotationPlacingPageNote.value});
        case 'annotation.select_tool':
        case 'annotation.set_tool': {
            const tool = input.tool;
            if (!isAgentAnnotationTool(tool)) {
                throw new Error('annotation.select_tool requires input.tool to be a supported annotation tool.');
            }
            handleAnnotationToolChange(tool);
            await nextTick();
            return createAgentActionResult(actionId, {annotationTool: annotationTool.value});
        }
        case 'file.save':
            await handleSave();
            return createAgentActionResult(actionId, {canSave: canSave.value});
        case 'file.save_as':
            await handleSaveAs();
            return createAgentActionResult(actionId);
        case 'file.print':
            handlePrint();
            return createAgentActionResult(actionId);
        case 'file.print_current_page':
            await handlePrintCurrentPage();
            return createAgentActionResult(actionId);
        case 'export.docx':
            await handleExportDocx();
            return createAgentActionResult(actionId);
        case 'export.images':
            await handleExportImages();
            return createAgentActionResult(actionId);
        case 'export.multi_page_tiff':
            await handleExportMultiPageTiff();
            return createAgentActionResult(actionId);
        case 'view.zoom_in':
            handleZoomIn();
            return createAgentActionResult(actionId, {zoom: zoom.value});
        case 'view.zoom_out':
            handleZoomOut();
            return createAgentActionResult(actionId, {zoom: zoom.value});
        case 'view.fit_width':
            handleFitMode('width');
            return createAgentActionResult(actionId, {fitMode: fitMode.value});
        case 'view.fit_height':
            handleFitMode('height');
            return createAgentActionResult(actionId, {fitMode: fitMode.value});
        case 'view.actual_size':
            handleActualSize();
            return createAgentActionResult(actionId, {zoom: zoom.value});
        case 'view.toggle_continuous_scroll':
            continuousScroll.value = !continuousScroll.value;
            return createAgentActionResult(actionId, {continuousScroll: continuousScroll.value});
        case 'view.enable_drag_mode':
            enableDragMode();
            return createAgentActionResult(actionId, {dragMode: dragMode.value});
        case 'view.disable_drag_mode':
            handleAnnotationToolChange('none');
            return createAgentActionResult(actionId, {dragMode: dragMode.value});
        case 'view.set_mode': {
            const mode = getAgentStringInput(input, 'mode');
            if (mode !== 'single' && mode !== 'facing' && mode !== 'facing-first-single') {
                throw new Error('view.set_mode requires input.mode: single, facing, or facing-first-single.');
            }
            viewMode.value = mode;
            return createAgentActionResult(actionId, {viewMode: viewMode.value});
        }
        case 'page_ops.delete_selected':
            await pageOpsDelete(selectedThumbnailPages.value, totalPages.value);
            return createAgentActionResult(actionId, {selectedPages: selectedThumbnailPages.value});
        case 'page_ops.extract_selected':
            await pageOpsExtract(selectedThumbnailPages.value);
            return createAgentActionResult(actionId, {selectedPages: selectedThumbnailPages.value});
        case 'page_ops.rotate_cw_selected':
            await handlePageRotate(selectedThumbnailPages.value, 90);
            return createAgentActionResult(actionId, {selectedPages: selectedThumbnailPages.value});
        case 'page_ops.rotate_ccw_selected':
            await handlePageRotate(selectedThumbnailPages.value, 270);
            return createAgentActionResult(actionId, {selectedPages: selectedThumbnailPages.value});
        case 'page_ops.insert_pages':
            await pageOpsInsert(totalPages.value, getAgentNumberInput(input, 'afterPage') ?? totalPages.value);
            return createAgentActionResult(actionId);
        case 'page_ops.convert_to_pdf':
            if (isDjvuMode.value) {
                openConvertDialog();
            } else {
                await handleOpenFileFromUi();
            }
            return createAgentActionResult(actionId, {showConvertDialog: showConvertDialog.value});
        default:
            throw new Error(`Unsupported EVB agent action: ${actionId}`);
    }
}

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
    openRecentFile,
    handleExportDocx,
    handleExportImages,
    handleExportMultiPageTiff,
    hasPdf,
    isOpeningDocument: isOpeningDocumentForToolbar,
    hasOpenError: computed(() => Boolean(pdfError.value || djvuError.value)),
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
    hasOpenAnnotationNotes,
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
    pdfViewerRef,
    handleFitMode,
    handleGoToPage,
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
    waitForDocumentOpenSettled,
    runAgentAction,
    readAgentResource,
});

defineExpose(workspaceExpose);
</script>
