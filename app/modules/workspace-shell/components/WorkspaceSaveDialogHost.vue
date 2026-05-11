<template>
    <PdfExportScopeDialog
        :open="exportScopeDialogOpen"
        :mode="exportScopeDialogMode"
        :total-pages="totalPages"
        :current-page="currentPage"
        :selected-pages="exportScopeDialogSelectedPages"
        @submit="emit('export-submit', $event)"
        @update:open="emit('export-open-change', $event)"
    />

    <PdfPrintDialog
        :open="printDialogOpen"
        :total-pages="totalPages"
        :current-page="currentPage"
        :selected-pages="printDialogSelectedPages"
        :default-view-mode="viewMode"
        :is-preparing="isPreparingPrint"
        :status="printStatus"
        :error="printError"
        @submit="emit('print-submit', $event)"
        @update:open="emit('print-open-change', $event)"
    />

    <PdfCropDialog
        :open="cropDialogOpen"
        :loading="cropDialogLoading"
        :total-pages="totalPages"
        :current-page="cropDialogPageNumber"
        :selected-pages="selectedThumbnailPages"
        :initial-margins="cropDialogMargins"
        :media-box="cropDialogMediaBox"
        :current-visible-box="cropDialogCurrentBox"
        :rotation="cropDialogRotation"
        @apply="emit('crop-apply', $event)"
        @remove="emit('crop-remove', $event)"
        @update:open="emit('crop-open-change', $event)"
    />

    <DjvuConvertDialog
        v-if="canUseDjvu && isDjvuMode"
        :open="showConvertDialog"
        :djvu-path="djvuPath"
        @convert="(subsample, preserveBookmarks) => emit('djvu-convert', subsample, preserveBookmarks)"
        @update:open="emit('convert-open-change', $event)"
    />
</template>

<script setup lang="ts">
import PdfCropDialog from '@app/components/pdf/PdfCropDialog.vue';
import PdfExportScopeDialog from '@app/components/pdf/PdfExportScopeDialog.vue';
import PdfPrintDialog from '@app/components/pdf/PdfPrintDialog.vue';

const DjvuConvertDialog = defineAsyncComponent(() => import('@app/components/djvu/DjvuConvertDialog.vue'));

type TPdfExportScopeDialogProps = InstanceType<typeof PdfExportScopeDialog>['$props'];
type TPdfPrintDialogProps = InstanceType<typeof PdfPrintDialog>['$props'];
type TPdfCropDialogProps = InstanceType<typeof PdfCropDialog>['$props'];
type TDjvuConvertDialogProps = InstanceType<typeof DjvuConvertDialog>['$props'];
type TRequiredHandler<T> = NonNullable<T> extends (...args: infer TArgs) => unknown ? TArgs : never;

defineProps<{
    exportScopeDialogOpen: boolean;
    exportScopeDialogMode: TPdfExportScopeDialogProps['mode'];
    exportScopeDialogSelectedPages: number[];
    printDialogOpen: boolean;
    printDialogSelectedPages: number[];
    printStatus: TPdfPrintDialogProps['status'];
    printError: TPdfPrintDialogProps['error'];
    isPreparingPrint: boolean;
    cropDialogOpen: boolean;
    cropDialogLoading: boolean;
    cropDialogPageNumber: number;
    cropDialogMargins: TPdfCropDialogProps['initialMargins'];
    cropDialogMediaBox: TPdfCropDialogProps['mediaBox'];
    cropDialogCurrentBox: TPdfCropDialogProps['currentVisibleBox'];
    cropDialogRotation: TPdfCropDialogProps['rotation'];
    selectedThumbnailPages: number[];
    totalPages: number;
    currentPage: number;
    viewMode: TPdfPrintDialogProps['defaultViewMode'];
    canUseDjvu: boolean;
    isDjvuMode: boolean;
    showConvertDialog: boolean;
    djvuPath: TDjvuConvertDialogProps['djvuPath'];
}>();

const emit = defineEmits<{
    'export-submit': [payload: TRequiredHandler<TPdfExportScopeDialogProps['onSubmit']>[0]];
    'export-open-change': [value: boolean];
    'print-submit': [payload: TRequiredHandler<TPdfPrintDialogProps['onSubmit']>[0]];
    'print-open-change': [value: boolean];
    'crop-apply': [payload: TRequiredHandler<TPdfCropDialogProps['onApply']>[0]];
    'crop-remove': [payload: TRequiredHandler<TPdfCropDialogProps['onRemove']>[0]];
    'crop-open-change': [value: boolean];
    'djvu-convert': TRequiredHandler<TDjvuConvertDialogProps['onConvert']>;
    'convert-open-change': [value: boolean];
}>();
</script>
