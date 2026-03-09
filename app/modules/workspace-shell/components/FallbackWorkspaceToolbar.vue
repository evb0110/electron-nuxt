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
        :is-fit-width-active="snapshot.isFitWidthActive"
        :is-fit-height-active="snapshot.isFitHeightActive"
        :show-sidebar="snapshot.showSidebar"
        :drag-mode="snapshot.dragMode"
        :continuous-scroll="snapshot.continuousScroll"
        :is-djvu-mode="snapshot.isDjvuMode"
        :is-capturing-region="snapshot.isCapturingRegion"
        :is-placing-page-note="snapshot.isPlacingPageNote"
        @open-file="emit('open-file')"
        @open-settings="emit('open-settings')"
        @save="emit('save')"
        @save-as="emit('save-as')"
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
        @quick-note="emit('quick-note')"
    >
        <template #ocr="{ isCollapsed }">
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
        <template #zoom-dropdown>
            <PdfZoomDropdown
                v-model:zoom="zoom"
                v-model:zoom-mode="zoomMode"
                v-model:fit-mode="fitMode"
                v-model:view-mode="viewMode"
                :effective-zoom="effectiveZoom"
                :open="zoomDropdownOpen"
                :disabled="!hasPdf"
                :compact-level="0"
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
                :compact-level="collapseTier >= 5 ? 2 : collapseTier >= 4 ? 1 : 0"
                @go-to-page="emit('go-to-page')"
                @update:open="emit('update:pageDropdownOpen', $event)"
            />
        </template>
        <template #overflow-menu="{ collapseTier, hasOverflowItems }">
            <ToolbarOverflowMenu
                v-if="hasOverflowItems"
                :open="overflowMenuOpen"
                :collapse-tier="collapseTier"
                :can-save="snapshot.canSave"
                :can-undo="snapshot.canUndo"
                :can-redo="snapshot.canRedo"
                :has-pdf="hasPdf"
                :is-any-saving="snapshot.isAnySaving"
                :is-history-busy="snapshot.isHistoryBusy"
                :is-exporting-docx="snapshot.isExportingDocx"
                :can-export-docx="snapshot.canExportDocx"
                :drag-mode="snapshot.dragMode"
                :continuous-scroll="snapshot.continuousScroll"
                :view-mode="snapshot.viewMode"
                :is-djvu-mode="snapshot.isDjvuMode"
                :is-fit-width-active="snapshot.isFitWidthActive"
                :is-fit-height-active="snapshot.isFitHeightActive"
                :is-capturing-region="snapshot.isCapturingRegion"
                @update:open="emit('update:overflowMenuOpen', $event)"
                @capture-region="emit('capture-region')"
                @save="emit('save')"
                @save-as="emit('save-as')"
                @export-docx="emit('export-docx')"
                @undo="emit('undo')"
                @redo="emit('redo')"
                @fit-width="emit('fit-width')"
                @fit-height="emit('fit-height')"
                @enable-drag="emit('enable-drag')"
                @disable-drag="emit('disable-drag')"
                @set-view-mode="emit('set-view-mode', $event)"
                @toggle-continuous-scroll="emit('toggle-continuous-scroll')"
                @open-settings="emit('open-settings')"
            />
        </template>
    </PdfToolbar>
</template>

<script setup lang="ts">
import type { TPdfViewMode } from '@contracts/shared';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspace-expose';
import OcrPopup from '@app/components/ocr/OcrPopup.vue';
import PdfPageDropdown from '@app/components/pdf/PdfPageDropdown.vue';
import PdfToolbar from '@app/components/pdf/PdfToolbar.vue';
import PdfZoomDropdown from '@app/components/pdf/PdfZoomDropdown.vue';
import ToolbarOverflowMenu from '@app/components/toolbar/ToolbarOverflowMenu.vue';

const props = defineProps<{
    snapshot: IWorkspaceToolbarSnapshot;
    hasPdf: boolean;
    ocrPopupOpen: boolean;
    zoomDropdownOpen: boolean;
    pageDropdownOpen: boolean;
    overflowMenuOpen: boolean;
}>();

const emit = defineEmits<{
    'update:ocrPopupOpen': [open: boolean];
    'update:zoomDropdownOpen': [open: boolean];
    'update:pageDropdownOpen': [open: boolean];
    'update:overflowMenuOpen': [open: boolean];
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
    'export-docx': [];
    'undo': [];
    'redo': [];
    'toggle-sidebar': [];
    'fit-width': [];
    'fit-height': [];
    'toggle-continuous-scroll': [];
    'enable-drag': [];
    'disable-drag': [];
    'capture-region': [];
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
