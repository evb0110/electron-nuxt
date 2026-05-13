<template>
    <PdfToolbar
        :has-pdf="hasPdf"
        :can-save="snapshot.canSave"
        :can-undo="snapshot.canUndo"
        :can-redo="snapshot.canRedo"
        :can-export-docx="snapshot.canExportDocx"
        :is-saving="snapshot.isSaving"
        :is-saving-as="snapshot.isSavingAs"
        :is-any-saving="snapshot.isAnySaving"
        :is-history-busy="snapshot.isHistoryBusy"
        :is-exporting-docx="snapshot.isExportingDocx"
        :is-opening-document="snapshot.isOpeningDocument"
        :is-preparing-print="snapshot.isPreparingPrint"
        :is-fit-width-active="snapshot.isFitWidthActive"
        :is-fit-height-active="snapshot.isFitHeightActive"
        :show-sidebar="snapshot.showSidebar"
        :drag-mode="snapshot.dragMode"
        :continuous-scroll="snapshot.continuousScroll"
        :is-djvu-mode="snapshot.isDjvuMode"
        :is-capturing-region="snapshot.isCapturingRegion"
        :is-crop-selecting="snapshot.isCropSelecting"
        :is-placing-page-note="snapshot.isPlacingPageNote"
        :has-ocr-action="canUseOcr"
        :surface="toolbarSurface"
        :is-fullscreen="isFullscreen"
        :fullscreen-supported="fullscreenSupported"
        @open-file="handleOpenFile"
        @open-settings="handleOpenSettings"
        @save="handleSave"
        @save-as="handleSaveAs"
        @print="handlePrint"
        @export-docx="handleExportDocx"
        @undo="handleUndo"
        @redo="handleRedo"
        @toggle-sidebar="handleToggleSidebar"
        @actual-size="handleActualSize"
        @fit-width="handleFitWidth"
        @fit-height="handleFitHeight"
        @toggle-continuous-scroll="handleToggleContinuousScroll"
        @enable-drag="handleEnableDrag"
        @disable-drag="handleDisableDrag"
        @capture-region="handleCaptureRegion"
        @crop="handleCrop"
        @quick-note="handleQuickNote"
        @toggle-fullscreen="handleToggleFullscreen"
    >
        <template #app-menu>
            <ToolbarAppMenu
                :open="appMenuOpen"
                :has-pdf="hasPdf"
                :can-save="snapshot.canSave"
                :can-undo="snapshot.canUndo"
                :can-redo="snapshot.canRedo"
                :can-export-docx="snapshot.canExportDocx"
                :is-any-saving="snapshot.isAnySaving"
                :is-history-busy="snapshot.isHistoryBusy"
                :is-exporting-docx="snapshot.isExportingDocx"
                :is-preparing-print="snapshot.isPreparingPrint"
                :is-djvu-mode="snapshot.isDjvuMode"
                :can-use-djvu="canUseDjvu"
                @update:open="handleAppMenuOpenUpdate"
                @open-file="handleOpenFile"
                @save="handleSave"
                @save-as="handleSaveAs"
                @print="handlePrint"
                @print-current-page="handlePrintCurrentPage"
                @combine-images="handleCombineImages"
                @export-docx="handleExportDocx"
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
            />
        </template>
        <template v-if="canUseOcr" #ocr="{ isCollapsed }">
            <OcrPopup
                :pdf-document="null"
                :pdf-data="null"
                :current-page="currentPage"
                :total-pages="snapshot.totalPages"
                :working-copy-path="null"
                :open="ocrPopupOpen"
                :disabled="snapshot.isDjvuMode || !hasPdf"
                :hide-trigger="isCollapsed(3)"
                @update:open="handleOcrPopupOpenUpdate"
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
                :disabled="!hasPdf"
                :compact-level="compactLevel"
                @update:effective-zoom="handleEffectiveZoomUpdate"
                @update:open="handleZoomDropdownOpenUpdate"
            />
        </template>
        <template #page-dropdown="{ compactLevel }">
            <PdfPageDropdown
                v-model="currentPage"
                :open="pageDropdownOpen"
                :total-pages="snapshot.totalPages"
                :view-mode="snapshot.viewMode"
                :page-labels="null"
                :disabled="!hasPdf"
                :compact-level="compactLevel"
                @go-to-page="handleGoToPage"
                @update:open="handlePageDropdownOpenUpdate"
            />
        </template>
        <template #overflow-menu="{ collapseTier, hasOverflowItems }">
            <ToolbarOverflowMenu
                v-if="hasOverflowItems"
                :open="overflowMenuOpen"
                :collapse-tier="collapseTier"
                can-toggle-sidebar
                can-capture-region
                can-crop
                can-quick-note
                :has-pdf="hasPdf"
                :can-use-ocr="canUseOcr"
                :show-sidebar="snapshot.showSidebar"
                :drag-mode="snapshot.dragMode"
                :continuous-scroll="snapshot.continuousScroll"
                :view-mode="snapshot.viewMode"
                :is-djvu-mode="snapshot.isDjvuMode"
                :is-fit-width-active="snapshot.isFitWidthActive"
                :is-fit-height-active="snapshot.isFitHeightActive"
                :is-capturing-region="snapshot.isCapturingRegion"
                :is-crop-selecting="snapshot.isCropSelecting"
                :is-placing-page-note="snapshot.isPlacingPageNote"
                :surface="toolbarSurface"
                :show-document-section="isDesktopRuntime"
                can-combine-files
                can-print-current-page
                :can-convert-to-pdf="canUseDjvu && snapshot.isDjvuMode"
                :is-preparing-print="snapshot.isPreparingPrint"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                trigger-icon="i-ph-dots-three"
                @update:open="handleOverflowMenuOpenUpdate"
                @capture-region="handleCaptureRegion"
                @crop="handleCrop"
                @toggle-sidebar="handleToggleSidebar"
                @actual-size="handleActualSize"
                @fit-width="handleFitWidth"
                @fit-height="handleFitHeight"
                @enable-drag="handleEnableDrag"
                @disable-drag="handleDisableDrag"
                @set-view-mode="handleSetViewMode"
                @toggle-continuous-scroll="handleToggleContinuousScroll"
                @quick-note="handleQuickNote"
                @open-settings="handleOpenSettings"
                @combine-images="handleCombineImages"
                @print-current-page="handlePrintCurrentPage"
                @convert-to-pdf="handleConvertToPdf"
                @toggle-fullscreen="handleToggleFullscreen"
            />
        </template>
    </PdfToolbar>
</template>

<script setup lang="ts">
import type { TPdfViewMode } from '@contracts/shared';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspace-expose';
import PdfPageDropdown from '@app/components/pdf/PdfPageDropdown.vue';
import PdfToolbar from '@app/components/pdf/PdfToolbar.vue';
import PdfZoomDropdown from '@app/components/pdf/PdfZoomDropdown.vue';
import ToolbarAppMenu from '@app/components/toolbar/ToolbarAppMenu.vue';
import ToolbarOverflowMenu from '@app/components/toolbar/ToolbarOverflowMenu.vue';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { DESKTOP_EDITOR_READER_COMMAND_SURFACE } from '@app/utils/reader-command-surface';

const OcrPopup = defineAsyncComponent(() => import('@app/components/ocr/OcrPopup.vue'));

const props = defineProps<{
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
const canUseDjvu = true;
const toolbarSurface = DESKTOP_EDITOR_READER_COMMAND_SURFACE;

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
    'save-as': [];
    'print': [];
    'print-current-page': [];
    'combine-images': [];
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
    'actual-size': [];
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
    'go-to-page': [];
    'ocr-complete': [];
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

function handleEffectiveZoomUpdate(zoom: number) {
    emit('update:effectiveZoom', zoom);
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
    emit('combine-images');
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

function handleActualSize() {
    emit('actual-size');
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

function handleGoToPage() {
    emit('go-to-page');
}

function handleOcrComplete() {
    emit('ocr-complete');
}

const zoom = computed({
    get: () => props.snapshot.zoom,
    set: value => emit('update:zoom', value),
});
const effectiveZoom = computed({
    get: () => props.snapshot.effectiveZoom,
    set: value => emit('update:effectiveZoom', value),
});
const zoomMode = computed({
    get: () => props.snapshot.zoomMode,
    set: value => emit('update:zoomMode', value),
});
const fitMode = computed({
    get: () => props.snapshot.fitMode,
    set: value => emit('update:fitMode', value),
});
const viewMode = computed({
    get: () => props.snapshot.viewMode,
    set: value => emit('update:viewMode', value),
});
const currentPage = computed({
    get: () => props.snapshot.currentPage,
    set: value => emit('update:currentPage', value),
});
</script>
