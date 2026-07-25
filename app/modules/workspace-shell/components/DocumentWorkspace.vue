<template>
    <WorkspaceShell>
        <WorkspaceToolbarHost
            :is-active="isActive && surfaceMode === 'reader'"
            :can-teleport="canTeleportToolbar"
        >
            <WorkspacePdfToolbarView
                ref="ocrPopupRef"
                :snapshot="workspaceToolbarSnapshot"
                :has-pdf="toolbarHasPdf"
                :can-toggle-sidebar="canToggleSidebar"
                :can-use-ocr="canUseOcr"
                :can-use-djvu="canUseDjvu"
                :is-desktop-runtime="isDesktopRuntime"
                :surface="toolbarSurface"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                :document-busy="toolbarDocumentBusyForDisplay"
                :controls-disabled="toolbarControlsDisabled"
                :page-dropdown-total-pages="documentMetadataReady ? totalPages : 0"
                :page-labels="toolbarPageLabels"
                :navigation-feedback-page="navigationFeedbackPage"
                :navigation-command="navigationCommand"
                :ocr-pdf-document="pdfDocument"
                :ocr-working-copy-path="workingCopyPath"
                :ocr-external-error="docxExportError"
                :ocr-is-exporting-docx="isExportingDocx"
                :ocr-popup-open="ocrPopupOpen"
                :zoom-dropdown-open="zoomDropdownOpen"
                :page-dropdown-open="pageDropdownOpen"
                :overflow-menu-open="overflowMenuOpen"
                :app-menu-open="appMenuOpen"
                @update:ocr-popup-open="handleDropdownOpen('ocr', $event)"
                @update:zoom-dropdown-open="handleDropdownOpen('zoom', $event)"
                @update:page-dropdown-open="handleDropdownOpen('page', $event)"
                @update:overflow-menu-open="handleDropdownOpen('overflow', $event)"
                @update:app-menu-open="handleDropdownOpen('appMenu', $event)"
                @update:zoom="zoom = $event"
                @update:effective-zoom="effectiveZoom = $event"
                @update:zoom-mode="zoomMode = $event"
                @update:fit-mode="fitMode = $event"
                @update:view-mode="viewMode = $event"
                @update:ocr-running="isOcrRunning = $event"
                @open-file="documentControls.handleOpenFileFromUi"
                @open-settings="workspaceCommandBindings.handleOpenSettings"
                @open-scan-cleanup="openScanCleanup"
                @save="handleToolbarSave"
                @repair-save="handleToolbarRepairSave"
                @optimize-pdf-for-interaction="handleToolbarOptimizePdfForInteraction"
                @save-as="handleToolbarSaveAs"
                @print="handlePrint"
                @print-current-page="handlePrintCurrentPage"
                @combine-files="workspaceCommandBindings.handleOpenCombine"
                @export-docx="handleToolbarExportDocx"
                @ocr-export-docx="handleExportDocx"
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
                @toggle-sidebar="handleToolbarToggleSidebar"
                @fit-width="handleToolbarFitWidth"
                @fit-height="handleToolbarFitHeight"
                @toggle-continuous-scroll="handleToolbarToggleContinuousScroll"
                @enable-drag="handleToolbarEnableDrag"
                @disable-drag="handleToolbarDisableDrag"
                @capture-region="handleToolbarCaptureRegion"
                @crop="handleToolbarCrop"
                @quick-note="handleToolbarQuickNote"
                @toggle-fullscreen="workspaceCommandBindings.handleToggleFullscreen"
                @set-view-mode="handleOverflowSetViewMode"
                @go-to-page="handleGoToPage"
                @ocr-complete="handleOcrComplete"
            />
        </WorkspaceToolbarHost>
        <WorkspaceDocumentAlerts
            :visible="surfaceMode === 'reader'"
            :pdf-error="pdfError"
            :show-djvu-conversion-ui="showDjvuConversionUi"
            :djvu-error="djvuError"
            :show-djvu-banner="showDjvuConversionBanner"
            @convert="openConvertDialog"
            @dismiss="djvuDismissBanner"
        />
        <WorkspaceSidebarHost
            v-show="surfaceMode === 'reader'"
            :show-sidebar="toolbarShowSidebar"
            :sidebar-wrapper-style="sidebarWrapperStyle"
            :is-resizing-sidebar="isResizingSidebar"
            :resize-aria-label="t('sidebar.resize')"
            @resize-start="startSidebarResize"
            @container-resize="setSidebarContainerWidth"
        >
            <template #sidebar>
                <PdfSidebar
                    v-if="driverShowsPdfSidebar"
                    v-model:active-tab="sidebarTab"
                    v-model:search-query="searchQuery"
                    :submitted-search-query="submittedSearchQuery"
                    :search-options="searchOptions"
                    :is-open="showSidebar"
                    :is-resizing="isResizingSidebar"
                    :pdf-document="pdfDocument"
                    :current-page="currentPage"
                    :total-pages="totalPages"
                    :page-labels="pageLabels"
                    :page-label-ranges="pageLabelRanges"
                    :search-results="results"
                    :current-result-index="currentResultIndex"
                    :current-result-navigation-id="currentResultNavigationId"
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
                    :bookmark-items="bookmarkItems"
                    :bookmarks-dirty="bookmarksDirty"
                    :bookmark-navigation-intent-version="bookmarkNavigationIntentVersion"
                    :is-page-operation-in-progress="isPageOperationInProgress"
                    :is-djvu-mode="isDjvuMode"
                    :selected-thumbnail-pages="selectedThumbnailPages"
                    :thumbnail-invalidation-request="thumbnailInvalidationRequest"
                    :thumbnail-hidden-annotation-ids="thumbnailHiddenAnnotationIds"
                    @search="handleSearchWhenDocumentReady"
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
                    @annotation-focus-comment="annotationSession.handleAnnotationFocusComment"
                    @annotation-open-note="annotationSession.handleOpenAnnotationNote"
                    @annotation-delete-comment="annotationSession.handleDeleteAnnotationComment"
                    @annotation-place-note="annotationSession.handleStartPlaceNote"
                    @bookmarks-change="handleBookmarksChange"
                    @update:bookmark-edit-mode="bookmarkEditMode = $event"
                    @page-context-menu="showPageContextMenu"
                    @page-rotate-cw="handlePageRotateCw"
                    @page-rotate-ccw="handlePageRotateCcw"
                    @page-extract="handlePageExtract"
                    @page-export="handlePageExport"
                    @page-delete="handlePageDelete"
                    @page-reorder="handlePageReorder"
                    @page-file-drop="documentControls.handlePageFileDrop"
                />
                <DocumentSourceSidebar
                    v-else
                    v-model:active-tab="sidebarTab"
                    :source="documentSourceSidebar.source.value"
                    :current-page="currentPage"
                    :is-resizing="isResizingSidebar"
                    :search-session="documentSourceSidebar.searchSession"
                    :search-focus-request="searchFocusRequest"
                    @go-to-page="handleGoToPage"
                />
            </template>
            <WorkspaceViewerHost
                :has-document="showWorkspaceViewerDocument"
                :keep-document-layout-mounted="suppressEmptyStateProp"
                :suppress-empty-state="suppressEmptyStateProp || suppressEmptyStateForRestore || isDocumentOpenPlaceholderVisible"
            >
                <template #document>
                    <component
                        :is="activeViewerComponent"
                        v-if="mountedDocumentDriver"
                        :ref="bindActiveViewerRef"
                        v-bind="activeViewerProps"
                        v-on="activeViewerListeners"
                        @feature-pack-ready="emit('viewer-owner-ready', $event)"
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
                        :open-combine-result="documentControls.handleOpenFileWithResult"
                        @update:start-section="workspaceCommandBindings.handleStartSectionUpdate"
                        @open-file="documentControls.handleOpenFileFromUi"
                        @open-folder="documentControls.handleOpenFolderFromUi"
                        @open-recent="documentControls.openRecentFile"
                        @remove-recent="removeRecentFile"
                        @reveal-recent="revealRecentFile"
                        @clear-recent="clearRecentFiles"
                    />
                </template>
            </WorkspaceViewerHost>
        </WorkspaceSidebarHost>
        <ScanCleanupWorkspace
            v-if="surfaceMode === 'scan-cleanup'"
            :source-path="workingCopyPath"
            :page-source="documentPageSource"
            :page-source-pending="documentPageSource === null && isLoading"
            :document-key="documentKey"
            :document-revision="documentRevisionToken"
            :current-page="currentPage"
            :total-pages="totalPages"
            :session-state="scanCleanupSessionState"
            :toolbar-active="isActive"
            :can-teleport-toolbar="canTeleportToolbar"
            @done="closeScanCleanup"
            @update:session-state="updateScanCleanupSessionState"
        />
        <WorkspacePageOpProgressOverlay
            v-show="surfaceMode === 'reader'"
            :progress="pageOpBatchProgress"
            :eta-text="pageOpBatchEtaText"
            :is-page-operation-in-progress="isPageOperationInProgress"
        />
        <WorkspaceExportProgressOverlay v-show="surfaceMode === 'reader'" :overlay="exportOverlay" />
        <Teleport v-if="isActive && canTeleportStatus" to="#editor-global-status-host">
            <PdfStatusBar
                :file-path="statusFilePath"
                :file-size-label="statusFileSizeLabel"
                :zoom-label="statusZoomLabelForDisplay"
                :materialization-label="statusMaterializationLabel"
                :materialization-active="statusMaterializationIsActive"
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
            :visible="surfaceMode === 'reader'"
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
            :selected-text-markup-for-properties="selectedTextMarkupForProperties"
            :text-markup-properties-x="textMarkupPropertiesPopover.x"
            :text-markup-properties-y="textMarkupPropertiesPopover.y"
            @update-note-text="updateAnnotationNoteText"
            @update-note-position="updateAnnotationNotePosition"
            @minimize-note="minimizeAnnotationNote"
            @restore-note="restoreAnnotationNote"
            @delete-annotation="annotationSession.handleDeleteAnnotationById"
            @focus-note="bringAnnotationNoteToFront"
            @context-open-note="annotationSession.openContextMenuNote"
            @context-copy-text="annotationSession.copyContextMenuNoteText"
            @context-copy-selection-text="annotationSession.copyContextMenuSelectionText"
            @context-delete="annotationSession.deleteContextMenuComment"
            @context-update-color="annotationSession.handleContextTextMarkupColorUpdate"
            @context-markup="annotationSession.createContextMenuMarkup"
            @context-create-free-note="annotationSession.createContextMenuFreeNote"
            @context-create-selection-note="annotationSession.createContextMenuSelectionNote"
            @context-insert-image-from-file="annotationSession.insertContextMenuImageFromFile"
            @context-paste-image-from-clipboard="annotationSession.pasteContextMenuImageFromClipboard"
            @page-delete="documentControls.handlePageContextMenuDelete"
            @page-extract="documentControls.handlePageContextMenuExtract"
            @page-export="documentControls.handlePageContextMenuExport"
            @page-rotate-cw="documentControls.handlePageContextMenuRotateCw"
            @page-rotate-ccw="documentControls.handlePageContextMenuRotateCcw"
            @page-insert-before="documentControls.handlePageContextMenuInsertBefore"
            @page-insert-after="documentControls.handlePageContextMenuInsertAfter"
            @page-select-all="documentControls.handlePageContextMenuSelectAll"
            @page-invert-selection="documentControls.handlePageContextMenuInvertSelection"
            @shape-update="annotationSession.handleShapePropertyUpdate"
            @shape-delete="annotationSession.handleDeleteSelectedShape"
            @shape-close="annotationSession.closeShapeProperties"
            @text-markup-color-update="annotationSession.handleTextMarkupColorUpdate"
            @text-markup-close="annotationSession.closeTextMarkupProperties"
        />
        <DjvuConversionOverlay
            v-if="showDjvuConversionUi"
            v-show="surfaceMode === 'reader'"
            :is-converting="conversionState.isConverting && !djvuIsLoadingPages"
            :phase="conversionState.phase"
            :percent="conversionState.percent"
            @cancel="handleDjvuCancel"
        />
        <WorkspaceSaveDialogHost
            :visible="surfaceMode === 'reader'"
            :export-scope-dialog-open="exportScopeDialogOpen"
            :export-scope-dialog-mode="exportScopeDialogMode"
            :export-scope-dialog-selected-pages="exportScopeDialogSelectedPages"
            :print-dialog-open="printDialogOpen"
            :print-dialog-selected-pages="printDialogSelectedPages"
            :print-status="printStatus"
            :print-error="printError"
            :is-preparing-print="isPreparingPrint"
            :optimize-dialog-open="optimizeDialogOpen"
            :optimize-dialog-running="isOptimizeDialogRunning"
            :optimize-dialog-progress="optimizeProgress"
            :optimize-dialog-error="optimizeDialogError"
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
            :show-djvu-conversion-ui="showDjvuConversionUi"
            :show-convert-dialog="showConvertDialog"
            :djvu-path="djvuSourcePath"
            @export-submit="handleExportScopeDialogSubmit"
            @export-open-change="handleExportScopeDialogOpenChange"
            @print-submit="handlePrintDialogSubmit"
            @print-open-change="handlePrintDialogOpenChange"
            @optimize-submit="handleOptimizeDialogSubmit"
            @optimize-open-change="handleOptimizeDialogOpenChange"
            @crop-apply="handleCropApply"
            @crop-remove="handleCropRemove"
            @crop-open-change="cropDialogOpen = $event"
            @djvu-convert="handleDjvuConvert"
            @convert-open-change="showConvertDialog = $event"
        />
    </WorkspaceShell>
</template>

<script setup lang="ts">
import '@app/assets/css/pdfjs-overrides.scss';
import '@app/assets/css/pdf-comment-markers.scss';
import '@app/assets/css/pdf-comment-ui.scss';
import '@app/assets/css/pdf-search-highlights.scss';
import '@app/assets/css/pdf-animations.scss';
import '@app/assets/css/pdf-debug-overlays.scss';
import { PdfEmptyState } from '@app/modules/pdf-viewer/public/component-exports/pdfEmptyState';
import { PdfSidebar } from '@app/modules/pdf-viewer/public/component-exports/pdfSidebar';
import { PdfStatusBar } from '@app/modules/pdf-viewer/public/component-exports/pdfStatusBar';
import { useAnalytics } from '@app/composables/useAnalytics';
import { createWorkspaceExposeFromOwners } from '@app/modules/workspace-shell/expose/createWorkspaceExpose';
import WorkspaceAnnotationOverlays from '@app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue';
import WorkspaceDocumentAlerts from '@app/modules/workspace-shell/components/WorkspaceDocumentAlerts.vue';
import DocumentSourceSidebar from '@app/modules/workspace-shell/components/DocumentSourceSidebar.vue';
import WorkspaceExportProgressOverlay from '@app/modules/workspace-shell/components/WorkspaceExportProgressOverlay.vue';
import WorkspacePageOpProgressOverlay from '@app/modules/workspace-shell/components/WorkspacePageOpProgressOverlay.vue';
import WorkspacePdfToolbarView from '@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue';
import WorkspaceSaveDialogHost from '@app/modules/workspace-shell/components/WorkspaceSaveDialogHost.vue';
import WorkspaceShell from '@app/modules/workspace-shell/components/layout/WorkspaceShell.vue';
import WorkspaceSidebarHost from '@app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue';
import WorkspaceToolbarHost from '@app/modules/workspace-shell/components/layout/WorkspaceToolbarHost.vue';
import WorkspaceViewerHost from '@app/modules/workspace-shell/components/layout/WorkspaceViewerHost.vue';
import { useDocumentWorkspaceScanCleanupSurface } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceScanCleanupSurface';
import { useDocumentWorkspaceSplitRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore';
import { useDocumentWorkspaceOptimizeDialog } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceOptimizeDialog';
import { useDocumentWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceToolbar';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    useDocumentWorkspaceAgent,
    type IOcrPopupAgentExpose,
} from '@app/modules/workspace-shell/agent/useDocumentWorkspaceAgent';
import { useWorkspaceStartupReadiness } from '@app/modules/workspace-shell/composables/useWorkspaceStartupReadiness';
import { createDeferredWorkspaceSearch } from '@app/modules/workspace-shell/composables/createDeferredWorkspaceSearch';
import { useWorkspaceOrchestration } from '@app/modules/workspace-shell/useWorkspaceOrchestration';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { useWorkspaceViewerVisibility } from '@app/modules/workspace-shell/composables/useWorkspaceViewerVisibility';
import { useDocumentWorkspacePageSessionRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspacePageSessionRestore';
import { useDocumentWorkspaceViewerPresentation } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceViewerPresentation';
import { useDocumentWorkspaceVisualOpeningState } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceVisualOpeningState';
import { useDocumentOpenSurfaceLifecycle } from '@app/modules/workspace-shell/composables/useDocumentOpenSurfaceLifecycle';
import { useDocumentWorkspacePageOperationHandlers } from '@app/modules/workspace-shell/composables/useDocumentWorkspacePageOperationHandlers';
import { useWorkspaceHostTeleportAvailability } from '@app/modules/workspace-shell/composables/useWorkspaceHostTeleportAvailability';
import { useDocumentSourceSidebarSession } from '@app/modules/workspace-shell/composables/useDocumentSourceSidebarSession';
import { useWorkspacePageNavigationCommand } from '@app/modules/workspace-shell/composables/useWorkspacePageNavigationCommand';
import { createWorkspacePdfSearchResultNavigation } from '@app/modules/workspace-shell/composables/createWorkspacePdfSearchResultNavigation';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import { getDocumentWindowCapability } from '@app/utils/platformDocuments';
import { formatEtaDuration } from '@app/utils/progressFormatting';
import { DESKTOP_EDITOR_READER_COMMAND_SURFACE } from '@app/utils/readerCommandSurface';
import type { IRecentFile } from '@contracts/shared';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';
import { createDocumentWorkspaceAutomationHandlers } from '@app/modules/workspace-shell/automation/createDocumentWorkspaceAutomationHandlers';
import { useDocumentOpenedAutomationEvent } from '@app/modules/workspace-shell/automation/useDocumentOpenedAutomationEvent';
import { usePendingWorkspaceDocumentOpen } from '@app/modules/workspace-shell/composables/usePendingWorkspaceDocumentOpen';
import { useDjvuProjectionActions } from '@app/modules/workspace-shell/composables/useDjvuProjectionActions';
import {
    documentOpenSurfaceSessionKey,
    injectDocumentOpenSurfaceSession,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import {
    createDocumentWorkspaceCommandBindings,
    type IDocumentWorkspaceEmits,
    type IDocumentWorkspaceProps,
    useDocumentWorkspaceLifecycle,
} from '@app/modules/workspace-shell/composables/createDocumentWorkspaceCommandBindings';
const DjvuConversionOverlay = defineAsyncComponent(() => import('@app/modules/djvu-viewer/public').then(componentModule => componentModule.DjvuConversionOverlay));
const ScanCleanupWorkspace = defineAsyncComponent(
    () => import('@app/modules/scan-cleanup/public/workspace').then(module => module.ScanCleanupWorkspace),
);
const documentOpenSurface = injectDocumentOpenSurfaceSession();
if (!documentOpenSurface) {
    throw new Error('DocumentWorkspace requires the host-owned document open surface session');
}
provide(documentOpenSurfaceSessionKey, documentOpenSurface);
const {
    fullscreenSupported,
    isActive,
    isFullscreen,
    isWorkspaceLayoutResizing: isExternalWorkspaceLayoutResizing = false,
    isRenderActive = isActive,
    isTabTransitionBusy,
    documentSession,
    initialViewState = null,
    pendingDocumentOpen: pendingDocumentOpenProp = false,
    pendingDocumentPath = null,
    suppressEmptyState: suppressEmptyStateProp = false,
    splitCacheSession = null,
    startSection = 'recent',
    tabId,
} = defineProps<IDocumentWorkspaceProps>();
const {
    canTeleportStatus,
    canTeleportToolbar,
} = useWorkspaceHostTeleportAvailability({
    toolbarHostId: 'editor-global-toolbar-host',
    statusHostId: 'editor-global-status-host',
});
const { isDesktopRuntime } = useRuntimeEnvironment();
const hasDesktopRuntime = computed(() => isDesktopRuntime.value);
const canUseOcr = hasDesktopRuntime;
const canUseDjvu = true;
const toolbarSurface = DESKTOP_EDITOR_READER_COMMAND_SURFACE;
const isOcrRunning = ref(false);
const ocrPopupRef = ref<IOcrPopupAgentExpose | null>(null);
const {
    closeScanCleanup,
    discardScanCleanupState: discardScanCleanupSurfaceState,
    openScanCleanup,
    scanCleanupSessionState,
    surfaceMode,
    updateScanCleanupSessionState,
} = useDocumentWorkspaceScanCleanupSurface({
    closeAllDropdowns: () => closeAllDropdowns(),
    documentSession,
    initialViewState,
    readDocumentKey: () => documentKey.value,
});
const emit = defineEmits<IDocumentWorkspaceEmits>();
const workspaceCommandBindings = createDocumentWorkspaceCommandBindings(emit);
const { t } = useTypedI18n();
const analytics = useAnalytics();
const analyticsDocumentScope = analytics.createDocumentScope(
    `workspace-document:${documentSession.snapshot.value.sessionId}`,
    { activate: isActive },
);
const toast = useToast();
const { isResolved: recentFilesResolved } = useRecentFiles();
const workspaceSplitCache = useWorkspaceSplitCache();
const workspaceRestoreTracker = useWorkspaceRestoreTracker();
const SEARCH_DOCUMENT_READY_TIMEOUT_MS = 20_000;
const SEARCH_DOCUMENT_READY_POLL_MS = 50;
const isRestoringSplitPayload = ref(false);
const currentPageTransitionHistory = ref<Array<{
    page: number;
    at: number 
}>>([]);
function discardScanCleanupState() {
    discardScanCleanupSurfaceState();
}
const navigationFeedbackPage = ref<number | null>(null);
const {
    pendingDjvuDocumentOpen,
    pendingDocumentOpen,
    pendingDocumentStatusPath,
} = usePendingWorkspaceDocumentOpen({
    isPending: () => pendingDocumentOpenProp === true,
    path: () => pendingDocumentPath,
});
const isActiveRef = computed({
    get: () => isActive,
    set: () => {},
});
watch(
    () => isActive,
    (active) => {
        if (active) {
            analyticsDocumentScope.activate();
        } else {
            analyticsDocumentScope.deactivate();
        }
    },
    { immediate: true },
);
const documentSourceCapabilities = ref({
    annotations: false,
    directImageExport: false,
    outline: false,
    pageEdits: false,
    search: false,
    text: false,
});
const orchestration = useWorkspaceOrchestration({
    analyticsDocumentScope,
    tabId,
    isActive: isActiveRef,
    initialViewState,
    preserveInitialStateForFirstSource: Boolean(initialViewState
        && documentSession.snapshot.value.phase === 'ready'
        && documentSession.snapshot.value.toolbarSnapshot.initialVisualReady),
    documentSession,
    openSurface: documentOpenSurface,
    pendingDocumentPath: pendingDocumentStatusPath,
    pendingDocumentSize: computed(() => (
        documentOpenSurface.snapshot.value.openingPageGeometry?.size ?? null
    )),
    sourceCapabilities: documentSourceCapabilities,
    emit,
});
const {
    documentDriver,
    fileLifecycle,
    viewerShell,
    annotationSession,
    documentControls,
    exportWorkflow,
    pageContextMenuControls,
    interactionControls,
    metadata,
    viewNavigation,
    saveWorkflow,
    printWorkflow,
} = orchestration;
const {
    activeDocumentDriver,
    mountedDocumentDriver,
} = documentDriver;
const {
    pdfSrc,
    pdfError,
    workingCopyPath,
    originalPath,
    documentKey,
    documentRevisionToken,
    notifyPdfInitialVisualReady,
    isDjvuMode,
    djvuSourcePath,
    conversionState,
    djvuIsLoadingPages,
    djvuShowBanner,
    djvuError,
    djvuOpeningPath,
    showConvertDialog,
    openConvertDialog,
    djvuDismissBanner,
    handleDjvuConvert,
    ensureDjvuPdfProjection,
    handleDjvuCancel,
    openBatchProgress,
    recentFiles,
    removeRecentFile,
    clearRecentFiles,
    hasPdf,
    initFromStorage,
} = fileLifecycle;
const {
    pdfViewerRef,
    documentViewerRef,
    zoomDropdownOpen,
    pageDropdownOpen,
    ocrPopupOpen,
    overflowMenuOpen,
    appMenuOpen,
    selectedThumbnailPages,
    thumbnailInvalidationRequest,
    handleSelectedThumbnailPagesUpdate,
    closeAllDropdowns,
    zoom,
    effectiveZoom,
    zoomMode,
    fitMode,
    viewMode,
    currentPage,
    totalPages,
    pdfDocument,
    isLoading,
    continuousScroll,
    showSidebar,
    sidebarTab,
    searchQuery,
    submittedSearchQuery,
    searchOptions,
    results,
    currentResultIndex,
    currentResultNavigationId,
    isSearching,
    searchError,
    searchProgress,
    isTruncated,
    minQueryLength,
    handleSearch,
    handleSearchNext,
    handleSearchPrevious,
    handleGoToResult: selectPdfSearchResult,
    searchFocusRequest,
    sidebarWidth,
    sidebarWrapperStyle,
    isResizingSidebar,
    startSidebarResize,
    setSidebarContainerWidth,
    cleanupSidebarResizeListeners,
} = viewerShell;
const isExternalWorkspaceLayoutResizingRef = toRef(() => isExternalWorkspaceLayoutResizing === true);
const isActiveViewerLayoutResizing = computed(() => (
    isResizingSidebar.value || isExternalWorkspaceLayoutResizingRef.value || isTabTransitionBusy
));
watch(
    () => showSidebar.value && sidebarTab.value === 'annotations',
    (annotationsVisible) => {
        if (annotationsVisible) {
            void pdfViewerRef.value?.ensurePdfAnnotationNameReconciliation?.('annotations-ui-open');
        }
    },
    {flush: 'post'},
);
const {
    exportOverlay,
    exportScopeDialogOpen,
    exportScopeDialogMode,
    exportScopeDialogSelectedPages,
    handleExportImages,
    handleExportMultiPageTiff,
    handleExportScopeDialogSubmit,
    handleExportScopeDialogOpenChange,
} = exportWorkflow;
const {
    pageLabels,
    pageLabelRanges,
    pageLabelsDirty,
    pageLabelsResolved,
    handlePageLabelRangesUpdate,
    bookmarkEditMode,
    bookmarkItems,
    bookmarksDirty,
    bookmarkNavigationIntentVersion,
    handleBookmarksChange,
} = metadata;
const {
    annotationContextMenu,
    annotationContextMenuStyle,
    annotationContextMenuCanCopy,
    annotationContextMenuCanCopySelection,
    annotationContextMenuCanCreateFree,
    annotationContextMenuCanInsertImage,
    annotationContextMenuIsImage,
    contextMenuAnnotationLabel,
    contextMenuDeleteActionLabel,
    annotationTool,
    annotationKeepActive,
    annotationPlacingPageNote,
    annotationSettings,
    annotationComments,
    annotationCommentsStatus,
    annotationActiveCommentStableKey,
    thumbnailHiddenAnnotationIds,
    markAnnotationCommentsLoading,
    annotationDirty,
    markAnnotationDirty,
    handleAnnotationToolChange,
    handleAnnotationSettingChange,
    annotationNotePositions,
    sortedAnnotationNoteWindows,
    updateAnnotationNoteText,
    updateAnnotationNotePosition,
    minimizeAnnotationNote,
    restoreAnnotationNote,
    bringAnnotationNoteToFront,
    isSameAnnotationComment,
    shapePropertiesPopover,
    selectedShapeForProperties,
    textMarkupPropertiesPopover,
    selectedTextMarkupForProperties,
} = annotationSession;
const {
    pageContextMenu,
    pageContextMenuStyle,
    showPageContextMenu,
} = pageContextMenuControls;
const {
    handleSave,
    handleRepairSave,
    handleOptimizePdfForInteraction: handleOptimizePdfForInteractionDirect,
    handleOptimizePdfAsCopy,
    handleSaveAs: handleSaveAsDirect,
    handleExportDocx: handleExportDocxDirect,
    handleOcrComplete,
    docxExportError,
    isAnySaving,
    isExportingDocx,
    canSave,
    isHistoryBusy,
} = saveWorkflow;
const {
    handlePrint,
    handlePrintCurrentPage,
    handlePrintDialogOpenChange,
    handlePrintDialogSubmit,
    isPreparingPrint,
    printDialogOpen,
    printDialogSelectedPages,
    printError,
    printStatus,
} = printWorkflow;
const {
    canUndo,
    canRedo,
    handleUndo,
    handleRedo,
    handleFitMode,
    enableDragMode,
    handleGoToPage: performGoToPage,
} = viewNavigation;
const {
    handleGoToPage,
    navigationCommand,
} = useWorkspacePageNavigationCommand(performGoToPage);
const handleGoToResult = createWorkspacePdfSearchResultNavigation({
    results,
    navigate: handleGoToPage,
    select: selectPdfSearchResult,
});
const {
    handleCaptureRegion,
    handleCrop,
    cropDialogOpen,
    cropDialogLoading,
    cropDialogMargins,
    cropDialogMediaBox,
    cropDialogCurrentBox,
    cropDialogPageNumber,
    cropDialogRotation,
    handleZoomIn,
    handleZoomOut,
    handleActualSize,
    handleDropdownOpen: handleDropdownOpenDirect,
    captureSplitPayload,
    restoreSplitPayload,
} = interactionControls;
const {
    statusFilePath,
    statusFileSizeLabel,
    statusZoomLabel,
    statusMaterializationLabel,
    statusMaterializationIsActive,
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
} = documentControls;
const {
    hasQueuedSplitRestore,
    isExternallyRestoring,
    suppressEmptyState: suppressEmptyStateForRestore,
} = useDocumentWorkspaceSplitRestore({
    tabId: tabId,
    pendingDocumentOpen,
    isTabTransitionBusy: computed(() => isTabTransitionBusy === true),
    workspaceSplitCache,
    workspaceRestoreTracker,
    splitCacheSession: computed(() => splitCacheSession),
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
    documentViewerRef,
    initFromStorage,
    cleanupSidebarResizeListeners,
    captureSplitPayload,
    restoreSplitPayload,
    isRestoringSplitPayload,
    currentPageTransitionHistory,
});

const {
    activeDriverCapabilities,
    driverShowsNativePdf,
    driverShowsPdfSidebar,
    driverShowsDjvuSource,
    driverStartupVisualSource,
    isDocumentOpenPlaceholderVisible,
    isOpeningDocumentForToolbar,
    toolbarDocumentBusy,
    toolbarHasPdf,
    toolbarShowSidebar,
    canToggleSidebar,
    canRepairSave,
    canOptimizePdf,
} = useWorkspaceViewerVisibility({
    activeDocumentDriver,
    conversionState,
    djvuOpeningPath,
    hasPdf,
    hasQueuedSplitRestore,
    isAnySaving,
    isExternallyRestoring,
    isHistoryBusy,
    isOcrRunning,
    isRestoringSplitPayload,
    pendingDocumentOpen,
    showSidebar,
});
useDocumentWorkspacePageSessionRestore({
    activeViewerAdapter: activeDocumentDriver,
    currentPage,
    documentViewerRef,
    initialPage: initialViewState?.currentPage,
    isLoading,
    onRestore: handleGoToPage,
    totalPages,
});

const {
    scheduleStartupOpenVisualReady,
    dispatchStartupOpenVisualReady,
} = useWorkspaceStartupReadiness({documentViewerRef});
const {
    handlePdfInitialVisualPending,
    handlePdfInitialVisualReady,
    initialDocumentVisualReady,
    resolveDocumentOpenVisualSettleIfReady,
    waitForDocumentOpenSettled,
} = useDocumentOpenVisualSettle({
    tabId,
    hasPdf,
    pdfSrc,
    pdfDocument,
    totalPages,
    pageLabelsResolved,
    isLoading,
    pdfError,
    djvuError,
    showDjvuSource: driverShowsDjvuSource,
    showNativePdfViewer: driverShowsNativePdf,
    openSurface: documentOpenSurface,
    markAnnotationCommentsLoading,
});
const {
    handleDocumentInitialVisualPending,
    handleDocumentInitialVisualReady,
} = useDocumentOpenSurfaceLifecycle({
    openSurface: documentOpenSurface,
    onInitialVisualPending: handlePdfInitialVisualPending,
    onInitialVisualReady: handlePdfInitialVisualReady,
    pendingDocumentOpen,
    pendingDocumentIdentity: computed(() => String(pendingDocumentPath ?? tabId)),
});
const {
    handleInitialVisualReady: handleDocumentInitialVisualReadyWithAutomationEventBase,
    handleSave: handleSaveWithAutomationEvent,
} = createDocumentWorkspaceAutomationHandlers({
    getContext: () => ({
        currentPage: currentPage.value,
        path: originalPath.value ?? workingCopyPath.value,
        tabId,
        totalPages: totalPages.value,
    }),
    handleInitialVisualReady: handleDocumentInitialVisualReady,
    handleSave,
});
function handleDocumentInitialVisualReadyWithAutomationEvent() {
    notifyPdfInitialVisualReady();
    return handleDocumentInitialVisualReadyWithAutomationEventBase();
}
const documentSourceSidebar = useDocumentSourceSidebarSession({onNavigate: pageIndex => handleGoToPage(pageIndex + 1, {navigationSource: 'search'})});
const documentPageSource = shallowRef<IDocumentPageSource | null>(null);
function handlePageSourceUpdate(source: IDocumentPageSource | null) {
    documentPageSource.value = source;
    documentSourceSidebar.publishSource(source);
}
const {
    activeViewerComponent,
    activeViewerProps,
    activeViewerListeners,
    bindActiveViewerRef,
} = documentDriver.bindView({
    documentSourceCurrentResultIndex: computed(() => isActiveRef.value && showSidebar.value ? documentSourceSidebar.searchSession.currentResultIndex.value : -1),
    documentSourceSearchResults: computed(() => isActiveRef.value && showSidebar.value ? documentSourceSidebar.searchSession.results.value : []),
    isRenderActive: computed(() => isRenderActive),
    isWorkspaceLayoutResizing: isActiveViewerLayoutResizing,
    navigationFeedbackPage,
    onInitialVisualPending: handleDocumentInitialVisualPending,
    onInitialVisualReady: handleDocumentInitialVisualReadyWithAutomationEvent,
    onPageSourceUpdate: handlePageSourceUpdate,
});

const {
    canOptimizePdfForDisplay,
    canRepairSaveForDisplay,
    documentMetadataReady,
    isOpeningDocumentForToolbarDisplay,
    statusZoomLabelForDisplay,
    toolbarControlsDisabled,
    toolbarDocumentBusyForDisplay,
    toolbarPageLabels,
} = useDocumentWorkspaceVisualOpeningState({
    toolbarHasPdf,
    isLoading,
    initialDocumentVisualReady,
    pdfError,
    djvuError,
    isOpeningDocumentForToolbar,
    toolbarDocumentBusy,
    canRepairSave,
    canOptimizePdf,
    statusZoomLabel,
    totalPages,
    pageLabels,
    pageLabelsResolved,
    isAnySaving,
    t,
});
const {
    showDjvuConversionBanner,
    showDjvuConversionUi,
    showWorkspaceViewerDocument: showWorkspaceViewerDocumentFromAdapter,
} = useDocumentWorkspaceViewerPresentation({
    activeViewerCapabilities: computed(() => activeDriverCapabilities.value ?? null),
    canUseDjvu,
    conversionState,
    documentOpenReady: computed(() => documentOpenSurface.snapshot.value.phase === 'ready'),
    djvuOpeningPath,
    djvuShowBanner,
    initialDocumentVisualReady,
    pendingDjvuDocumentOpen,
    showDjvuSource: driverShowsDjvuSource,
    showNativePdfViewer: driverShowsNativePdf,
    showStandardPdfViewer: driverShowsPdfSidebar,
});
const showWorkspaceViewerDocument = computed(() => {
    const phase = documentOpenSurface.snapshot.value.phase;
    return showWorkspaceViewerDocumentFromAdapter.value
        || phase === 'pending'
        || phase === 'geometry-committed'
        || phase === 'canvas-committed'
        || phase === 'viewport-committed';
});
const {
    handleOptimizeDialogOpenChange,
    handleOptimizeDialogSubmit,
    handleOptimizeProgress,
    isOptimizeDialogRunning,
    openOptimizePdfForInteractionDialog,
    optimizeDialogError,
    optimizeDialogOpen,
    optimizeProgress,
} = useDocumentWorkspaceOptimizeDialog({
    canOptimizePdf: canOptimizePdfForDisplay,
    handleOptimizePdfAsCopy,
    onOptimizeSuccess: () => {
        toast.add({
            color: 'success',
            title: t('optimizePdf.successTitle'),
        });
    },
});
const revealRecentFile = (file: IRecentFile) => getDocumentWindowCapability()
    .showItemInFolder(file.originalPath)
    .catch(() => undefined);

const {
    ensureEditProjection,
    handleDropdownOpen,
    handleExportDocx,
    handleInsertImageFromFile,
    handlePasteImageFromClipboard,
    handleQuickNoteAction,
    handleSaveAs,
    runEdit: runPdfEditAction,
} = useDjvuProjectionActions({
    isDjvuMode,
    currentPage,
    documentViewerRef,
    ensureProjection: reason => ensureDjvuPdfProjection(reason, new AbortController().signal),
    saveAs: handleSaveAsDirect,
    exportDocx: handleExportDocxDirect,
    handleDropdownOpen: handleDropdownOpenDirect,
    insertImageFromFile: annotationSession.handleInsertImageFromFile,
    pasteImageFromClipboard: annotationSession.handlePasteImageFromClipboard,
    createQuickNote: annotationSession.handleQuickNoteAction,
});

const {
    canExportDocx,
    handleCropApply,
    handleCropRemove,
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
    handleToolbarRepairSave,
    handleToolbarOptimizePdfForInteraction,
    handleToolbarSaveAs,
    handleToolbarToggleContinuousScroll,
    handleToolbarToggleSidebar,
    handleToolbarUndo,
} = useDocumentWorkspaceToolbar({
    tabId: tabId,
    emitOpenSettings: () => emit('open-settings'),
    closeAllDropdowns,
    handleSave: handleSaveWithAutomationEvent,
    handleRepairSave,
    handleOptimizePdfForInteraction: openOptimizePdfForInteractionDialog,
    handleSaveAs,
    handleExportDocx,
    handleUndo,
    handleRedo,
    handleCaptureRegion,
    handleCrop: () => runPdfEditAction(handleCrop),
    handleQuickNoteAction,
    handleFitMode,
    handleAnnotationToolChange,
    enableDragMode,
    handleRemoveCrop: documentControls.handleRemoveCrop,
    handleCropPages: documentControls.handleCropPages,
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
const {
    handleDeletePages,
    handleExtractPages,
    handleInsertPages,
    handlePageDelete,
    handlePageExport,
    handlePageExtract,
    handlePageReorder,
    handlePageRotateCcw,
    handlePageRotateCw,
    handleRotateCcw,
    handleRotateCw,
} = useDocumentWorkspacePageOperationHandlers({
    documentControls,
    handleExportImages,
    ensurePdfProjectionForEdit: ensureEditProjection,
    selectedThumbnailPages,
    totalPages,
});
watch(pdfSrc, (src) => {
    navigationFeedbackPage.value = null;
    if (src) {
        scheduleStartupOpenVisualReady('pdf-src');
    }
});
watch(driverStartupVisualSource, (source) => {
    if (source) {
        navigationFeedbackPage.value = null;
        scheduleStartupOpenVisualReady(source);
    }
});
useDocumentOpenedAutomationEvent({
    currentPage,
    originalPath,
    tabId,
    totalPages,
    waitForDocumentOpenSettled,
    workingCopyPath,
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
const deferredWorkspaceSearch = createDeferredWorkspaceSearch({
    tabId,
    pollIntervalMs: SEARCH_DOCUMENT_READY_POLL_MS,
    timeoutMs: SEARCH_DOCUMENT_READY_TIMEOUT_MS,
    isReady: () => Boolean(
        workingCopyPath.value
        && pdfDocument.value
        && totalPages.value > 0
        && !isLoading.value
        && !isOpeningDocumentForToolbarDisplay.value,
    ),
    readDiagnostics: () => ({
        hasWorkingCopyPath: Boolean(workingCopyPath.value),
        hasPdfDocument: Boolean(pdfDocument.value),
        totalPages: totalPages.value,
        isLoading: isLoading.value,
        isOpeningDocument: isOpeningDocumentForToolbarDisplay.value,
    }),
    readIdentity: () => ({
        documentRevisionToken: documentRevisionToken.value,
        workingCopyPath: workingCopyPath.value,
    }),
    isIdentityCurrent: identity => (
        identity.workingCopyPath === workingCopyPath.value
        && identity.documentRevisionToken === documentRevisionToken.value
    ),
    readQuery: () => searchQuery.value,
    readOptions: () => ({ ...searchOptions.value }),
    restoreSearch: (query, options) => {
        searchQuery.value = query;
        searchOptions.value = options;
    },
    waitForDocumentOpenSettled,
    handleSearch,
});
const handleSearchWhenDocumentReady = deferredWorkspaceSearch.handleSearchWhenDocumentReady;
const {
    runAgentAction,
    readAgentResource,
} = useDocumentWorkspaceAgent({
    annotationComments,
    annotationCommentsStatus,
    annotationDirty,
    annotationPlacingPageNote,
    annotationTool,
    bookmarkItems,
    bookmarksDirty,
    canSave,
    canUndo,
    canRedo,
    closeAllDropdowns,
    closeShapeProperties: annotationSession.closeShapeProperties,
    closeTextMarkupProperties: annotationSession.closeTextMarkupProperties,
    continuousScroll,
    viewerCapabilities: computed(() => activeDriverCapabilities.value ?? createDefaultWorkspaceViewerCapabilities()),
    currentPage,
    documentIdentity: fileLifecycle.documentRevisionInfo,
    fitMode,
    handleActualSize,
    handleAnnotationFocusComment: annotationSession.handleAnnotationFocusComment,
    handleAnnotationToolChange,
    handleBookmarksChange,
    updateTextMarkupColorWithHistory: annotationSession.updateTextMarkupColorWithHistory,
    handleDeleteAnnotationComment: annotationSession.handleDeleteAnnotationComment,
    handleDropdownOpen: (dropdown, isOpen) => {
        handleDropdownOpen(dropdown, isOpen);
    },
    handleExportDocx,
    handleExportImages,
    handleExportMultiPageTiff,
    handleFitMode,
    handleGoToPage,
    handleOpenAnnotationNote: annotationSession.handleOpenAnnotationNote,
    handleOpenFileFromUi: documentControls.handleOpenFileFromUi,
    handleRepairSave,
    handleOptimizePdfForInteraction: handleOptimizePdfForInteractionDirect,
    handleUndo,
    handleRedo,
    handlePageLabelRangesUpdate,
    handlePageRotate: documentControls.handlePageRotate,
    handlePrint,
    handlePrintCurrentPage,
    handleQuickNoteAction,
    handleSave,
    handleSaveAs,
    handleZoomIn,
    handleZoomOut,
    hasPdf,
    isAnySaving,
    isDjvuMode,
    isSameAnnotationComment,
    markAnnotationDirty,
    ocrPopupOpen,
    ocrPopupRef,
    openConvertDialog,
    originalPath,
    pageLabelRanges,
    pageLabels,
    pageLabelsDirty,
    pageOpsDelete: documentControls.pageOpsDelete,
    pageOpsExtract: documentControls.pageOpsExtract,
    pageOpsInsert: documentControls.pageOpsInsert,
    handleCropPages: documentControls.handleCropPages,
    handleRemoveCrop: documentControls.handleRemoveCrop,
    pdfViewerRef,
    selectedThumbnailPages,
    showConvertDialog,
    showSidebar,
    sidebarTab,
    sortedAnnotationNoteWindows,
    t,
    tabId,
    totalPages,
    updateAnnotationNoteText,
    viewMode,
    waitForDocumentOpenSettled,
    workingCopyPath,
    zoom,
});
const workspaceExpose = createWorkspaceExposeFromOwners({
    orchestration,
    handleSave: handleSaveWithAutomationEvent,
    handleOptimizePdfForInteraction: () => Promise.resolve(openOptimizePdfForInteractionDialog()),
    handleSaveAs,
    handleExportDocx,
    handleGoToPage,
    handleCrop: () => { void handleToolbarCrop(); },
    handleInsertImageFromFile,
    handlePasteImageFromClipboard,
    initialVisualReady: initialDocumentVisualReady,
    isOpeningDocument: isOpeningDocumentForToolbarDisplay,
    canRepairSave: canRepairSaveForDisplay,
    canOptimizePdf: canOptimizePdfForDisplay,
    canExportDocx,
    viewerCapabilities: computed(() => activeDriverCapabilities.value ?? createDefaultWorkspaceViewerCapabilities()),
    captureSplitPayload,
    restoreSplitPayload,
    waitForDocumentOpenSettled,
    runAgentAction,
    readAgentResource,
});
const workspaceToolbarSnapshot = computed(workspaceExpose.getToolbarSnapshot);
fileLifecycle.bindWorkspaceProjection({
    pendingDocumentPath: computed(() => pendingDocumentPath),
    toolbarSnapshot: workspaceToolbarSnapshot,
    currentViewState: computed(() => {
        const retainedState = documentSession.snapshot.value.viewState ?? initialViewState;
        return retainedState
            ? {
                ...retainedState,
                surfaceMode: surfaceMode.value,
                ...(scanCleanupSessionState.value ? {scanCleanup: scanCleanupSessionState.value} : {}),
            }
            : null;
    }),
    formatPendingBatchLabel: values => t('tabs.preparingBatch', values),
    publishRecord: record => emit('update-document-record', record),
});
useDocumentWorkspaceLifecycle({
    emit,
    workspaceExpose,
    surfaceMode,
    discardScanCleanupState,
    disposeDeferredSearch: deferredWorkspaceSearch.dispose,
    handleOptimizeProgress,
});
defineExpose(workspaceExpose);
</script>
