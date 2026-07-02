import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfSource } from '@app/types/pdf';
import { useWorkspaceActiveViewerAdapter } from '@app/modules/workspace-shell/viewers/useWorkspaceActiveViewerAdapter';

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
    const {
        activeViewerAdapter,
        activeViewerCapabilities,
        nativePdfSourcePath,
    } = useWorkspaceActiveViewerAdapter({
        djvuSourcePath: options.djvuSourcePath,
        isDjvuMode: options.isDjvuMode,
        pdfSrc: options.pdfSrc,
    });
    const showNativePdfViewer = computed(() => activeViewerAdapter.value?.id === 'native-pdf');
    const showStandardPdfViewer = computed(() => activeViewerAdapter.value?.id === 'pdf');
    const showNativeDjvuViewer = computed(() => activeViewerAdapter.value?.id === 'djvu');
    const showNativePreviewViewer = computed(() => !activeViewerCapabilities.value?.sidebar && Boolean(activeViewerAdapter.value));
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
        && activeViewerCapabilities.value?.sidebar === true
    ));
    const canToggleSidebar = computed(() => (
        toolbarHasPdf.value
        && activeViewerCapabilities.value?.sidebar === true
        && !toolbarDocumentBusy.value
    ));
    const canRepairSave = computed(() => (
        options.hasPdf.value
        && !toolbarDocumentBusy.value
        && !options.isAnySaving.value
        && !options.isHistoryBusy.value
        && activeViewerCapabilities.value?.repairSave === true
    ));

    return {
        activeViewerAdapter,
        activeViewerCapabilities,
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
