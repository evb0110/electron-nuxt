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
    viewMode: ComputedRef<TPdfViewMode>;
    numPages: Ref<number>;
    pageMetricsVersion: Ref<number>;
    visibleRange: Ref<IPageRange>;
    captureViewerScrollSnapshot: () => IScrollSnapshot | null;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    isFitWidthScaleCurrent: (container: HTMLElement | null) => boolean;
    syncHorizontalScrollForZoomMode: () => void;
    cancelInFlightRenders: () => void;
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

export function usePdfViewerFitWidthController(options: IUsePdfViewerFitWidthControllerOptions) {
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

        options.cancelInFlightRenders();
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

    function isZoomAtFitWidthBaseline() {
        return Math.abs(options.zoom.value - 1) < 0.001;
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

        const isCurrentPageFitWidth = isZoomAtFitWidthBaseline()
            && options.isFitWidthScaleCurrent(options.viewerContainer.value);

        if (isCurrentPageFitWidth && options.zoomMode.value === 'custom') {
            options.emitZoomMode('fit-width');
            return;
        }

        if (!isCurrentPageFitWidth && options.zoomMode.value === 'fit-width') {
            options.emitZoomMode('custom');
        }
    }

    watch(
        () => [
            options.fitMode.value,
            options.continuousScroll.value,
            options.zoom.value,
            options.effectiveScale.value,
            options.viewMode.value,
            options.numPages.value,
            options.pageMetricsVersion.value,
        ] as const,
        () => {
            syncFitWidthZoomModeForCurrentPage();
            options.syncHorizontalScrollForZoomMode();
        },
    );

    return { applyFitWidthToCurrentPage };
}
