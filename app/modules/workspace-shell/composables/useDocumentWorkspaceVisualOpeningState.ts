import type {
    ComputedRef,
    Ref,
} from 'vue';
import { resolveVisiblePageLabelsDuringMetadataRefresh } from '@app/modules/pdf-viewer/public';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IDocumentWorkspaceVisualOpeningStateOptions {
    toolbarHasPdf: TReadableRef<boolean>;
    isLoading: TReadableRef<boolean>;
    initialDocumentVisualReady: TReadableRef<boolean>;
    pdfError: TReadableRef<string | null>;
    djvuError: TReadableRef<string | null>;
    isOpeningDocumentForToolbar: TReadableRef<boolean>;
    toolbarDocumentBusy: TReadableRef<boolean>;
    canRepairSave: TReadableRef<boolean>;
    canOptimizePdf: TReadableRef<boolean>;
    statusZoomLabel: TReadableRef<string>;
    totalPages: TReadableRef<number>;
    pageLabels: TReadableRef<string[] | null>;
    pageLabelsResolved: TReadableRef<boolean>;
    isAnySaving: TReadableRef<boolean>;
    t: (key: 'status.zoomUnknown') => string;
}

export const useDocumentWorkspaceVisualOpeningState = (options: IDocumentWorkspaceVisualOpeningStateOptions) => {
    const documentInitialVisualPending = computed(() => (
        options.toolbarHasPdf.value
        && options.isLoading.value
        && !options.initialDocumentVisualReady.value
        && !options.pdfError.value
        && !options.djvuError.value
    ));
    const isOpeningDocumentForToolbarDisplay = computed(() => (
        options.isOpeningDocumentForToolbar.value || documentInitialVisualPending.value
    ));
    const toolbarDocumentBusyForDisplay = computed(() => (
        options.toolbarDocumentBusy.value || documentInitialVisualPending.value
    ));
    const canRepairSaveForDisplay = computed(() => (
        options.canRepairSave.value && !documentInitialVisualPending.value
    ));
    const canOptimizePdfForDisplay = computed(() => (
        options.canOptimizePdf.value && !documentInitialVisualPending.value
    ));
    const statusZoomLabelForDisplay = computed(() => (
        documentInitialVisualPending.value ? options.t('status.zoomUnknown') : options.statusZoomLabel.value
    ));
    const documentMetadataReady = computed(() => (
        options.toolbarHasPdf.value
        && options.totalPages.value > 0
        && !isOpeningDocumentForToolbarDisplay.value
    ));
    const toolbarPageLabels = computed(() => {
        if (!documentMetadataReady.value) {
            return null;
        }
        return resolveVisiblePageLabelsDuringMetadataRefresh({
            pageLabels: options.pageLabels.value,
            pageLabelsResolved: options.pageLabelsResolved.value,
            isSaving: options.isAnySaving.value,
            totalPages: options.totalPages.value,
        });
    });
    const toolbarControlsDisabled = computed(() => (
        !documentMetadataReady.value || toolbarDocumentBusyForDisplay.value
    ));

    return {
        canOptimizePdfForDisplay,
        canRepairSaveForDisplay,
        documentInitialVisualPending,
        documentMetadataReady,
        isOpeningDocumentForToolbarDisplay,
        statusZoomLabelForDisplay,
        toolbarControlsDisabled,
        toolbarDocumentBusyForDisplay,
        toolbarPageLabels,
    };
};
