import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IWorkspaceDocumentDriver } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';

interface IWorkspaceViewerVisibilityOptions {
    activeDocumentDriver: ComputedRef<IWorkspaceDocumentDriver | null>;
    djvuOpeningPath: Ref<TDocumentRef | null>;
    hasPdf: ComputedRef<boolean> | Ref<boolean>;
    hasQueuedSplitRestore: ComputedRef<boolean> | Ref<boolean>;
    isAnySaving: ComputedRef<boolean> | Ref<boolean>;
    isExternallyRestoring: Ref<boolean>;
    isHistoryBusy: ComputedRef<boolean> | Ref<boolean>;
    isOcrRunning: Ref<boolean>;
    isRestoringSplitPayload: Ref<boolean>;
    pendingDocumentOpen: ComputedRef<boolean> | Ref<boolean>;
    showSidebar: Ref<boolean>;
    conversionState: Ref<{isConverting: boolean;}>;
}

export const useWorkspaceViewerVisibility = (options: IWorkspaceViewerVisibilityOptions) => {
    const activeDriverCapabilities = computed(() => options.activeDocumentDriver.value?.capabilities);
    const driverShowsNativePdf = computed(() => options.activeDocumentDriver.value?.view.showNativePdf === true);
    const driverShowsPdfSidebar = computed(() => options.activeDocumentDriver.value?.view.showPdfSidebar === true);
    const driverShowsDjvuSource = computed(() => options.activeDocumentDriver.value?.view.showDjvuSource === true);
    const driverStartupVisualSource = computed(() => (
        options.activeDocumentDriver.value?.view.startupVisualSource ?? null
    ));
    const isDjvuOpening = computed(() => (
        Boolean(options.djvuOpeningPath.value)
        && !driverShowsDjvuSource.value
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
        || driverShowsNativePdf.value
        || driverShowsDjvuSource.value
        || isDjvuOpening.value
        || options.hasQueuedSplitRestore.value
        || options.isRestoringSplitPayload.value
        || options.isExternallyRestoring.value
    ));
    const toolbarShowSidebar = computed(() => (
        options.showSidebar.value
        && activeDriverCapabilities.value?.sidebar === true
    ));
    const canToggleSidebar = computed(() => (
        toolbarHasPdf.value
        && activeDriverCapabilities.value?.sidebar === true
        && !toolbarDocumentBusy.value
    ));
    const canRepairSave = computed(() => (
        options.hasPdf.value
        && !toolbarDocumentBusy.value
        && !options.isAnySaving.value
        && !options.isHistoryBusy.value
        && activeDriverCapabilities.value?.repairSave === true
    ));

    return {
        activeDriverCapabilities,
        driverShowsNativePdf,
        driverShowsPdfSidebar,
        driverShowsDjvuSource,
        driverStartupVisualSource,
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
