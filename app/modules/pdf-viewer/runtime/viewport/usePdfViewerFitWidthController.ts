import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IPageRange,
    IScrollSnapshot,
    PDFDocumentProxy,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdf';


interface IUsePdfViewerFitWidthControllerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    isLoading: Ref<boolean>;
    continuousScroll: ComputedRef<boolean>;
    fitMode: ComputedRef<TFitMode>;
    zoomMode: ComputedRef<TZoomMode>;
    zoom: ComputedRef<number>;
    effectiveScale: ComputedRef<number>;
    fitWidthScale: Ref<number>;
    viewMode: ComputedRef<TPdfViewMode>;
    currentPage: Ref<number>;
    numPages: Ref<number>;
    pageMetricsVersion: Ref<number>;
    visibleRange: Ref<IPageRange>;
    captureViewerScrollSnapshot: () => IScrollSnapshot | null;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    isFitWidthScaleCurrent: (container: HTMLElement | null) => boolean;
    syncHorizontalScrollForZoomMode: () => void;
    cancelInFlightRenders: () => Promise<void> | void;
    reRenderAllVisiblePages: (
        getRange: () => IPageRange,
        options: {
            preserveExistingPages?: boolean;
            anchorSnapshot?: IScrollSnapshot | null;
            disableHorizontalAnchorRestore?: boolean;
            rerenderSource?: string;
            renderBufferOverride?: number;
        },
    ) => Promise<void>;
    emitZoomMode: (mode: TZoomMode) => void;
}

export const usePdfViewerFitWidthController = (options: IUsePdfViewerFitWidthControllerOptions) => {
    async function applyFitWidthToCurrentPage() {
        if (!options.pdfDocument.value || options.isLoading.value) {
            return false;
        }

        const anchorSnapshot = options.captureViewerScrollSnapshot();
        const updated = options.computeFitWidthScale(options.viewerContainer.value);
        if (!updated) {
            options.syncHorizontalScrollForZoomMode();
            return false;
        }

        void options.cancelInFlightRenders();
        await options.reRenderAllVisiblePages(
            () => ({ ...options.visibleRange.value }),
            {
                preserveExistingPages: true,
                anchorSnapshot,
                disableHorizontalAnchorRestore: true,
                rerenderSource: 'fit-width-explicit',
                renderBufferOverride: 0,
            },
        );
        options.syncHorizontalScrollForZoomMode();
        return true;
    }

    function isEffectiveScaleAtFitWidthScale() {
        return Math.abs(options.effectiveScale.value - options.fitWidthScale.value) < 0.001;
    }

    function syncFitWidthZoomModeForCurrentPage() {
        if (
            !options.continuousScroll.value
            || options.fitMode.value !== 'width'
            || !options.viewerContainer.value
            || !options.pdfDocument.value
            || options.isLoading.value
        ) {
            return;
        }

        if (options.zoomMode.value !== 'custom') {
            return;
        }

        if (
            isEffectiveScaleAtFitWidthScale()
            && options.isFitWidthScaleCurrent(options.viewerContainer.value)
        ) {
            options.emitZoomMode('fit-width');
        }
    }

    watch(
        () => [
            options.fitMode.value,
            options.continuousScroll.value,
            options.zoom.value,
            options.effectiveScale.value,
            options.viewMode.value,
            options.currentPage.value,
            options.numPages.value,
            options.pageMetricsVersion.value,
        ] as const,
        () => {
            syncFitWidthZoomModeForCurrentPage();
            options.syncHorizontalScrollForZoomMode();
        },
    );

    return { applyFitWidthToCurrentPage };
};
