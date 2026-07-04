<template>
    <WorkspaceShell>
        <WorkspaceToolbarHost :is-active="isActive" :can-teleport="canTeleportToolbar">
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
                @update:current-page="currentPage = $event"
                @update:ocr-running="isOcrRunning = $event"
                @open-file="documentControls.handleOpenFileFromUi"
                @open-settings="handleOpenSettings"
                @save="handleToolbarSave"
                @repair-save="handleToolbarRepairSave"
                @optimize-pdf-for-interaction="handleToolbarOptimizePdfForInteraction"
                @save-as="handleToolbarSaveAs"
                @print="handlePrint"
                @print-current-page="handlePrintCurrentPage"
                @combine-images="handleOpenCombine"
                @export-docx="handleToolbarExportDocx"
                @ocr-export-docx="handleExportDocx"
                @export-images="handleExportImages()"
                @export-multi-page-tiff="handleExportMultiPageTiff()"
                @convert-to-pdf="openConvertDialog"
                @undo="handleToolbarUndo"
                @redo="handleToolbarRedo"
                @insert-image-from-file="annotationSession.handleInsertImageFromFile"
                @paste-image-from-clipboard="annotationSession.handlePasteImageFromClipboard"
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
                @toggle-fullscreen="handleToggleFullscreen"
                @set-view-mode="handleOverflowSetViewMode"
                @go-to-page="handleGoToPage"
                @ocr-complete="handleOcrComplete"
            />
        </WorkspaceToolbarHost>

        <WorkspaceDocumentAlerts
            :pdf-error="pdfError"
            :show-djvu-conversion-ui="showDjvuConversionUi"
            :djvu-pending-open="pendingDjvuDocumentOpen"
            :djvu-opening="djvuBannerOpening"
            :djvu-error="djvuError"
            :djvu-show-banner="djvuShowBanner"
            :djvu-is-loading-pages="djvuIsLoadingPages"
            :djvu-loading-current="djvuLoadingProgress.current"
            :djvu-loading-total="djvuLoadingProgress.total"
            @convert="openConvertDialog"
            @dismiss="djvuDismissBanner"
        />

        <WorkspaceSidebarHost
            :show-sidebar="Boolean(showStandardPdfViewer && showSidebar)"
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
                    :bookmark-items="bookmarkItems"
                    :bookmarks-dirty="bookmarksDirty"
                    :is-page-operation-in-progress="isPageOperationInProgress"
                    :is-djvu-mode="isDjvuMode"
                    :selected-thumbnail-pages="selectedThumbnailPages"
                    :thumbnail-invalidation-request="thumbnailInvalidationRequest"
                    :thumbnail-hidden-annotation-ids="thumbnailHiddenAnnotationIds"
                    :thumbnail-page-preview-provider="pdfViewerRef?.getPagePreview ?? null"
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
            </template>

            <!-- The overlay prop is lease-only once a viewer is mounted; the transition slot also serves the pre-viewer fallback path. -->
            <WorkspaceViewerHost
                :has-document="showWorkspaceViewerDocument"
                :show-transition-overlay="showDocumentTransitionSkeleton"
                :suppress-empty-state="suppressEmptyState || isDocumentOpenPlaceholderVisible"
            >
                <template #document>
                    <component
                        :is="activeViewerComponent"
                        v-if="activeViewerAdapter"
                        :ref="bindActiveViewerRef"
                        v-bind="activeViewerProps"
                        v-on="activeViewerListeners"
                    />
                </template>
                <template #transition>
                    <WorkspaceDocumentTransitionSkeleton v-if="showWorkspaceTransitionSkeleton" />
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
                        @open-file="documentControls.handleOpenFileFromUi"
                        @open-folder="documentControls.handleOpenFolderFromUi"
                        @open-recent="documentControls.openRecentFile"
                        @remove-recent="removeRecentFile"
                        @reveal-recent="revealRecentFile"
                        @clear-recent="clearRecentFiles"
                        @open-settings="handleOpenSettings"
                        @combine-files="handleOpenCombine"
                        @open-combine-result="documentControls.handleOpenFileWithResult"
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
                :file-name="statusFileName"
                :file-path="statusFilePath"
                :file-size-label="statusFileSizeLabel"
                :zoom-label="statusZoomLabelForDisplay"
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
            :selected-text-markup-for-properties="selectedTextMarkupForProperties"
            :text-markup-properties-x="textMarkupPropertiesPopover.x"
            :text-markup-properties-y="textMarkupPropertiesPopover.y"
            @update-note-text="updateAnnotationNoteText"
            @update-note-position="updateAnnotationNotePosition"
            @minimize-note="minimizeAnnotationNote"
            @restore-note="restoreAnnotationNote"
            @delete-comment="annotationSession.handleDeleteAnnotationComment"
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
import { bucketPageCount } from '@app/utils/analytics';
import { createWorkspaceExpose } from '@app/modules/workspace-shell/expose/createWorkspaceExpose';
import WorkspaceAnnotationOverlays from '@app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue';
import WorkspaceDocumentAlerts from '@app/modules/workspace-shell/components/WorkspaceDocumentAlerts.vue';
import WorkspaceExportProgressOverlay from '@app/modules/workspace-shell/components/WorkspaceExportProgressOverlay.vue';
import WorkspacePageOpProgressOverlay from '@app/modules/workspace-shell/components/WorkspacePageOpProgressOverlay.vue';
import WorkspacePdfToolbarView from '@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue';
import WorkspaceSaveDialogHost from '@app/modules/workspace-shell/components/WorkspaceSaveDialogHost.vue';
import WorkspaceShell from '@app/modules/workspace-shell/components/layout/WorkspaceShell.vue';
import WorkspaceSidebarHost from '@app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue';
import WorkspaceToolbarHost from '@app/modules/workspace-shell/components/layout/WorkspaceToolbarHost.vue';
import WorkspaceViewerHost from '@app/modules/workspace-shell/components/layout/WorkspaceViewerHost.vue';
import { useDocumentWorkspaceSplitRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore';
import { useDocumentWorkspaceOptimizeDialog } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceOptimizeDialog';
import { useDocumentWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceToolbar';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    useDocumentWorkspaceAgent,
    type IOcrPopupAgentExpose,
} from '@app/modules/workspace-shell/agent/useDocumentWorkspaceAgent';
import { useWorkspaceStartupReadiness } from '@app/modules/workspace-shell/composables/useWorkspaceStartupReadiness';
import { useWorkspaceOrchestration } from '@app/modules/workspace-shell/useWorkspaceOrchestration';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import type { IWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
import { useWorkspaceViewerVisibility } from '@app/modules/workspace-shell/composables/useWorkspaceViewerVisibility';
import { useDocumentWorkspaceVisualOpeningState } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceVisualOpeningState';
import { useDocumentTransitionSkeletonLease } from '@app/modules/workspace-shell/composables/useDocumentTransitionSkeletonLease';
import { useDocumentWorkspaceDocumentRecord } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceDocumentRecord';
import { useDocumentWorkspacePageOperationHandlers } from '@app/modules/workspace-shell/composables/useDocumentWorkspacePageOperationHandlers';
import { useWorkspaceHostTeleportAvailability } from '@app/modules/workspace-shell/composables/useWorkspaceHostTeleportAvailability';
import WorkspaceDocumentTransitionSkeleton from '@app/modules/workspace-shell/components/WorkspaceDocumentTransitionSkeleton.vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TStartSection } from '@app/types/startSection';
import type { IPdfPageMatches } from '@app/types/pdfUi';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getDocumentMenuCapability,
    getDocumentWindowCapability,
} from '@app/utils/platformDocuments';
import { formatEtaDuration } from '@app/utils/progressFormatting';
import { getErrorMessage } from '@app/utils/error';
import { getDocumentKindFromPath } from '@app/utils/supportedDocumentPaths';
import { DESKTOP_EDITOR_READER_COMMAND_SURFACE } from '@app/utils/readerCommandSurface';
import type { IRecentFile } from '@contracts/shared';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentSessionController } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import { useWorkspaceViewerAdapterBinding } from '@app/modules/workspace-shell/viewers/useWorkspaceViewerAdapterBinding';
import { emitAutomationEvent } from '@app/modules/workspace-shell/automation/automationReadinessEvents';

const DjvuConversionOverlay = defineAsyncComponent(() => import('@app/modules/djvu-viewer/public').then(componentModule => componentModule.DjvuConversionOverlay));

const {
    fullscreenSupported,
    isActive,
    isFullscreen,
    isRenderActive = isActive,
    isTabTransitionBusy,
    documentSession = null,
    initialViewState = null,
    pendingDocumentOpen: pendingDocumentOpenProp = false,
    pendingDocumentPath = null,
    splitCacheSession = null,
    startSection = 'recent',
    tabId,
} = defineProps<{
    tabId: string;
    isActive: boolean;
    isRenderActive?: boolean | undefined;
    isTabTransitionBusy: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    documentSession?: IWorkspaceDocumentSessionController | null | undefined;
    initialViewState?: ITabViewSessionState | null | undefined;
    pendingDocumentOpen?: boolean | undefined;
    pendingDocumentPath?: TDocumentRef | null | undefined;
    splitCacheSession?: IWorkspaceSplitCacheSessionState | null | undefined;
    startSection?: TStartSection | undefined;
}>();
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
const emit = defineEmits<{
    'update-document-record': [record: IWorkspaceDocumentRecord];
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'expose-ready': [expose: IWorkspaceExpose];
    'expose-released': [];
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
const analyticsDocumentScope = analytics.createDocumentScope(
    `workspace-document:${documentSession?.snapshot.value.sessionId ?? tabId}`,
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
const navigationFeedbackPage = ref<number | null>(null);
const pendingDocumentOpen = computed(() => pendingDocumentOpenProp === true);
const pendingDocumentStatusPath = computed<TDocumentRef | null>(() => (
    pendingDocumentOpen.value ? pendingDocumentPath : null
));
const pendingDjvuDocumentOpen = computed(() => (
    pendingDocumentOpen.value
    && typeof pendingDocumentPath === 'string'
    && getDocumentKindFromPath(pendingDocumentPath) === 'djvu'
));
let latestDocumentOpenedToken: symbol | null = null;
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

const orchestration = useWorkspaceOrchestration({
    analyticsDocumentScope,
    isActive: isActiveRef,
    initialViewState,
    pendingDocumentPath: pendingDocumentStatusPath,
    emit,
});

const {
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
    workspaceSettings,
} = orchestration;

const {
    pdfSrc,
    pdfReloadSrc,
    pdfData,
    pdfError,
    workingCopyPath,
    documentRevisionInfo,
    documentRevisionToken,
    originalPath,
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
    isDirty,
    hasPdf,
    initFromStorage,
} = fileLifecycle;

const {
    pdfViewerRef,
    nativePdfViewerRef,
    djvuViewerRef,
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
    dragMode,
    continuousScroll,
    showSidebar,
    sidebarTab,
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
    sidebarWidth,
    sidebarWrapperStyle,
    isResizingSidebar,
    startSidebarResize,
    cleanupSidebarResizeListeners,
} = viewerShell;

const { appSettings } = workspaceSettings;

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
    hasAnnotationChanges,
    hasLivePdfJsAnnotationChanges,
    hasSavedPdfJsAnnotationBaselineChanges,
    hasPreservedAnnotationSourceChanges,
    pendingEmbeddedAnnotationDeleteCount,
    applyAnnotationComments,
    markAnnotationCommentsLoading,
    annotationDirty,
    markAnnotationDirty,
    handleAnnotationToolChange,
    handleAnnotationToolAutoReset,
    handleAnnotationToolCancel,
    handleAnnotationSettingChange,
    handleAnnotationState,
    handleAnnotationModified,
    hasOpenAnnotationNotes,
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
    handleSaveAs,
    handleExportDocx,
    handleOcrComplete,
    docxExportError,
    isAnySaving,
    isExportingDocx,
    canSave,
    isSaving,
    isSavingAs,
    isHistoryBusy,
    hasPendingUnsavedChanges,
} = saveWorkflow;

const {
    handlePrint,
    handlePrintCurrentPage,
    handlePrintDialogOpenChange,
    handlePrintDialogSubmit,
    isPreparingPrint,
    isPreparingCurrentPagePrint,
    printDialogOpen,
    printDialogSelectedPages,
    printError,
    printStatus,
} = printWorkflow;

const {
    isFitWidthActive,
    isFitHeightActive,
    annotationCursorMode,
    canUndo,
    canRedo,
    handleUndo,
    handleRedo,
    handleFitMode,
    enableDragMode,
    handleGoToPage,
    shouldAcceptViewerCurrentPageUpdate,
} = viewNavigation;

const {
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
    handleZoomIn,
    handleZoomOut,
    handleActualSize,
    handleDropdownOpen,
    captureSplitPayload,
    restoreSplitPayload,
} = interactionControls;

const {
    statusFileName,
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
} = documentControls;

const hiddenSearchPageMatches = new Map<number, IPdfPageMatches>();
const viewerSearchPageMatches = computed(() => (isActiveRef.value && showSidebar.value ? pageMatches.value : hiddenSearchPageMatches));
const viewerCurrentSearchMatch = computed(() => (isActiveRef.value && showSidebar.value ? currentResult.value : null));
const viewerSourcePdfData = computed(() => pdfData.value);
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
    activeViewerAdapter,
    activeViewerCapabilities,
    nativePdfSourcePath,
    showNativePdfViewer,
    showStandardPdfViewer,
    showNativeDjvuViewer,
    showNativePreviewViewer,
    isDocumentOpenPlaceholderVisible,
    isOpeningDocumentForToolbar,
    toolbarDocumentBusy,
    toolbarHasPdf,
    toolbarShowSidebar,
    canToggleSidebar,
    canRepairSave,
    canOptimizePdf,
} = useWorkspaceViewerVisibility({
    conversionState,
    djvuOpeningPath,
    djvuSourcePath,
    hasPdf,
    hasQueuedSplitRestore,
    isAnySaving,
    isDjvuMode,
    isExternallyRestoring,
    isHistoryBusy,
    isOcrRunning,
    isRestoringSplitPayload,
    pendingDocumentOpen,
    pdfSrc,
    showSidebar,
});

const {
    scheduleStartupOpenVisualReady,
    dispatchStartupOpenVisualReady,
} = useWorkspaceStartupReadiness({documentViewerRef});
const {
    handlePdfInitialVisualPending,
    handlePdfInitialVisualReady,
    initialDocumentVisualReady,
    resetDocumentOpenVisualSettleWaiter,
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
    showNativeDjvuViewer,
    showNativePdfViewer,
    markAnnotationCommentsLoading,
});
const {
    handleDocumentInitialVisualPending,
    handleDocumentInitialVisualReady,
    showDocumentTransitionSkeleton,
} = useDocumentTransitionSkeletonLease({
    djvuError,
    onInitialVisualPending: handlePdfInitialVisualPending,
    onInitialVisualReady: handlePdfInitialVisualReady,
    pendingDocumentOpen,
    pdfError,
});

const {
    activeViewerComponent,
    activeViewerProps,
    activeViewerListeners,
    bindActiveViewerRef,
} = useWorkspaceViewerAdapterBinding({
    activeViewerAdapter,
    annotationCursorMode,
    annotationKeepActive,
    annotationSettings,
    annotationTool,
    authorName: computed(() => appSettings.value.authorName),
    continuousScroll,
    currentResultNavigationId,
    currentSearchMatch: viewerCurrentSearchMatch,
    currentPage,
    djvuSourcePath,
    dragMode,
    fitMode,
    isAnySaving,
    isRenderActive: computed(() => isRenderActive),
    isResizingSidebar,
    nativePdfSourcePath,
    pageMatches: viewerSearchPageMatches,
    pdfReloadSrc,
    pdfSrc,
    pdfViewerRef,
    nativePdfViewerRef,
    djvuViewerRef,
    sourcePdfData: viewerSourcePdfData,
    viewMode,
    workingCopyPath,
    documentRevisionToken,
    zoom,
    zoomMode,
    onAnnotationCommentClick: annotationSession.handleAnnotationCommentClick,
    onAnnotationComments: handleAnnotationComments,
    onAnnotationContextMenu: annotationSession.handleViewerAnnotationContextMenu,
    onAnnotationModified: handleAnnotationModified,
    onAnnotationNotePlacementChange: value => { annotationPlacingPageNote.value = value; },
    onAnnotationOpenNote: annotationSession.handleOpenAnnotationNote,
    onAnnotationSetting: handleAnnotationSettingChange,
    onAnnotationState: handleAnnotationState,
    onAnnotationToolAutoReset: handleAnnotationToolAutoReset,
    onAnnotationToolCancel: handleAnnotationToolCancel,
    onCurrentPageUpdate: handleViewerCurrentPageUpdate,
    onDocumentUpdate: value => { pdfDocument.value = value as typeof pdfDocument.value; },
    onEffectiveZoomUpdate: value => { effectiveZoom.value = value; },
    onFitModeUpdate: value => { fitMode.value = value as typeof fitMode.value; },
    onImagePlacementFinalize: annotationSession.handleFinalizePlacedImage,
    onInitialVisualPending: handleDocumentInitialVisualPending,
    onInitialVisualReady: handleDocumentInitialVisualReadyWithAutomationEvent,
    onLoadError: handlePdfViewerLoadError,
    onLoading: value => { isLoading.value = value; },
    onNavigationFeedbackPageUpdate: value => { navigationFeedbackPage.value = value; },
    onShapeContextMenu: annotationSession.handleShapeContextMenu,
    onTotalPagesUpdate: handleViewerTotalPagesUpdate,
    onZoomModeUpdate: value => { zoomMode.value = value as typeof zoomMode.value; },
    onZoomUpdate: value => { zoom.value = value; },
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
const showWorkspaceViewerDocument = computed(() => (
    showStandardPdfViewer.value
    || showNativePdfViewer.value
    || showNativeDjvuViewer.value
));
const showPendingDocumentOpenSkeleton = computed(() => (
    isDocumentOpenPlaceholderVisible.value
    && !showWorkspaceViewerDocument.value
    && !pdfError.value
    && !djvuError.value
));
const showWorkspaceTransitionSkeleton = computed(() => (
    showDocumentTransitionSkeleton.value
    || showPendingDocumentOpenSkeleton.value
));
const hasDjvuBannerOpeningContext = computed(() => (
    pendingDjvuDocumentOpen.value
    || Boolean(djvuOpeningPath.value)
    || isDjvuMode.value
    || showNativeDjvuViewer.value
));
const djvuBannerOpening = computed(() => (
    hasDjvuBannerOpeningContext.value
    && !djvuError.value
    && (
        pendingDjvuDocumentOpen.value
        || Boolean(djvuOpeningPath.value)
        || showWorkspaceTransitionSkeleton.value
        || (
            showNativeDjvuViewer.value
            && !initialDocumentVisualReady.value
        )
    )
));
const showDjvuConversionUi = computed(() => (
    canUseDjvu
    && (
        activeViewerCapabilities.value?.conversionBanner === true
        || activeViewerCapabilities.value?.conversionDialog === true
        || pendingDjvuDocumentOpen.value
        || Boolean(djvuOpeningPath.value)
        || conversionState.value.isConverting
    )
));
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
async function revealRecentFile(file: IRecentFile) {
    try {
        await getDocumentWindowCapability().showItemInFolder(file.originalPath);
    } catch {
        // Best-effort; ignore failures (path may have moved or permissions changed).
    }
}

function handleViewerTotalPagesUpdate(value: number) {
    // Suppress split-restore totalPages=0 until the viewer emits the parsed count.
    if (value === 0 && Boolean(pdfSrc.value)) {
        return;
    }
    totalPages.value = value;
    if (value > 0) {
        analyticsDocumentScope.merge({
            pageCountBucket: bucketPageCount(value),
            totalPages: value,
        });
    }
}

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
    handleCrop,
    handleQuickNoteAction: annotationSession.handleQuickNoteAction,
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
const workspaceToolbarSnapshot = computed<IWorkspaceToolbarSnapshot>(() => ({
    hasPdf: toolbarHasPdf.value,
    viewerCapabilities: activeViewerCapabilities.value ?? createDefaultWorkspaceViewerCapabilities(),
    isOpeningDocument: isOpeningDocumentForToolbarDisplay.value,
    hasOpenError: Boolean(pdfError.value) || Boolean(djvuError.value),
    isPreparingPrint: isPreparingPrint.value,
    isPreparingCurrentPagePrint: isPreparingCurrentPagePrint.value,
    canSave: canSave.value,
    canRepairSave: canRepairSaveForDisplay.value,
    canOptimizePdf: canOptimizePdfForDisplay.value,
    canUndo: canUndo.value,
    canRedo: canRedo.value,
    canExportDocx: canExportDocx.value,
    isSaving: isSaving.value,
    isSavingAs: isSavingAs.value,
    isAnySaving: isAnySaving.value,
    isHistoryBusy: isHistoryBusy.value,
    isExportingDocx: isExportingDocx.value,
    isFitWidthActive: isFitWidthActive.value,
    isFitHeightActive: isFitHeightActive.value,
    showSidebar: toolbarShowSidebar.value,
    dragMode: dragMode.value,
    continuousScroll: continuousScroll.value,
    isDjvuMode: isDjvuMode.value,
    isCapturingRegion: isCapturingRegion.value,
    isCropSelecting: isCropSelecting.value,
    isPlacingPageNote: annotationPlacingPageNote.value,
    zoom: zoom.value,
    effectiveZoom: effectiveZoom.value,
    zoomMode: zoomMode.value,
    fitMode: fitMode.value,
    viewMode: viewMode.value,
    currentPage: isOpeningDocumentForToolbarDisplay.value ? 1 : currentPage.value,
    totalPages: isOpeningDocumentForToolbarDisplay.value ? 0 : totalPages.value,
}));
useDocumentWorkspaceDocumentRecord({
    pendingDocumentOpen,
    pendingDocumentPath: computed(() => pendingDocumentPath),
    openBatchProgress,
    hasPdf,
    isDjvuMode,
    fileName: fileLifecycle.fileName,
    originalPath,
    documentIdentity: documentRevisionInfo,
    isDirty: hasPendingUnsavedChanges,
    djvuSourcePath,
    toolbarSnapshot: workspaceToolbarSnapshot,
    formatPendingBatchLabel: values => t('tabs.preparingBatch', values),
    publishRecord: record => emit('update-document-record', record),
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
    selectedThumbnailPages,
    totalPages,
});

function handleViewerCurrentPageUpdate(page: number) {
    const previousPage = currentPage.value;
    const viewer = documentViewerRef.value?.getViewerContainer?.() ?? null;
    if (!shouldAcceptViewerCurrentPageUpdate(page)) {
        BrowserLogger.diagnostic('pdf-nav', `[workspace-page-update] ignored stale viewer page ${previousPage}->${page}`, {
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
    BrowserLogger.diagnostic('pdf-nav', `[workspace-page-update] viewer->workspace ${previousPage}->${page}`, {
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
    void nextTick().then(() => {
        emitAutomationEvent('navigation-idle', {
            page,
            previousPage,
            tabId,
            totalPages: totalPages.value,
        });
    });
}

function handleDocumentInitialVisualReadyWithAutomationEvent() {
    handleDocumentInitialVisualReady();
    emitAutomationEvent('first-page-rendered', {
        currentPage: currentPage.value,
        path: originalPath.value ?? workingCopyPath.value,
        tabId,
        totalPages: totalPages.value,
    });
}

async function handleSaveWithAutomationEvent() {
    const saved = await handleSave();
    if (saved) {
        emitAutomationEvent('save-committed', {
            path: originalPath.value ?? workingCopyPath.value,
            tabId,
        });
    }
    return saved;
}
watch(pdfSrc, (src) => {
    navigationFeedbackPage.value = null;
    if (src) {
        resetDocumentOpenVisualSettleWaiter();
        scheduleStartupOpenVisualReady('pdf-src');
    }
});
function handlePdfViewerLoadError(error: unknown) {
    const message = getErrorMessage(error).trim();
    pdfError.value = message || t('errors.file.open');
}
watch(showNativePreviewViewer, (visible) => {
    if (visible) {
        navigationFeedbackPage.value = null;
        scheduleStartupOpenVisualReady(showNativePdfViewer.value ? 'native-pdf-src' : 'djvu-src');
    }
});
watch([
    workingCopyPath,
    originalPath,
], ([
    nextWorkingCopyPath,
    nextOriginalPath,
]) => {
    const documentPath = nextOriginalPath ?? nextWorkingCopyPath;
    if (!documentPath) {
        return;
    }

    const openToken = Symbol('document-opened');
    latestDocumentOpenedToken = openToken;
    void waitForDocumentOpenSettled()
        .then(() => {
            if (latestDocumentOpenedToken !== openToken) {
                return;
            }
            emitAutomationEvent('document-opened', {
                currentPage: currentPage.value,
                path: documentPath,
                tabId,
                totalPages: totalPages.value,
            });
        })
        .catch(() => {});
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

function delaySearchReadinessPoll() {
    return new Promise<void>(resolve => {
        setTimeout(resolve, SEARCH_DOCUMENT_READY_POLL_MS);
    });
}

function isDocumentReadyForSearch() {
    return Boolean(
        workingCopyPath.value
        && pdfDocument.value
        && totalPages.value > 0
        && !isLoading.value
        && !isOpeningDocumentForToolbarDisplay.value,
    );
}

async function waitForDocumentReadyForSearch() {
    if (isDocumentReadyForSearch()) {
        return true;
    }

    BrowserLogger.diagnostic('pdf-search', 'Delaying search until document open settles', {
        tabId,
        hasWorkingCopyPath: Boolean(workingCopyPath.value),
        hasPdfDocument: Boolean(pdfDocument.value),
        totalPages: totalPages.value,
        isLoading: isLoading.value,
        isOpeningDocument: isOpeningDocumentForToolbarDisplay.value,
    });

    let settleFinished = false;
    const settlePromise = waitForDocumentOpenSettled()
        .catch((error) => {
            BrowserLogger.warn('pdf-search', 'Document open settle wait failed before search', {
                tabId,
                error: getErrorMessage(error),
            });
        })
        .finally(() => {
            settleFinished = true;
        });
    const deadline = Date.now() + SEARCH_DOCUMENT_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (isDocumentReadyForSearch()) {
            return true;
        }

        if (settleFinished) {
            await delaySearchReadinessPoll();
        } else {
            await Promise.race([
                settlePromise,
                delaySearchReadinessPoll(),
            ]);
        }
        await nextTick();
    }

    BrowserLogger.warn('pdf-search', 'Search requested before document became ready', {
        tabId,
        hasWorkingCopyPath: Boolean(workingCopyPath.value),
        hasPdfDocument: Boolean(pdfDocument.value),
        totalPages: totalPages.value,
        isLoading: isLoading.value,
        isOpeningDocument: isOpeningDocumentForToolbarDisplay.value,
    });
    return isDocumentReadyForSearch();
}

async function handleSearchWhenDocumentReady() {
    const requestedQuery = searchQuery.value;
    const requestedOptions = { ...searchOptions.value };

    if (!await waitForDocumentReadyForSearch()) {
        return;
    }
    if (!searchQuery.value && requestedQuery) {
        searchQuery.value = requestedQuery;
        searchOptions.value = requestedOptions;
    }
    await handleSearch();
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
    currentPage,
    documentIdentity: documentRevisionInfo,
    fitMode,
    handleActualSize,
    handleAnnotationFocusComment: annotationSession.handleAnnotationFocusComment,
    handleAnnotationToolChange,
    handleBookmarksChange,
    updateTextMarkupColorWithHistory: annotationSession.updateTextMarkupColorWithHistory,
    handleDeleteAnnotationComment: annotationSession.handleDeleteAnnotationComment,
    handleDropdownOpen,
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
    handleQuickNoteAction: annotationSession.handleQuickNoteAction,
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
const readHasPreservedAnnotationSourceChanges = (): boolean => hasPreservedAnnotationSourceChanges();
const workspaceExpose: IWorkspaceExpose = createWorkspaceExpose({
    handleSave: handleSaveWithAutomationEvent,
    handleRepairSave,
    handleOptimizePdfForInteraction: () => Promise.resolve(openOptimizePdfForInteractionDialog()),
    handleSaveAs,
    handlePrint,
    handlePrintCurrentPage: () => { void handlePrintCurrentPage(); },
    handleUndo: () => { void handleUndo(); },
    handleRedo: () => { void handleRedo(); },
    handleOpenFileFromUi: documentControls.handleOpenFileFromUi,
    handleCombineImages: documentControls.handleCombineImages,
    handleOpenFileDirectWithPersist: documentControls.handleOpenFileDirectWithPersist,
    handleOpenFileDirectBatchWithPersist: documentControls.handleOpenFileDirectBatchWithPersist,
    handleOpenFileWithResult: documentControls.handleOpenFileWithResult,
    handleCloseFileFromUi: documentControls.handleCloseFileFromUi,
    openRecentFile: documentControls.openRecentFile,
    handleExportDocx,
    handleExportImages,
    handleExportMultiPageTiff,
    hasPdf,
    isOpeningDocument: isOpeningDocumentForToolbarDisplay,
    hasOpenError: computed(() => Boolean(pdfError.value) || Boolean(djvuError.value)),
    isPreparingPrint,
    isPreparingCurrentPagePrint,
    canSave,
    canRepairSave: canRepairSaveForDisplay,
    canOptimizePdf: canOptimizePdfForDisplay,
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
    pdfToolbarSnapshotViewerRef: pdfViewerRef,
    pdfAutomationViewerRef: pdfViewerRef,
    documentViewerRef,
    handleFitMode,
    handleGoToPage,
    handleToggleSidebar: () => { showSidebar.value = !showSidebar.value; },
    handleToggleContinuousScroll: () => { continuousScroll.value = !continuousScroll.value; },
    handleEnableDragMode: () => { enableDragMode(); },
    handleDisableDragMode: () => { handleAnnotationToolChange('none'); },
    handleCaptureRegion: () => { void handleCaptureRegion(); },
    handleCrop: () => { void handleToolbarCrop(); },
    handleQuickNote: () => { void annotationSession.handleQuickNoteAction(); },
    handleInsertImageFromFile: async () => { await annotationSession.handleInsertImageFromFile(); },
    handlePasteImageFromClipboard: async () => { await annotationSession.handlePasteImageFromClipboard(); },
    selectedThumbnailPages,
    pageOpsDelete: documentControls.pageOpsDelete,
    pageOpsExtract: documentControls.pageOpsExtract,
    handlePageRotate: documentControls.handlePageRotate,
    pageOpsInsert: documentControls.pageOpsInsert,
    totalPages,
    isDjvuMode,
    viewerCapabilities: computed(() => activeViewerCapabilities.value ?? createDefaultWorkspaceViewerCapabilities()),
    openConvertDialog,
    captureSplitPayload,
    restoreSplitPayload,
    waitForDocumentOpenSettled,
    runAgentAction,
    readAgentResource,
    workingCopyPath,
    originalPath,
    annotationComments,
    annotationCommentsStatus,
    annotationDirty,
    isDirty,
    hasAnnotationChanges,
    hasLivePdfJsAnnotationChanges,
    hasSavedPdfJsAnnotationBaselineChanges,
    hasPreservedAnnotationSourceChanges: readHasPreservedAnnotationSourceChanges,
    hasPendingUnsavedChanges,
    pendingEmbeddedAnnotationDeleteCount,
    pageLabelsDirty,
    bookmarksDirty,
    sortedAnnotationNoteWindows,
    handleOcrComplete: payload => handleOcrComplete(payload as Parameters<typeof handleOcrComplete>[0]),
});

let unsubscribeOptimizeProgress: (() => void) | null = null;

onMounted(() => {
    unsubscribeOptimizeProgress = getDocumentMenuCapability().onPdfOptimizeProgress?.((progress) => {
        handleOptimizeProgress(progress);
    }) ?? null;
    emit('expose-ready', workspaceExpose);
});

onBeforeUnmount(() => {
    unsubscribeOptimizeProgress?.();
    unsubscribeOptimizeProgress = null;
    emit('expose-released');
});

defineExpose(workspaceExpose);
</script>
