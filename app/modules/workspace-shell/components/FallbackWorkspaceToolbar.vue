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
        @open-file="emit('open-file')"
        @open-settings="emit('open-settings')"
        @save="emit('save')"
        @save-as="emit('save-as')"
        @print="emit('print')"
        @export-docx="emit('export-docx')"
        @undo="emit('undo')"
        @redo="emit('redo')"
        @toggle-sidebar="emit('toggle-sidebar')"
        @fit-width="emit('fit-width')"
        @fit-height="emit('fit-height')"
        @toggle-continuous-scroll="emit('toggle-continuous-scroll')"
        @enable-drag="emit('enable-drag')"
        @disable-drag="emit('disable-drag')"
        @capture-region="emit('capture-region')"
        @crop="emit('crop')"
        @quick-note="emit('quick-note')"
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
                @update:open="emit('update:appMenuOpen', $event)"
                @open-file="emit('open-file')"
                @save="emit('save')"
                @save-as="emit('save-as')"
                @print="emit('print')"
                @print-current-page="emit('print-current-page')"
                @combine-images="emit('combine-images')"
                @export-docx="emit('export-docx')"
                @export-images="emit('export-images')"
                @export-multi-page-tiff="emit('export-multi-page-tiff')"
                @convert-to-pdf="emit('convert-to-pdf')"
                @undo="emit('undo')"
                @redo="emit('redo')"
                @insert-image-from-file="emit('insert-image-from-file')"
                @paste-image-from-clipboard="emit('paste-image-from-clipboard')"
                @delete-pages="emit('delete-pages')"
                @extract-pages="emit('extract-pages')"
                @rotate-cw="emit('rotate-cw')"
                @rotate-ccw="emit('rotate-ccw')"
                @insert-pages="emit('insert-pages')"
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
                @update:open="emit('update:ocrPopupOpen', $event)"
                @export-docx="emit('export-docx')"
                @ocr-complete="emit('ocr-complete')"
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
                :disabled="!hasPdf"
                :compact-level="collapseTier >= 1 ? 1 : 0"
                @update:effective-zoom="emit('update:effectiveZoom', $event)"
                @update:open="emit('update:zoomDropdownOpen', $event)"
            />
        </template>
        <template #page-dropdown="{ collapseTier }">
            <PdfPageDropdown
                v-model="currentPage"
                :open="pageDropdownOpen"
                :total-pages="snapshot.totalPages"
                :view-mode="snapshot.viewMode"
                :page-labels="null"
                :disabled="!hasPdf"
                :compact-level="collapseTier >= 3 ? 3 : collapseTier >= 2 ? 2 : collapseTier >= 1 ? 1 : 0"
                @go-to-page="emit('go-to-page')"
                @update:open="emit('update:pageDropdownOpen', $event)"
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
                trigger-icon="i-lucide-ellipsis"
                @update:open="emit('update:overflowMenuOpen', $event)"
                @capture-region="emit('capture-region')"
                @crop="emit('crop')"
                @toggle-sidebar="emit('toggle-sidebar')"
                @fit-width="emit('fit-width')"
                @fit-height="emit('fit-height')"
                @enable-drag="emit('enable-drag')"
                @disable-drag="emit('disable-drag')"
                @set-view-mode="emit('set-view-mode', $event)"
                @toggle-continuous-scroll="emit('toggle-continuous-scroll')"
                @quick-note="emit('quick-note')"
                @open-settings="emit('open-settings')"
                @combine-images="emit('combine-images')"
                @print-current-page="emit('print-current-page')"
                @convert-to-pdf="emit('convert-to-pdf')"
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
    'fit-width': [];
    'fit-height': [];
    'toggle-continuous-scroll': [];
    'enable-drag': [];
    'disable-drag': [];
    'capture-region': [];
    'crop': [];
    'quick-note': [];
    'set-view-mode': [mode: TPdfViewMode];
    'go-to-page': [];
    'ocr-complete': [];
}>();

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
