<template>
    <PdfToolbar
        :has-pdf="toolbarHasPdf"
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
        :is-preparing-current-page-print="snapshot.isPreparingCurrentPagePrint"
        :is-fit-width-active="snapshot.isFitWidthActive"
        :is-fit-height-active="snapshot.isFitHeightActive"
        :show-sidebar="snapshot.showSidebar"
        :can-toggle-sidebar="toolbarCanToggleSidebar"
        :drag-mode="snapshot.dragMode"
        :continuous-scroll="snapshot.continuousScroll"
        :is-djvu-mode="snapshot.isDjvuMode"
        :is-capturing-region="snapshot.isCapturingRegion"
        :is-crop-selecting="snapshot.isCropSelecting"
        :is-placing-page-note="snapshot.isPlacingPageNote"
        :document-busy="toolbarDocumentBusy"
        :has-ocr-action="canUseOcr"
        :surface="surface"
        :is-fullscreen="isFullscreen"
        :fullscreen-supported="fullscreenSupported"
        @open-file="handleOpenFile"
        @open-settings="handleOpenSettings"
        @save="handleSave"
        @save-as="handleSaveAs"
        @print="handlePrint"
        @print-current-page="handlePrintCurrentPage"
        @export-docx="handleExportDocx"
        @undo="handleUndo"
        @redo="handleRedo"
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
    >
        <template #app-menu>
            <ToolbarAppMenu
                :open="appMenuOpen"
                :has-pdf="toolbarHasPdf"
                :can-save="snapshot.canSave"
                :can-repair-save="snapshot.canRepairSave"
                :can-undo="snapshot.canUndo"
                :can-redo="snapshot.canRedo"
                :can-export-docx="snapshot.canExportDocx"
                :is-any-saving="snapshot.isAnySaving"
                :is-history-busy="snapshot.isHistoryBusy"
                :is-exporting-docx="snapshot.isExportingDocx"
                :is-preparing-print="snapshot.isPreparingPrint"
                :is-preparing-current-page-print="snapshot.isPreparingCurrentPagePrint"
                :is-djvu-mode="snapshot.isDjvuMode"
                :can-use-djvu="canUseDjvu"
                :document-busy="toolbarDocumentBusy"
                @update:open="handleAppMenuOpenUpdate"
                @open-file="handleOpenFile"
                @save="handleSave"
                @repair-save="handleRepairSave"
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
                ref="ocrPopupRef"
                :pdf-document="ocrPdfDocument"
                :current-page="snapshot.currentPage"
                :total-pages="snapshot.totalPages"
                :working-copy-path="ocrWorkingCopyPath"
                :open="ocrPopupOpen"
                :is-exporting-docx="ocrIsExportingDocx"
                :external-error="ocrExternalError"
                :disabled="snapshot.isDjvuMode || toolbarControlsDisabled"
                :hide-trigger="isCollapsed(3)"
                @update:open="handleOcrPopupOpenUpdate"
                @update:running="handleOcrRunningUpdate"
                @export-docx="handleOcrExportDocx"
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
                @update:effective-zoom="handleEffectiveZoomUpdate"
                @update:open="handleZoomDropdownOpenUpdate"
            />
        </template>
        <template #page-dropdown="{ compactLevel }">
            <PdfPageDropdown
                v-model="currentPage"
                :open="pageDropdownOpen"
                :total-pages="pageDropdownTotalPages"
                :view-mode="snapshot.viewMode"
                :page-labels="pageLabels"
                :disabled="toolbarControlsDisabled"
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
                :can-toggle-sidebar="toolbarCanToggleSidebar"
                :can-capture-region="canCaptureRegion"
                :can-crop="canCrop"
                :can-quick-note="canQuickNote"
                :has-pdf="toolbarHasPdf"
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
                :document-busy="toolbarDocumentBusy"
                :surface="surface"
                :show-document-section="isDesktopRuntime"
                can-combine-files
                can-print-current-page
                :can-convert-to-pdf="canUseDjvu && snapshot.isDjvuMode"
                :is-preparing-print="snapshot.isPreparingPrint"
                :is-preparing-current-page-print="snapshot.isPreparingCurrentPagePrint"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                trigger-icon="i-ph-dots-three"
                @update:open="handleOverflowMenuOpenUpdate"
                @capture-region="handleCaptureRegion"
                @crop="handleCrop"
                @open-ocr="handleOpenOcr"
                @toggle-sidebar="handleToggleSidebar"
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
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import { PdfPageDropdown } from '@app/modules/pdf-viewer/public/component-exports/pdfPageDropdown';
import { PdfToolbar } from '@app/modules/pdf-viewer/public/component-exports/pdfToolbar';
import { PdfZoomDropdown } from '@app/modules/pdf-viewer/public/component-exports/pdfZoomDropdown';
import ToolbarAppMenu from '@app/components/toolbar/ToolbarAppMenu.vue';
import ToolbarOverflowMenu from '@app/components/toolbar/ToolbarOverflowMenu.vue';
import { useWorkspaceToolbarPageModel } from '@app/modules/workspace-shell/composables/useWorkspaceToolbarPageModel';
import type {
    IAgentOcrRunOptions,
    IOcrPopupAgentExpose,
} from '@app/types/ocrAgent';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { IReaderCommandSurface } from '@app/utils/readerCommandSurface';

const OcrPopup = defineAsyncComponent(
    () => import('@app/modules/ocr-panel/public')
        .then(componentModule => componentModule.OcrPopup),
);

const {
    appMenuOpen,
    canCaptureRegion = true,
    canCrop = true,
    canQuickNote = true,
    canToggleSidebar = undefined,
    canUseDjvu = true,
    canUseOcr,
    controlsDisabled = undefined,
    documentBusy = undefined,
    fullscreenSupported,
    hasPdf = undefined,
    isDesktopRuntime,
    isFullscreen,
    ocrExternalError = null,
    ocrIsExportingDocx: ocrIsExportingDocxProp = undefined,
    ocrPdfDocument = null,
    ocrPopupOpen,
    ocrWorkingCopyPath = null,
    overflowMenuOpen,
    pageDropdownOpen,
    pageDropdownTotalPages: pageDropdownTotalPagesProp = undefined,
    pageLabels = null,
    snapshot,
    surface,
    zoomDropdownOpen,
} = defineProps<{
    snapshot: IWorkspaceToolbarSnapshot;
    hasPdf?: boolean | undefined;
    canToggleSidebar?: boolean | undefined;
    canCaptureRegion?: boolean | undefined;
    canCrop?: boolean | undefined;
    canQuickNote?: boolean | undefined;
    canUseOcr: boolean;
    canUseDjvu?: boolean | undefined;
    isDesktopRuntime: boolean;
    surface: IReaderCommandSurface;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    documentBusy?: boolean | undefined;
    controlsDisabled?: boolean | undefined;
    pageDropdownTotalPages?: number | undefined;
    pageLabels?: string[] | null | undefined;
    ocrPdfDocument?: PDFDocumentProxy | null | undefined;
    ocrWorkingCopyPath?: TDocumentRef | null | undefined;
    ocrExternalError?: string | null | undefined;
    ocrIsExportingDocx?: boolean | undefined;
    ocrPopupOpen: boolean;
    zoomDropdownOpen: boolean;
    pageDropdownOpen: boolean;
    overflowMenuOpen: boolean;
    appMenuOpen: boolean;
}>();

const emit = defineEmits<{
    'update:ocrPopupOpen': [open: boolean];
    'update:zoomDropdownOpen': [open: boolean];
    'update:pageDropdownOpen': [open: boolean];
    'update:overflowMenuOpen': [open: boolean];
    'update:appMenuOpen': [open: boolean];
    'update:zoom': [zoom: number];
    'update:effectiveZoom': [zoom: number];
    'update:zoomMode': [mode: TZoomMode];
    'update:fitMode': [mode: TFitMode];
    'update:viewMode': [mode: TPdfViewMode];
    'update:currentPage': [page: number];
    'update:ocrRunning': [running: boolean];
    'open-file': [];
    'open-settings': [];
    'save': [];
    'repair-save': [];
    'save-as': [];
    'print': [];
    'print-current-page': [];
    'combine-images': [];
    'export-docx': [];
    'ocr-export-docx': [selectedLanguages: string[]];
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

const ocrPopupRef = ref<IOcrPopupAgentExpose | null>(null);
const toolbarHasPdf = computed(() => hasPdf ?? snapshot.hasPdf);
const toolbarDocumentBusy = computed(() => documentBusy ?? snapshot.isOpeningDocument);
const toolbarCanToggleSidebar = computed(() => canToggleSidebar ?? true);
const toolbarControlsDisabled = computed(() => (
    controlsDisabled
    ?? (!toolbarHasPdf.value || toolbarDocumentBusy.value || snapshot.totalPages <= 0)
));
const pageDropdownTotalPages = computed(() => pageDropdownTotalPagesProp ?? snapshot.totalPages);
const ocrIsExportingDocx = computed(() => ocrIsExportingDocxProp ?? snapshot.isExportingDocx);

const zoom = computed({
    get: () => snapshot.zoom,
    set: value => emit('update:zoom', value),
});
const effectiveZoom = computed({
    get: () => snapshot.effectiveZoom,
    set: value => emit('update:effectiveZoom', value),
});
const zoomMode = computed({
    get: () => snapshot.zoomMode,
    set: value => emit('update:zoomMode', value),
});
const fitMode = computed({
    get: () => snapshot.fitMode,
    set: value => emit('update:fitMode', value),
});
const viewMode = computed({
    get: () => snapshot.viewMode,
    set: value => emit('update:viewMode', value),
});
const {
    currentPage,
    handleGoToPage: handleToolbarGoToPage,
} = useWorkspaceToolbarPageModel({
    sourcePage: () => snapshot.currentPage,
    goToPage: page => emit('go-to-page', page),
});

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

function handleOcrRunningUpdate(running: boolean) {
    emit('update:ocrRunning', running);
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

function handleOcrExportDocx(selectedLanguages: string[]) {
    emit('ocr-export-docx', selectedLanguages);
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
    handleToolbarGoToPage(page);
}

function handleOpenOcr() {
    emit('update:ocrPopupOpen', true);
}

function handleOcrComplete(payload: unknown) {
    emit('ocr-complete', payload);
}

function runOcrForAgent(options?: IAgentOcrRunOptions) {
    return ocrPopupRef.value?.runOcrForAgent(options) ?? Promise.resolve({
        ok: false,
        error: 'OCR popup is not mounted.',
    });
}

function cancelOcrForAgent() {
    return ocrPopupRef.value?.cancelOcrForAgent() ?? {
        ok: false,
        error: 'OCR popup is not mounted.',
    };
}

function getAgentOcrSnapshot() {
    return ocrPopupRef.value?.getAgentOcrSnapshot() ?? {
        ok: false,
        error: 'OCR popup is not mounted.',
    };
}

defineExpose<IOcrPopupAgentExpose>({
    runOcrForAgent,
    cancelOcrForAgent,
    getAgentOcrSnapshot,
});
</script>
