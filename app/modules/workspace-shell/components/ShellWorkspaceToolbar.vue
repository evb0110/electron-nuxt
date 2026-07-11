<template>
    <WorkspacePdfToolbarView
        :snapshot="snapshot"
        :has-pdf="hasPdf"
        :can-use-ocr="canUseOcr"
        :is-desktop-runtime="isDesktopRuntime"
        :surface="toolbarSurface"
        :is-fullscreen="isFullscreen"
        :fullscreen-supported="fullscreenSupported"
        :document-busy="shellDocumentBusy"
        :controls-disabled="shellControlsDisabled"
        :ocr-popup-open="ocrPopupOpen"
        :zoom-dropdown-open="zoomDropdownOpen"
        :page-dropdown-open="pageDropdownOpen"
        :overflow-menu-open="overflowMenuOpen"
        :app-menu-open="appMenuOpen"
        @update:ocr-popup-open="handleOcrPopupOpenUpdate"
        @update:zoom-dropdown-open="handleZoomDropdownOpenUpdate"
        @update:page-dropdown-open="handlePageDropdownOpenUpdate"
        @update:overflow-menu-open="handleOverflowMenuOpenUpdate"
        @update:app-menu-open="handleAppMenuOpenUpdate"
        @update:zoom="handleZoomUpdate"
        @update:effective-zoom="handleEffectiveZoomUpdate"
        @update:zoom-mode="handleZoomModeUpdate"
        @update:fit-mode="handleFitModeUpdate"
        @update:view-mode="handleViewModeUpdate"
        @update:current-page="handleCurrentPageUpdate"
        @open-file="handleOpenFile"
        @open-settings="handleOpenSettings"
        @save="handleSave"
        @repair-save="handleRepairSave"
        @optimize-pdf-for-interaction="handleOptimizePdfForInteraction"
        @save-as="handleSaveAs"
        @print="handlePrint"
        @print-current-page="handlePrintCurrentPage"
        @combine-files="handleCombineImages"
        @export-docx="handleExportDocx"
        @ocr-export-docx="handleExportDocx"
        @export-images="handleExportImages"
        @export-multi-page-tiff="handleExportMultiPageTiff"
        @convert-to-pdf="handleConvertToPdf"
        @undo="handleUndo"
        @redo="handleRedo"
        @insert-image-from-file="handleInsertImageFromFile"
        @paste-image-from-clipboard="handlePasteImageFromClipboard"
        @delete-pages="handleDeletePages"
        @extract-pages="handleExtractPages"
        @rotate-cw="handleRotateCw"
        @rotate-ccw="handleRotateCcw"
        @insert-pages="handleInsertPages"
        @toggle-sidebar="handleToggleSidebar"
        @fit-width="handleFitWidth"
        @fit-height="handleFitHeight"
        @toggle-continuous-scroll="handleToggleContinuousScroll"
        @enable-drag="handleEnableDrag"
        @disable-drag="handleDisableDrag"
        @capture-region="handleCaptureRegion"
        @crop="handleCrop"
        @quick-note="handleQuickNote"
        @toggle-fullscreen="handleToggleFullscreen"
        @set-view-mode="handleSetViewMode"
        @go-to-page="handleGoToPage"
        @ocr-complete="handleOcrComplete"
    />
</template>

<script setup lang="ts">
import type { TPdfViewMode } from '@contracts/shared';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import WorkspacePdfToolbarView from '@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { DESKTOP_EDITOR_READER_COMMAND_SURFACE } from '@app/utils/readerCommandSurface';

const {
    hasPdf,
    snapshot,
} = defineProps<{
    snapshot: IWorkspaceToolbarSnapshot;
    hasPdf: boolean;
    ocrPopupOpen: boolean;
    zoomDropdownOpen: boolean;
    pageDropdownOpen: boolean;
    overflowMenuOpen: boolean;
    appMenuOpen: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
}>();

const { isDesktopRuntime } = useRuntimeEnvironment();
const canUseOcr = computed(() => isDesktopRuntime.value);
const toolbarSurface = DESKTOP_EDITOR_READER_COMMAND_SURFACE;
const shellDocumentBusy = computed(() => snapshot.isOpeningDocument);
const shellControlsDisabled = computed(() => !hasPdf || shellDocumentBusy.value || snapshot.totalPages <= 0);

const emit = defineEmits<{
    'update:ocrPopupOpen': [open: boolean];
    'update:zoomDropdownOpen': [open: boolean];
    'update:pageDropdownOpen': [open: boolean];
    'update:overflowMenuOpen': [open: boolean];
    'update:appMenuOpen': [open: boolean];
    'update:zoom': [zoom: number];
    'update:effectiveZoom': [zoom: number];
    'update:zoomMode': [mode: IWorkspaceToolbarSnapshot['zoomMode']];
    'update:fitMode': [mode: IWorkspaceToolbarSnapshot['fitMode']];
    'update:viewMode': [mode: IWorkspaceToolbarSnapshot['viewMode']];
    'update:currentPage': [page: number];
    'open-file': [];
    'open-settings': [];
    'save': [];
    'repair-save': [];
    'optimize-pdf-for-interaction': [];
    'save-as': [];
    'print': [];
    'print-current-page': [];
    'combine-files': [];
    'export-docx': [];
    'export-images': [];
    'export-multi-page-tiff': [];
    'convert-to-pdf': [];
    'undo': [];
    'redo': [];
    'insert-image-from-file': [];
    'paste-image-from-clipboard': [];
    'delete-pages': [];
    'extract-pages': [];
    'rotate-cw': [];
    'rotate-ccw': [];
    'insert-pages': [];
    'toggle-sidebar': [];
    'fit-width': [];
    'fit-height': [];
    'toggle-continuous-scroll': [];
    'enable-drag': [];
    'disable-drag': [];
    'capture-region': [];
    'crop': [];
    'quick-note': [];
    'toggle-fullscreen': [];
    'set-view-mode': [mode: TPdfViewMode];
    'go-to-page': [page: number];
    'ocr-complete': [payload: unknown];
}>();

function handleOcrPopupOpenUpdate(open: boolean) {
    emit('update:ocrPopupOpen', open);
}

function handleZoomDropdownOpenUpdate(open: boolean) {
    emit('update:zoomDropdownOpen', open);
}

function handlePageDropdownOpenUpdate(open: boolean) {
    emit('update:pageDropdownOpen', open);
}

function handleOverflowMenuOpenUpdate(open: boolean) {
    emit('update:overflowMenuOpen', open);
}

function handleAppMenuOpenUpdate(open: boolean) {
    emit('update:appMenuOpen', open);
}

function handleZoomUpdate(zoom: number) {
    emit('update:zoom', zoom);
}

function handleEffectiveZoomUpdate(zoom: number) {
    emit('update:effectiveZoom', zoom);
}

function handleZoomModeUpdate(mode: IWorkspaceToolbarSnapshot['zoomMode']) {
    emit('update:zoomMode', mode);
}

function handleFitModeUpdate(mode: IWorkspaceToolbarSnapshot['fitMode']) {
    emit('update:fitMode', mode);
}

function handleViewModeUpdate(mode: IWorkspaceToolbarSnapshot['viewMode']) {
    emit('update:viewMode', mode);
}

function handleCurrentPageUpdate(page: number) {
    emit('update:currentPage', page);
}

function handleOpenFile() {
    emit('open-file');
}

function handleOpenSettings() {
    emit('open-settings');
}

function handleSave() {
    emit('save');
}

function handleRepairSave() {
    emit('repair-save');
}

function handleOptimizePdfForInteraction() {
    emit('optimize-pdf-for-interaction');
}

function handleSaveAs() {
    emit('save-as');
}

function handlePrint() {
    emit('print');
}

function handlePrintCurrentPage() {
    emit('print-current-page');
}

function handleCombineImages() {
    emit('combine-files');
}

function handleExportDocx() {
    emit('export-docx');
}

function handleExportImages() {
    emit('export-images');
}

function handleExportMultiPageTiff() {
    emit('export-multi-page-tiff');
}

function handleConvertToPdf() {
    emit('convert-to-pdf');
}

function handleUndo() {
    emit('undo');
}

function handleRedo() {
    emit('redo');
}

function handleInsertImageFromFile() {
    emit('insert-image-from-file');
}

function handlePasteImageFromClipboard() {
    emit('paste-image-from-clipboard');
}

function handleDeletePages() {
    emit('delete-pages');
}

function handleExtractPages() {
    emit('extract-pages');
}

function handleRotateCw() {
    emit('rotate-cw');
}

function handleRotateCcw() {
    emit('rotate-ccw');
}

function handleInsertPages() {
    emit('insert-pages');
}

function handleToggleSidebar() {
    emit('toggle-sidebar');
}

function handleFitWidth() {
    emit('fit-width');
}

function handleFitHeight() {
    emit('fit-height');
}

function handleToggleContinuousScroll() {
    emit('toggle-continuous-scroll');
}

function handleEnableDrag() {
    emit('enable-drag');
}

function handleDisableDrag() {
    emit('disable-drag');
}

function handleCaptureRegion() {
    emit('capture-region');
}

function handleCrop() {
    emit('crop');
}

function handleQuickNote() {
    emit('quick-note');
}

function handleToggleFullscreen() {
    emit('toggle-fullscreen');
}

function handleSetViewMode(mode: TPdfViewMode) {
    emit('set-view-mode', mode);
}

function handleGoToPage(page: number) {
    emit('go-to-page', page);
}

function handleOcrComplete(payload: unknown) {
    emit('ocr-complete', payload);
}
</script>
