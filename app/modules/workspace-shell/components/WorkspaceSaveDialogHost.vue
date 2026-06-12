<template>
    <PdfExportScopeDialog
        :open="exportScopeDialogOpen"
        :mode="exportScopeDialogMode"
        :total-pages="totalPages"
        :current-page="currentPage"
        :selected-pages="exportScopeDialogSelectedPages"
        @submit="handleExportSubmit"
        @update:open="handleExportOpenChange"
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
        @submit="handlePrintSubmit"
        @update:open="handlePrintOpenChange"
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
        @apply="handleCropApply"
        @remove="handleCropRemove"
        @update:open="handleCropOpenChange"
    />

    <DjvuConvertDialog
        v-if="canUseDjvu && isDjvuMode"
        :open="showConvertDialog"
        :djvu-path="djvuPath"
        @convert="handleDjvuConvert"
        @update:open="handleConvertOpenChange"
    />
</template>

<script setup lang="ts">
import { PdfCropDialog } from '@app/modules/pdf-viewer/public/component-exports/pdfCropDialog';
import { PdfExportScopeDialog } from '@app/modules/pdf-viewer/public/component-exports/pdfExportScopeDialog';
import { PdfPrintDialog } from '@app/modules/pdf-viewer/public/component-exports/pdfPrintDialog';

const DjvuConvertDialog = defineAsyncComponent(
    () => import('@app/modules/djvu-viewer/public')
        .then(componentModule => componentModule.DjvuConvertDialog),
);

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

function handleExportSubmit(payload: TRequiredHandler<TPdfExportScopeDialogProps['onSubmit']>[0]) {
    emit('export-submit', payload);
}

function handleExportOpenChange(value: boolean) {
    emit('export-open-change', value);
}

function handlePrintSubmit(payload: TRequiredHandler<TPdfPrintDialogProps['onSubmit']>[0]) {
    emit('print-submit', payload);
}

function handlePrintOpenChange(value: boolean) {
    emit('print-open-change', value);
}

function handleCropApply(payload: TRequiredHandler<TPdfCropDialogProps['onApply']>[0]) {
    emit('crop-apply', payload);
}

function handleCropRemove(payload: TRequiredHandler<TPdfCropDialogProps['onRemove']>[0]) {
    emit('crop-remove', payload);
}

function handleCropOpenChange(value: boolean) {
    emit('crop-open-change', value);
}

function handleDjvuConvert(...args: TRequiredHandler<TDjvuConvertDialogProps['onConvert']>) {
    emit('djvu-convert', ...args);
}

function handleConvertOpenChange(value: boolean) {
    emit('convert-open-change', value);
}
</script>
