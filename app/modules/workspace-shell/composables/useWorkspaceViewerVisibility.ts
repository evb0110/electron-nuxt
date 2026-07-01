import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfSource } from '@app/types/pdf';
import {
    isPathPdfSource,
    shouldUseNativePdfPreview,
} from '@app/modules/pdf-viewer/public';

interface IWorkspaceViewerVisibilityOptions {
    djvuOpeningPath: Ref<TDocumentRef | null>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    hasPdf: ComputedRef<boolean> | Ref<boolean>;
    hasQueuedSplitRestore: ComputedRef<boolean> | Ref<boolean>;
    isAnySaving: ComputedRef<boolean> | Ref<boolean>;
    isDjvuMode: Ref<boolean>;
    isExternallyRestoring: Ref<boolean>;
    isHistoryBusy: ComputedRef<boolean> | Ref<boolean>;
    isOcrRunning: Ref<boolean>;
    isRestoringSplitPayload: Ref<boolean>;
    pendingDocumentOpen: ComputedRef<boolean> | Ref<boolean>;
    pdfSrc: Ref<TPdfSource | null>;
    showSidebar: Ref<boolean>;
    conversionState: Ref<{isConverting: boolean;}>;
}

export const useWorkspaceViewerVisibility = (options: IWorkspaceViewerVisibilityOptions) => {
    const nativePdfSourcePath = computed(() => {
        const source = options.pdfSrc.value;
        if (!shouldUseNativePdfPreview(source) || !isPathPdfSource(source)) {
            return null;
        }
        return source.path;
    });
    const showNativePdfViewer = computed(() => (
        !options.isDjvuMode.value
        && Boolean(nativePdfSourcePath.value)
    ));
    const showStandardPdfViewer = computed(() => (
        Boolean(options.pdfSrc.value)
        && !showNativePdfViewer.value
    ));
    const showNativeDjvuViewer = computed(() => (
        options.isDjvuMode.value
        && Boolean(options.djvuSourcePath.value)
        && !options.pdfSrc.value
    ));
    const showNativePreviewViewer = computed(() => (
        showNativePdfViewer.value
        || showNativeDjvuViewer.value
    ));
    const isDjvuOpening = computed(() => (
        Boolean(options.djvuOpeningPath.value)
        && !showNativeDjvuViewer.value
    ));
    const isDocumentOpenPlaceholderVisible = computed(() => (
        options.pendingDocumentOpen.value
        || isDjvuOpening.value
    ));
    const isOpeningDocumentForToolbar = computed(() => (
        isDocumentOpenPlaceholderVisible.value
        || options.isRestoringSplitPayload.value
        || options.isExternallyRestoring.value
    ));
    const isConversionBusy = computed(() => options.conversionState.value.isConverting);
    const isDocumentBusy = computed(() => isConversionBusy.value || options.isOcrRunning.value);
    const toolbarDocumentBusy = computed(() => isDocumentBusy.value || isOpeningDocumentForToolbar.value);
    const toolbarHasPdf = computed(() => (
        options.hasPdf.value
        || options.pendingDocumentOpen.value
        || showNativePdfViewer.value
        || showNativeDjvuViewer.value
        || isDjvuOpening.value
        || options.hasQueuedSplitRestore.value
        || options.isRestoringSplitPayload.value
        || options.isExternallyRestoring.value
    ));
    const toolbarShowSidebar = computed(() => (
        options.showSidebar.value
        && !showNativePreviewViewer.value
    ));
    const canToggleSidebar = computed(() => (
        toolbarHasPdf.value
        && !showNativePreviewViewer.value
        && !toolbarDocumentBusy.value
    ));
    const canRepairSave = computed(() => (
        options.hasPdf.value
        && !toolbarDocumentBusy.value
        && !options.isAnySaving.value
        && !options.isHistoryBusy.value
        && !options.isDjvuMode.value
        && !showNativePdfViewer.value
    ));

    return {
        nativePdfSourcePath,
        showNativePdfViewer,
        showStandardPdfViewer,
        showNativeDjvuViewer,
        showNativePreviewViewer,
        isDjvuOpening,
        isDocumentOpenPlaceholderVisible,
        isOpeningDocumentForToolbar,
        isConversionBusy,
        isDocumentBusy,
        toolbarDocumentBusy,
        toolbarHasPdf,
        toolbarShowSidebar,
        canToggleSidebar,
        canRepairSave,
        canOptimizePdf: canRepairSave,
    };
};
