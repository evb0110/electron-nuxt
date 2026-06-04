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
                :document-busy="toolbarDocumentBusy"
                :controls-disabled="toolbarControlsDisabled"
                :page-dropdown-total-pages="documentMetadataReady ? totalPages : 0"
                :page-labels="toolbarPageLabels"
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
                @open-file="handleOpenFileFromUi"
                @open-settings="handleOpenSettings"
                @save="handleToolbarSave"
                @repair-save="handleToolbarRepairSave"
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
                @insert-image-from-file="handleInsertImageFromFile"
                @paste-image-from-clipboard="handlePasteImageFromClipboard"
                @delete-pages="handleDeletePages"
                @extract-pages="handleExtractPages"
                @rotate-cw="handleRotateCw"
                @rotate-ccw="handleRotateCcw"
                @insert-pages="handleInsertPages"
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
                @set-view-mode="handleOverflowSetViewMode"
                @go-to-page="handleGoToPage"
                @ocr-complete="handleOcrComplete"
            />
        </WorkspaceToolbarHost>

        <WorkspaceDocumentAlerts
            :pdf-error="pdfError"
            :can-use-djvu="canUseDjvu"
            :is-djvu-mode="isDjvuMode"
            :djvu-error="djvuError"
            :djvu-show-banner="djvuShowBanner"
            :djvu-is-loading-pages="djvuIsLoadingPages"
            :djvu-loading-current="djvuLoadingProgress.current"
            :djvu-loading-total="djvuLoadingProgress.total"
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
import PdfSidebar from '@app/components/pdf/PdfSidebar.vue';
import PdfStatusBar from '@app/components/pdf/PdfStatusBar.vue';
import PdfViewer from '@app/components/pdf/PdfViewer.vue';
import { useAnalytics } from '@app/composables/useAnalytics';
import { bucketPageCount } from '@app/utils/analytics';
import { createWorkspaceExpose } from '@app/modules/workspace-shell/composables/createWorkspaceExpose';
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
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    IPdfPageMatches,
    TPageLabelStyle,
} from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    IShapePoint,
    TAnnotationTool,
    TDrawableShapeType,
} from '@app/types/annotations';
import type { TAgentTextMarkupKind } from '@app/composables/pdf/annotations/useAnnotationHighlight';
import { markerRectFromPoint } from '@app/composables/pdf/annotations/pdfPagePointResolver';
import { normalizeMarkerRect } from '@app/composables/pdf/annotationGeometry';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import { formatEtaDuration } from '@app/utils/progressFormatting';
import { DESKTOP_EDITOR_READER_COMMAND_SURFACE } from '@app/utils/readerCommandSurface';
import type { IRecentFile } from '@contracts/shared';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/composables/useTabSessionStore';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
} from '@app/utils/pdfPageLabels';
import { normalizeBookmarkColor } from '@app/utils/pdfOutlineHelpers';
import {
    createAgentBookmarkPlan,
    createAgentBookmarkSnapshot as createAgentBookmarkPlanSnapshot,
    createAgentPageLabelPlan,
    createAgentPageLabelSnapshot as createAgentPageLabelPlanSnapshot,
} from '@app/utils/agentMetadataPlans';
import { capturePdfRegionAsPngBlob } from '@app/composables/pdf/pdfRegionCapture';
import {
    getRectHeight,
    getRectWidth,
    toClientRect,
    type IClientRect,
} from '@app/composables/pdf/pdfRegionGeometry';
import {
    findPdfPageContainer,
    PDF_VIEWER_DOM_SELECTORS,
} from '@app/modules/pdf-viewer/public';

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
    originalPath,
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
    pageLabelsDirty,
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
    markAnnotationDirty,
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
    handleRepairSave,
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
    isSameAnnotationComment,
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
    annotationDirty,
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
const canRepairSave = computed(() => (
    hasPdf.value
    && !toolbarDocumentBusy.value
    && !isAnySaving.value
    && !isHistoryBusy.value
    && !isDjvuMode.value
));
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
    handleToolbarSaveAs,
    handleToolbarToggleContinuousScroll,
    handleToolbarToggleSidebar,
    handleToolbarUndo,
} = useDocumentWorkspaceToolbar({
    tabId: tabId,
    emitOpenSettings: () => emit('open-settings'),
    closeAllDropdowns,
    handleSave,
    handleRepairSave,
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
const workspaceToolbarSnapshot = computed<IWorkspaceToolbarSnapshot>(() => ({
    hasPdf: toolbarHasPdf.value,
    isOpeningDocument: pendingDocumentOpen.value,
    hasOpenError: Boolean(pdfError.value || djvuError.value),
    isPreparingPrint: isPreparingPrint.value,
    isPreparingCurrentPagePrint: isPreparingCurrentPagePrint.value,
    canSave: canSave.value,
    canRepairSave: canRepairSave.value,
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
    currentPage: currentPage.value,
    totalPages: totalPages.value,
}));
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
const AGENT_TEXT_MARKUP_KINDS = [
    'highlight',
    'underline',
    'strikethrough',
    'squiggly',
] as const satisfies readonly TAgentTextMarkupKind[];

const AGENT_SHAPE_TOOLS = [
    'draw',
    'rectangle',
    'circle',
    'line',
    'arrow',
] as const satisfies readonly TDrawableShapeType[];
const AGENT_PAGE_IMAGE_REGIONS = [
    'full',
    'top',
    'bottom',
    'left',
    'right',
    'center',
] as const;
const AGENT_PAGE_IMAGE_RENDER_TIMEOUT_MS = 3_000;
const AGENT_PAGE_IMAGE_RENDER_POLL_MS = 50;

const AGENT_PAGE_LABEL_STYLES = [
    'D',
    'R',
    'r',
    'A',
    'a',
] as const satisfies ReadonlyArray<Exclude<TPageLabelStyle, null>>;

function isAgentRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAgentStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null;
}

function getAgentRawStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' ? value : null;
}

function getAgentNumberInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function getAgentBooleanInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'boolean' ? value : null;
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

function getAgentNumberArrayInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
    return numbers.length === value.length ? numbers : undefined;
}

function hasAgentInputKey(input: Record<string, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(input, key);
}

function isAgentAnnotationTool(value: unknown): value is TAnnotationTool {
    return typeof value === 'string' && AGENT_ANNOTATION_TOOLS.includes(value as TAnnotationTool);
}

function isAgentSidebarTab(value: unknown): value is typeof AGENT_SIDEBAR_TABS[number] {
    return typeof value === 'string' && AGENT_SIDEBAR_TABS.includes(value as typeof AGENT_SIDEBAR_TABS[number]);
}

function isAgentTextMarkupKind(value: unknown): value is TAgentTextMarkupKind {
    return typeof value === 'string' && AGENT_TEXT_MARKUP_KINDS.includes(value as TAgentTextMarkupKind);
}

function isAgentShapeTool(value: unknown): value is TDrawableShapeType {
    return typeof value === 'string' && AGENT_SHAPE_TOOLS.includes(value as TDrawableShapeType);
}

function isAgentPageLabelStyle(value: unknown): value is Exclude<TPageLabelStyle, null> {
    return typeof value === 'string' && AGENT_PAGE_LABEL_STYLES.includes(value as Exclude<TPageLabelStyle, null>);
}

function isAgentOcrPageRange(value: unknown): value is TAgentOcrPageRange {
    return value === 'all' || value === 'current' || value === 'custom';
}

function isAgentPageImageRegion(value: unknown): value is typeof AGENT_PAGE_IMAGE_REGIONS[number] {
    return typeof value === 'string' && AGENT_PAGE_IMAGE_REGIONS.includes(value as typeof AGENT_PAGE_IMAGE_REGIONS[number]);
}

function getAgentNullableStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (value === null) {
        return null;
    }
    return typeof value === 'string' ? value.trim() : undefined;
}

function getAgentPointInput(value: unknown): IShapePoint | null {
    if (!isAgentRecord(value)) {
        return null;
    }
    const x = getAgentNumberInput(value, 'x') ?? getAgentNumberInput(value, 'pageX');
    const y = getAgentNumberInput(value, 'y') ?? getAgentNumberInput(value, 'pageY');
    if (x === null || y === null) {
        return null;
    }
    return {
        x,
        y,
    };
}

function getAgentPointArrayInput(input: Record<string, unknown>, key: string) {
    const value = input[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const points = value
        .map(getAgentPointInput)
        .filter((point): point is IShapePoint => point !== null);
    return points.length > 0 ? points : undefined;
}

function getAgentStrokeArrayInput(input: Record<string, unknown>, key: string) {
    const value = input[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strokes = value
        .filter(Array.isArray)
        .map(points => points
            .map(getAgentPointInput)
            .filter((point): point is IShapePoint => point !== null))
        .filter(points => points.length > 0);
    return strokes.length > 0 ? strokes : undefined;
}

function requireAgentPdfPageCount(actionId: string) {
    if (totalPages.value <= 0) {
        throw new Error(`${actionId} requires an open PDF document.`);
    }
    return totalPages.value;
}

function normalizeAgentPageNumber(value: number | null | undefined, actionId: string) {
    const pageCount = requireAgentPdfPageCount(actionId);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${actionId} requires a valid one-based page number.`);
    }
    const page = Math.trunc(value);
    if (page < 1 || page > pageCount) {
        throw new Error(`${actionId} page ${page} is outside the document.`);
    }
    return page;
}

function getAgentPageNumberInput(input: Record<string, unknown>, actionId: string) {
    return normalizeAgentPageNumber(
        getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'),
        actionId,
    );
}

function getAgentOptionalPageNumberInput(input: Record<string, unknown>, actionId: string) {
    return normalizeAgentPageNumber(
        getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber') ?? currentPage.value,
        actionId,
    );
}

function normalizeAgentUnit(value: number | null | undefined, fallback: number) {
    const normalizedValue = typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
    return Math.min(1, Math.max(0, normalizedValue));
}

function normalizeAgentPositiveUnit(value: number | null | undefined, fallback: number) {
    const normalizedValue = normalizeAgentUnit(value, fallback);
    return normalizedValue > 0 ? normalizedValue : fallback;
}

function getAgentPageImageSelection(input: Record<string, unknown>, pageRect: IClientRect) {
    const pageWidth = getRectWidth(pageRect);
    const pageHeight = getRectHeight(pageRect);
    const hasExplicitCrop = [
        'x',
        'y',
        'width',
        'height',
    ].some(key => hasAgentInputKey(input, key));

    if (hasExplicitCrop) {
        const x = normalizeAgentUnit(getAgentNumberInput(input, 'x'), 0);
        const y = normalizeAgentUnit(getAgentNumberInput(input, 'y'), 0);
        const width = normalizeAgentPositiveUnit(getAgentNumberInput(input, 'width'), 1);
        const height = normalizeAgentPositiveUnit(getAgentNumberInput(input, 'height'), 1);
        const right = normalizeAgentUnit(x + width, 1);
        const bottom = normalizeAgentUnit(y + height, 1);
        if (right <= x || bottom <= y) {
            throw new Error('document.capture_page_image crop must have a positive normalized width and height.');
        }
        return {
            left: pageRect.left + x * pageWidth,
            top: pageRect.top + y * pageHeight,
            right: pageRect.left + right * pageWidth,
            bottom: pageRect.top + bottom * pageHeight,
        };
    }

    const region = getAgentStringInput(input, 'region') ?? 'full';
    if (!isAgentPageImageRegion(region)) {
        throw new Error('document.capture_page_image region must be full, top, bottom, left, right, or center.');
    }

    switch (region) {
        case 'top':
            return {
                ...pageRect,
                bottom: pageRect.top + pageHeight * 0.35,
            };
        case 'bottom':
            return {
                ...pageRect,
                top: pageRect.bottom - pageHeight * 0.35,
            };
        case 'left':
            return {
                ...pageRect,
                right: pageRect.left + pageWidth * 0.5,
            };
        case 'right':
            return {
                ...pageRect,
                left: pageRect.right - pageWidth * 0.5,
            };
        case 'center':
            return {
                left: pageRect.left + pageWidth * 0.2,
                top: pageRect.top + pageHeight * 0.2,
                right: pageRect.right - pageWidth * 0.2,
                bottom: pageRect.bottom - pageHeight * 0.2,
            };
        case 'full':
            return pageRect;
    }
}

function findAgentRenderedPageElement(viewerContainer: HTMLElement, pageNumber: number) {
    const pageElement = findPdfPageContainer(viewerContainer, pageNumber);
    const canvas = pageElement?.querySelector<HTMLCanvasElement>(PDF_VIEWER_DOM_SELECTORS.pageCanvasElement) ?? null;
    if (!pageElement || !canvas || canvas.width <= 0 || canvas.height <= 0) {
        return null;
    }
    return pageElement;
}

async function waitForAgentRenderedPageElement(viewerContainer: HTMLElement, pageNumber: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < AGENT_PAGE_IMAGE_RENDER_TIMEOUT_MS) {
        const pageElement = findAgentRenderedPageElement(viewerContainer, pageNumber);
        if (pageElement) {
            return pageElement;
        }
        await delay(AGENT_PAGE_IMAGE_RENDER_POLL_MS);
        await nextTick();
    }

    throw new Error(`document.capture_page_image could not find a rendered canvas for page ${pageNumber}.`);
}

function bytesToBase64(bytes: Uint8Array) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

async function blobToBase64(blob: Blob) {
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function createAgentCaptureRectMetadata(rect: IClientRect, pageRect: IClientRect) {
    const pageWidth = getRectWidth(pageRect);
    const pageHeight = getRectHeight(pageRect);
    return {
        x: pageWidth > 0 ? (rect.left - pageRect.left) / pageWidth : 0,
        y: pageHeight > 0 ? (rect.top - pageRect.top) / pageHeight : 0,
        width: pageWidth > 0 ? getRectWidth(rect) / pageWidth : 0,
        height: pageHeight > 0 ? getRectHeight(rect) / pageHeight : 0,
    };
}

async function captureAgentPageImage(input: Record<string, unknown>, actionId: string) {
    const pageNumber = getAgentOptionalPageNumberInput(input, actionId);
    const viewer = pdfViewerRef.value;
    const viewerContainer = viewer?.getViewerContainer?.() ?? null;
    if (!viewer || !viewerContainer) {
        throw new Error('document.capture_page_image requires a rendered PDF viewer.');
    }

    handleGoToPage(pageNumber);
    viewer.scrollToPage(pageNumber);
    await viewer.ensurePageMetricsInRange?.(pageNumber, pageNumber);
    await nextTick();

    const pageElement = await waitForAgentRenderedPageElement(viewerContainer, pageNumber);
    const pageRect = toClientRect(pageElement.getBoundingClientRect());
    const selectionRect = getAgentPageImageSelection(input, pageRect);
    const capture = await capturePdfRegionAsPngBlob(viewerContainer, selectionRect);
    if (!capture) {
        throw new Error(`document.capture_page_image could not capture page ${pageNumber}.`);
    }

    return {
        pageNumber,
        crop: createAgentCaptureRectMetadata(capture.outputRect, pageRect),
        image: {
            mimeType: 'image/png',
            sizeBytes: capture.blob.size,
            data: await blobToBase64(capture.blob),
        },
    };
}

function normalizeAgentBookmarkPageIndex(input: Record<string, unknown>, actionId: string) {
    const pageNumber = getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber');
    if (pageNumber !== null) {
        return normalizeAgentPageNumber(pageNumber, actionId) - 1;
    }

    const pageIndex = getAgentNumberInput(input, 'pageIndex');
    if (pageIndex === null) {
        return null;
    }
    const normalizedPageIndex = Math.trunc(pageIndex);
    if (normalizedPageIndex < 0 || normalizedPageIndex >= requireAgentPdfPageCount(actionId)) {
        throw new Error(`${actionId} pageIndex ${normalizedPageIndex} is outside the document.`);
    }
    return normalizedPageIndex;
}

function normalizeAgentPageLabelStyle(value: unknown): TPageLabelStyle {
    if (value === null) {
        return null;
    }
    if (isAgentPageLabelStyle(value)) {
        return value;
    }
    if (typeof value !== 'string') {
        return 'D';
    }

    switch (value.trim().toLowerCase()) {
        case 'decimal':
        case 'number':
        case 'numbers':
        case 'arabic':
            return 'D';
        case 'roman':
        case 'roman-upper':
        case 'uppercase-roman':
            return 'R';
        case 'roman-lower':
        case 'lowercase-roman':
            return 'r';
        case 'letters':
        case 'letters-upper':
        case 'alpha':
        case 'alpha-upper':
        case 'uppercase-alpha':
            return 'A';
        case 'letters-lower':
        case 'alpha-lower':
        case 'lowercase-alpha':
            return 'a';
        case 'literal':
        case 'none':
        case 'prefix':
        case '':
            return null;
        default:
            return 'D';
    }
}

function normalizeAgentPageLabelRange(input: Record<string, unknown>, actionId: string): IPdfPageLabelRange {
    return {
        startPage: getAgentPageNumberInput(input, actionId),
        style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
        prefix: getAgentRawStringInput(input, 'prefix') ?? '',
        startNumber: Math.max(1, Math.trunc(
            getAgentNumberInput(input, 'startNumber')
            ?? getAgentNumberInput(input, 'number')
            ?? 1,
        )),
    };
}

function getEffectiveAgentPageLabels() {
    const pageCount = totalPages.value;
    if (pageCount <= 0) {
        return [];
    }
    if (pageLabels.value && pageLabels.value.length === pageCount) {
        return pageLabels.value;
    }
    return buildPageLabelsFromRanges(pageCount, pageLabelRanges.value);
}

function createAgentPageLabelSnapshot() {
    return createAgentPageLabelPlanSnapshot({
        totalPages: totalPages.value,
        dirty: pageLabelsDirty.value,
        pageLabelRanges: pageLabelRanges.value,
        pageLabels: pageLabels.value,
    });
}

function updateAgentPageLabelRanges(ranges: IPdfPageLabelRange[]) {
    handlePageLabelRangesUpdate(ranges);
    return createAgentPageLabelSnapshot();
}

function getAgentPageLabelRangesInput(input: Record<string, unknown>, actionId: string) {
    const rawRanges = input.ranges;
    if (!Array.isArray(rawRanges)) {
        throw new Error(`${actionId} requires input.ranges.`);
    }
    return rawRanges
        .filter(isAgentRecord)
        .map(range => normalizeAgentPageLabelRange(range, actionId));
}

function getAgentPageLabelApplyRangeOptions(input: Record<string, unknown>, actionId: string) {
    const startPage = normalizeAgentPageNumber(
        getAgentNumberInput(input, 'startPage') ?? getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'),
        actionId,
    );
    const endPage = normalizeAgentPageNumber(
        getAgentNumberInput(input, 'endPage') ?? getAgentNumberInput(input, 'toPage') ?? startPage,
        actionId,
    );
    if (endPage < startPage) {
        throw new Error(`${actionId} endPage must be greater than or equal to startPage.`);
    }
    return {
        startPage,
        endPage,
        style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
        prefix: getAgentRawStringInput(input, 'prefix') ?? '',
        startNumber: Math.max(1, Math.trunc(
            getAgentNumberInput(input, 'startNumber')
            ?? getAgentNumberInput(input, 'number')
            ?? 1,
        )),
    };
}

function applyAgentPageLabelsToRange(input: Record<string, unknown>, actionId: string) {
    const {
        startPage,
        endPage,
        style,
        prefix,
        startNumber,
    } = getAgentPageLabelApplyRangeOptions(input, actionId);
    const labels = [...getEffectiveAgentPageLabels()];
    const segmentLabels = buildPageLabelsFromRanges(
        endPage - startPage + 1,
        [{
            startPage: 1,
            style,
            prefix,
            startNumber,
        }],
    );
    segmentLabels.forEach((label, index) => {
        labels[startPage - 1 + index] = label;
    });
    return updateAgentPageLabelRanges(derivePageLabelRangesFromLabels(labels, totalPages.value));
}

function setAgentPageLabels(input: Record<string, unknown>, actionId: string) {
    const pageCount = requireAgentPdfPageCount(actionId);
    const labels = [...getEffectiveAgentPageLabels()];
    const rawLabels = input.labels;
    if (Array.isArray(rawLabels)) {
        rawLabels.slice(0, pageCount).forEach((label, index) => {
            labels[index] = typeof label === 'string' ? label : '';
        });
    }

    const updates = input.updates;
    if (Array.isArray(updates)) {
        updates
            .filter(isAgentRecord)
            .forEach((update) => {
                const page = getAgentPageNumberInput(update, actionId);
                labels[page - 1] = getAgentRawStringInput(update, 'label') ?? '';
            });
    }

    if (!Array.isArray(rawLabels) && !Array.isArray(updates)) {
        const page = getAgentPageNumberInput(input, actionId);
        labels[page - 1] = getAgentRawStringInput(input, 'label') ?? '';
    }

    return updateAgentPageLabelRanges(derivePageLabelRangesFromLabels(labels, totalPages.value));
}

function previewAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
    return createAgentPageLabelPlan({
        input,
        totalPages: totalPages.value,
        currentRanges: pageLabelRanges.value,
        currentLabels: pageLabels.value,
        dirty: pageLabelsDirty.value,
        actionId,
    });
}

function applyAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
    const plan = previewAgentPageLabelPlan(input, actionId);
    const snapshot = updateAgentPageLabelRanges(plan.ranges);
    return {
        ...snapshot,
        plan,
    };
}

function cloneAgentBookmarkEntry(bookmark: IPdfBookmarkEntry): IPdfBookmarkEntry {
    return {
        ...bookmark,
        items: bookmark.items.map(cloneAgentBookmarkEntry),
    };
}

function cloneAgentBookmarks() {
    return bookmarkItems.value.map(cloneAgentBookmarkEntry);
}

function getAgentBookmarkPathInput(input: Record<string, unknown>, key = 'path') {
    const path = getAgentNumberArrayInput(input, key);
    return path?.map(index => Math.max(0, Math.trunc(index))) ?? null;
}

function getBookmarkListAtPath(
    bookmarks: IPdfBookmarkEntry[],
    path: number[],
    actionId: string,
) {
    let list = bookmarks;
    for (const index of path) {
        const bookmark = list[index];
        if (!bookmark) {
            throw new Error(`${actionId} bookmark path was not found.`);
        }
        list = bookmark.items;
    }
    return list;
}

function getBookmarkLocationAtPath(
    bookmarks: IPdfBookmarkEntry[],
    path: number[] | null,
    actionId: string,
) {
    if (!path || path.length === 0) {
        throw new Error(`${actionId} requires input.path.`);
    }
    const parentPath = path.slice(0, -1);
    const index = path[path.length - 1]!;
    const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
    const bookmark = list[index];
    if (!bookmark) {
        throw new Error(`${actionId} bookmark path was not found.`);
    }
    return {
        list,
        index,
        bookmark,
    };
}

function normalizeAgentBookmarkEntry(input: Record<string, unknown>, actionId: string): IPdfBookmarkEntry {
    const title = getAgentRawStringInput(input, 'title')?.trim() || t('bookmarks.untitled');
    const namedDest = getAgentRawStringInput(input, 'namedDest')
        ?? getAgentRawStringInput(input, 'dest')
        ?? null;
    const items = Array.isArray(input.items)
        ? input.items
            .filter(isAgentRecord)
            .map(item => normalizeAgentBookmarkEntry(item, actionId))
        : [];
    const color = getAgentNullableStringInput(input, 'color');
    return {
        title,
        pageIndex: normalizeAgentBookmarkPageIndex(input, actionId),
        namedDest: namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null,
        bold: getAgentBooleanInput(input, 'bold') ?? false,
        italic: getAgentBooleanInput(input, 'italic') ?? false,
        color: color === null ? null : normalizeBookmarkColor(color),
        items,
    };
}

function normalizeAgentBookmarkInput(input: Record<string, unknown>, actionId: string) {
    const rawBookmark = input.bookmark;
    return normalizeAgentBookmarkEntry(
        isAgentRecord(rawBookmark) ? rawBookmark : input,
        actionId,
    );
}

function createAgentBookmarkSnapshot() {
    return createAgentBookmarkPlanSnapshot(bookmarkItems.value, {dirty: bookmarksDirty.value});
}

function updateAgentBookmarks(bookmarks: IPdfBookmarkEntry[]) {
    handleBookmarksChange({
        bookmarks,
        dirty: true,
    });
    return createAgentBookmarkSnapshot();
}

function setAgentBookmarkTree(input: Record<string, unknown>, actionId: string) {
    const plan = previewAgentBookmarkPlan(input, actionId);
    return {
        ...updateAgentBookmarks(plan.bookmarks),
        plan,
    };
}

function previewAgentBookmarkPlan(input: Record<string, unknown>, actionId: string) {
    return createAgentBookmarkPlan({
        input,
        currentBookmarks: bookmarkItems.value,
        totalPages: totalPages.value,
        dirty: bookmarksDirty.value,
        untitledTitle: t('bookmarks.untitled'),
        actionId,
    });
}

function applyAgentBookmarkPlan(input: Record<string, unknown>, actionId: string) {
    const plan = previewAgentBookmarkPlan(input, actionId);
    return {
        ...updateAgentBookmarks(plan.bookmarks),
        plan,
    };
}

function addAgentBookmark(input: Record<string, unknown>, actionId: string) {
    const bookmarks = cloneAgentBookmarks();
    const parentPath = getAgentBookmarkPathInput(input, 'parentPath') ?? [];
    const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
    const bookmark = normalizeAgentBookmarkInput(input, actionId);
    const index = getAgentNumberInput(input, 'index');
    const insertIndex = index === null
        ? list.length
        : Math.min(list.length, Math.max(0, Math.trunc(index)));
    list.splice(insertIndex, 0, bookmark);
    return updateAgentBookmarks(bookmarks);
}

function addAgentBookmarks(input: Record<string, unknown>, actionId: string) {
    const bookmarks = cloneAgentBookmarks();
    const batchParentPath = getAgentBookmarkPathInput(input, 'parentPath') ?? [];
    const rawItems = input.bookmarks ?? input.items;
    if (!Array.isArray(rawItems)) {
        throw new Error(`${actionId} requires input.bookmarks or input.items.`);
    }

    rawItems
        .filter(isAgentRecord)
        .forEach((item) => {
            const parentPath = getAgentBookmarkPathInput(item, 'parentPath') ?? batchParentPath;
            const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
            const insertIndex = getAgentNumberInput(item, 'index');
            const bookmark = normalizeAgentBookmarkEntry(item, actionId);
            list.splice(
                insertIndex === null ? list.length : Math.min(list.length, Math.max(0, Math.trunc(insertIndex))),
                0,
                bookmark,
            );
        });
    return updateAgentBookmarks(bookmarks);
}

function updateAgentBookmark(input: Record<string, unknown>, actionId: string) {
    const bookmarks = cloneAgentBookmarks();
    const location = getBookmarkLocationAtPath(bookmarks, getAgentBookmarkPathInput(input), actionId);
    const bookmarkUpdates = isAgentRecord(input.bookmark) ? input.bookmark : input;
    const updated = {...location.bookmark};
    if (hasAgentInputKey(bookmarkUpdates, 'title')) {
        updated.title = getAgentRawStringInput(bookmarkUpdates, 'title')?.trim() || t('bookmarks.untitled');
    }
    if (
        hasAgentInputKey(bookmarkUpdates, 'page')
        || hasAgentInputKey(bookmarkUpdates, 'pageNumber')
        || hasAgentInputKey(bookmarkUpdates, 'pageIndex')
    ) {
        updated.pageIndex = normalizeAgentBookmarkPageIndex(bookmarkUpdates, actionId);
    }
    if (hasAgentInputKey(bookmarkUpdates, 'namedDest') || hasAgentInputKey(bookmarkUpdates, 'dest')) {
        const namedDest = getAgentRawStringInput(bookmarkUpdates, 'namedDest')
            ?? getAgentRawStringInput(bookmarkUpdates, 'dest')
            ?? null;
        updated.namedDest = namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null;
    }
    if (hasAgentInputKey(bookmarkUpdates, 'bold')) {
        updated.bold = getAgentBooleanInput(bookmarkUpdates, 'bold') ?? false;
    }
    if (hasAgentInputKey(bookmarkUpdates, 'italic')) {
        updated.italic = getAgentBooleanInput(bookmarkUpdates, 'italic') ?? false;
    }
    if (hasAgentInputKey(bookmarkUpdates, 'color')) {
        const color = getAgentNullableStringInput(bookmarkUpdates, 'color');
        updated.color = color === null ? null : normalizeBookmarkColor(color);
    }
    if (Array.isArray(bookmarkUpdates.items)) {
        updated.items = bookmarkUpdates.items
            .filter(isAgentRecord)
            .map(item => normalizeAgentBookmarkEntry(item, actionId));
    }
    location.list.splice(location.index, 1, updated);
    return updateAgentBookmarks(bookmarks);
}

function deleteAgentBookmark(input: Record<string, unknown>, actionId: string) {
    const bookmarks = cloneAgentBookmarks();
    const location = getBookmarkLocationAtPath(bookmarks, getAgentBookmarkPathInput(input), actionId);
    location.list.splice(location.index, 1);
    return updateAgentBookmarks(bookmarks);
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

function getAgentTextMarkupCreateOptions(input: Record<string, unknown>) {
    const text = getAgentStringInput(input, 'text')
        ?? getAgentStringInput(input, 'query')
        ?? getAgentStringInput(input, 'selectionText');
    if (!text) {
        throw new Error('annotation.create_text_markup requires input.text.');
    }

    const pageNumber = getAgentNumberInput(input, 'page')
        ?? getAgentNumberInput(input, 'pageNumber')
        ?? currentPage.value;
    const occurrence = getAgentNumberInput(input, 'occurrence')
        ?? getAgentNumberInput(input, 'matchIndex')
        ?? 1;
    const markup = getAgentStringInput(input, 'markup')
        ?? getAgentStringInput(input, 'tool')
        ?? getAgentStringInput(input, 'kind');
    const withNote = getAgentBooleanInput(input, 'withNote')
        ?? getAgentBooleanInput(input, 'openNote')
        ?? false;
    const caseSensitive = getAgentBooleanInput(input, 'caseSensitive')
        ?? getAgentBooleanInput(input, 'matchCase')
        ?? false;
    const wholeWord = getAgentBooleanInput(input, 'wholeWord') ?? false;

    if (!isAgentTextMarkupKind(markup ?? 'highlight')) {
        throw new Error('annotation.create_text_markup requires input.markup: highlight, underline, strikethrough, or squiggly.');
    }

    return {
        pageNumber,
        text,
        occurrence,
        markup: (markup ?? 'highlight') as TAgentTextMarkupKind,
        caseSensitive,
        wholeWord,
        withNote,
    };
}

function getAgentPointNoteCreateOptions(input: Record<string, unknown>) {
    const pageNumber = getAgentNumberInput(input, 'page')
        ?? getAgentNumberInput(input, 'pageNumber')
        ?? currentPage.value;
    const pageX = getAgentNumberInput(input, 'pageX') ?? getAgentNumberInput(input, 'x');
    const pageY = getAgentNumberInput(input, 'pageY') ?? getAgentNumberInput(input, 'y');
    if (pageX === null || pageY === null) {
        throw new Error('annotation.create_note_at_point requires input.pageX and input.pageY.');
    }

    return {
        pageNumber,
        pageX,
        pageY,
        preferTextAnchor: getAgentBooleanInput(input, 'preferTextAnchor') ?? true,
    };
}

function patchLatestAgentPointNoteMarkerRect(options: ReturnType<typeof getAgentPointNoteCreateOptions>) {
    const markerRect = markerRectFromPoint(options.pageX, options.pageY);
    if (!markerRect) {
        return null;
    }
    const pageNumber = Math.max(1, Math.trunc(options.pageNumber));
    const openNote = [...sortedAnnotationNoteWindows.value]
        .reverse()
        .find(note =>
            note.comment.source === 'editor'
            && note.comment.pageNumber === pageNumber,
        );
    if (!openNote) {
        return markerRect;
    }

    const previousComment = openNote.comment;
    openNote.comment = {
        ...previousComment,
        markerRect,
    };
    annotationComments.value = annotationComments.value.map(comment => (
        comment.stableKey === previousComment.stableKey
        || isSameAnnotationComment(comment, previousComment)
            ? {
                ...comment,
                markerRect,
            }
            : comment
    ));
    return markerRect;
}

function getAgentShapeCreateOptions(input: Record<string, unknown>) {
    const tool = getAgentStringInput(input, 'shape')
        ?? getAgentStringInput(input, 'tool')
        ?? getAgentStringInput(input, 'kind');
    if (!isAgentShapeTool(tool)) {
        throw new Error('annotation.create_shape requires input.shape: draw, rectangle, circle, line, or arrow.');
    }

    const points = getAgentPointArrayInput(input, 'points');
    const strokes = getAgentStrokeArrayInput(input, 'strokes');
    const firstPoint = points?.[0] ?? strokes?.[0]?.[0] ?? null;
    const x = getAgentNumberInput(input, 'x') ?? getAgentNumberInput(input, 'pageX') ?? firstPoint?.x ?? null;
    const y = getAgentNumberInput(input, 'y') ?? getAgentNumberInput(input, 'pageY') ?? firstPoint?.y ?? null;
    if (x === null || y === null) {
        throw new Error('annotation.create_shape requires normalized input.x and input.y coordinates.');
    }

    return {
        pageNumber: getAgentNumberInput(input, 'page')
            ?? getAgentNumberInput(input, 'pageNumber')
            ?? currentPage.value,
        tool,
        x,
        y,
        width: getAgentNumberInput(input, 'width') ?? undefined,
        height: getAgentNumberInput(input, 'height') ?? undefined,
        x2: getAgentNumberInput(input, 'x2') ?? getAgentNumberInput(input, 'endX') ?? undefined,
        y2: getAgentNumberInput(input, 'y2') ?? getAgentNumberInput(input, 'endY') ?? undefined,
        points,
        strokes,
        color: getAgentStringInput(input, 'color') ?? undefined,
        fillColor: getAgentNullableStringInput(input, 'fillColor'),
        opacity: getAgentNumberInput(input, 'opacity') ?? undefined,
        strokeWidth: getAgentNumberInput(input, 'strokeWidth') ?? undefined,
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
        markerRect: normalizeMarkerRect(comment.markerRect),
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

    if (!resourceKind || resourceKind === 'status' || resourceKind === 'state') {
        return {
            uri,
            tabId,
            status: 'ready',
            currentPage: currentPage.value,
            totalPages: totalPages.value,
            canSave: canSave.value,
            isSaving: isAnySaving.value,
            hasPdf: hasPdf.value,
            workingCopyPath: workingCopyPath.value,
            originalPath: originalPath.value,
            annotationDirty: annotationDirty.value,
            annotationNoteWindowsCount: sortedAnnotationNoteWindows.value.length,
            annotationCommentsStatus: annotationCommentsStatus.value,
            annotationCommentsCount: annotationComments.value.length,
        };
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
                const openNoteMarkerRect = normalizeMarkerRect(openNote?.comment.markerRect);
                const normalizedComment = normalizeAgentAnnotationComment(comment);
                return {
                    ...normalizedComment,
                    markerRect: openNoteMarkerRect ?? normalizedComment.markerRect,
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
        const snapshot = createAgentBookmarkSnapshot();
        return {
            uri,
            tabId,
            status: 'ready',
            count: snapshot.count,
            dirty: snapshot.dirty,
            toc: snapshot.bookmarks,
            bookmarks: snapshot.bookmarks,
        };
    }

    if (resourceKind === 'page-labels' || resourceKind === 'page-numbering') {
        return {
            uri,
            tabId,
            status: 'ready',
            ...createAgentPageLabelSnapshot(),
        };
    }

    throw new Error(`Unsupported workspace document resource: ${resourceKind}`);
}

function readAgentResource(uri: string): Promise<Record<string, unknown>> {
    return Promise.resolve(createAgentResource(uri));
}

function createAgentActionResult(
    actionId: string,
    extra: object = {},
): Record<string, unknown> {
    const payload = extra as Record<string, unknown>;
    return {
        ok: true,
        actionId,
        tabId,
        currentPage: currentPage.value,
        totalPages: totalPages.value,
        ...payload,
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
        case 'document.capture_page_image':
        case 'document.screenshot_page': {
            const result = await captureAgentPageImage(input, actionId);
            return createAgentActionResult(actionId, result);
        }
        case 'page_labels.read':
        case 'page_numbering.read':
            return createAgentActionResult(actionId, createAgentPageLabelSnapshot());
        case 'page_labels.preview':
        case 'page_numbering.preview':
            return createAgentActionResult(actionId, previewAgentPageLabelPlan(input, actionId));
        case 'page_labels.apply_plan':
        case 'page_numbering.apply_plan': {
            const snapshot = applyAgentPageLabelPlan(input, actionId);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'page_labels.set_ranges':
        case 'page_numbering.set_ranges': {
            const snapshot = updateAgentPageLabelRanges(getAgentPageLabelRangesInput(input, actionId));
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'page_labels.apply_range':
        case 'page_numbering.apply_range': {
            const snapshot = applyAgentPageLabelsToRange(input, actionId);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'page_labels.set_labels':
        case 'page_numbering.set_labels': {
            const snapshot = setAgentPageLabels(input, actionId);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'page_labels.clear':
        case 'page_numbering.clear': {
            const snapshot = updateAgentPageLabelRanges([{
                startPage: 1,
                style: 'D',
                prefix: '',
                startNumber: 1,
            }]);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'bookmarks.read':
        case 'toc.read':
            return createAgentActionResult(actionId, createAgentBookmarkSnapshot());
        case 'bookmarks.preview_tree':
        case 'toc.preview_tree':
            return createAgentActionResult(actionId, previewAgentBookmarkPlan(input, actionId));
        case 'bookmarks.apply_plan':
        case 'toc.apply_plan': {
            const snapshot = applyAgentBookmarkPlan(input, actionId);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'bookmarks.set_tree':
        case 'toc.set_tree': {
            const snapshot = setAgentBookmarkTree(input, actionId);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'bookmarks.add':
        case 'toc.add': {
            const snapshot = addAgentBookmark(input, actionId);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'bookmarks.add_batch':
        case 'toc.add_batch': {
            const snapshot = addAgentBookmarks(input, actionId);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'bookmarks.update':
        case 'toc.update': {
            const snapshot = updateAgentBookmark(input, actionId);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
        case 'bookmarks.delete':
        case 'toc.delete': {
            const snapshot = deleteAgentBookmark(input, actionId);
            await nextTick();
            return createAgentActionResult(actionId, snapshot);
        }
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
        case 'annotation.update_note': {
            const comment = findAgentAnnotationComment(input);
            const text = getAgentRawStringInput(input, 'text')
                ?? getAgentRawStringInput(input, 'note')
                ?? getAgentRawStringInput(input, 'noteText');
            if (text === null) {
                throw new Error('annotation.update_note requires input.text.');
            }
            const inputMarkerRect = normalizeMarkerRect(
                input.markerRect as IAnnotationCommentSummary['markerRect'],
            );
            const commentForUpdate = inputMarkerRect
                ? {
                    ...comment,
                    markerRect: inputMarkerRect,
                    hasNote: true,
                }
                : comment;
            const patchAnnotationCommentMarker = () => {
                if (!inputMarkerRect) {
                    return;
                }
                let matched = false;
                const nextComments = annotationComments.value.map((candidate) => {
                    if (
                        candidate.stableKey !== comment.stableKey
                        && candidate.id !== comment.id
                        && (!candidate.annotationId || candidate.annotationId !== comment.annotationId)
                    ) {
                        return candidate;
                    }
                    matched = true;
                    return {
                        ...candidate,
                        markerRect: inputMarkerRect,
                        text,
                        hasNote: true,
                    };
                });
                annotationComments.value = matched
                    ? nextComments
                    : [
                        ...nextComments,
                        {
                            ...commentForUpdate,
                            markerRect: inputMarkerRect,
                            text,
                            hasNote: true,
                        },
                    ];
            };
            patchAnnotationCommentMarker();
            handleOpenAnnotationNote(commentForUpdate);
            await nextTick();
            const openNote = sortedAnnotationNoteWindows.value.find(note =>
                note.comment.stableKey === commentForUpdate.stableKey
                || isSameAnnotationComment(note.comment, commentForUpdate),
            );
            const updated = openNote
                ? true
                : (pdfViewerRef.value?.updateAnnotationComment(commentForUpdate, text) ?? false);
            if (!updated) {
                throw new Error('Annotation note could not be updated.');
            }
            if (openNote) {
                if (inputMarkerRect) {
                    const previousComment = openNote.comment;
                    openNote.comment = {
                        ...previousComment,
                        markerRect: inputMarkerRect,
                    };
                    annotationComments.value = annotationComments.value.map(candidate => (
                        candidate.stableKey === previousComment.stableKey
                        || isSameAnnotationComment(candidate, previousComment)
                            ? {
                                ...candidate,
                                markerRect: inputMarkerRect,
                            }
                            : candidate
                    ));
                }
                updateAnnotationNoteText(openNote.comment.stableKey, text);
                markAnnotationDirty();
            }
            await nextTick();
            patchAnnotationCommentMarker();
            await nextTick();
            return createAgentActionResult(actionId, {
                updated,
                comment: normalizeAgentAnnotationComment({
                    ...commentForUpdate,
                    markerRect: inputMarkerRect ?? comment.markerRect,
                    text,
                    hasNote: text.trim().length > 0 || comment.hasNote === true,
                }),
            });
        }
        case 'annotation.update_text_markup_color': {
            const comment = findAgentAnnotationComment(input);
            const color = getAgentStringInput(input, 'color');
            if (!color) {
                throw new Error('annotation.update_text_markup_color requires input.color.');
            }
            const updated = pdfViewerRef.value?.updateTextMarkupAnnotationColor?.(comment, color) ?? false;
            if (!updated) {
                throw new Error('Text markup annotation color could not be updated.');
            }
            await nextTick();
            return createAgentActionResult(actionId, {
                updated,
                comment: normalizeAgentAnnotationComment({
                    ...comment,
                    color,
                    colorEdited: true,
                }),
            });
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
        case 'annotation.create_note_at_point':
        case 'annotation.place_note': {
            const options = getAgentPointNoteCreateOptions(input);
            const result = await pdfViewerRef.value?.createPointNoteAnnotation(options);
            if (!result) {
                throw new Error('PDF viewer is not ready for annotation.create_note_at_point.');
            }
            await nextTick();
            const markerRect = result.created ? patchLatestAgentPointNoteMarkerRect(options) : null;
            await nextTick();
            return createAgentActionResult(actionId, {
                ...result,
                markerRect,
            });
        }
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
        case 'annotation.create_text_markup':
        case 'annotation.mark_text': {
            const result = await pdfViewerRef.value?.createTextMarkupFromText(
                getAgentTextMarkupCreateOptions(input),
            );
            if (!result) {
                throw new Error('PDF viewer is not ready for annotation.create_text_markup.');
            }
            await nextTick();
            return createAgentActionResult(actionId, {...result});
        }
        case 'annotation.create_shape':
        case 'annotation.draw_shape': {
            const result = await pdfViewerRef.value?.createShapeAnnotation(
                getAgentShapeCreateOptions(input),
            );
            if (!result) {
                throw new Error('PDF viewer is not ready for annotation.create_shape.');
            }
            await nextTick();
            return createAgentActionResult(actionId, {
                ...result,
                shape: result.shape ? normalizeAgentAnnotationComment(result.shape) : null,
            });
        }
        case 'file.save': {
            const hadPendingSave = canSave.value;
            const saveSucceeded = await handleSave();
            await nextTick();
            if (!saveSucceeded || canSave.value) {
                throw new Error('Save did not complete; EVB Viewer still reports pending changes.');
            }
            return createAgentActionResult(actionId, {
                saved: hadPendingSave,
                canSave: canSave.value,
                workingCopyPath: workingCopyPath.value,
                originalPath: originalPath.value,
            });
        }
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
    handleRepairSave,
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
    isPreparingCurrentPagePrint,
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
