import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import { usePdfViewerScrollSnapshot } from '@app/composables/pdf/usePdfViewerScrollSnapshot';
import { usePdfViewerFitWidthController } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewerFitWidthController';
import { usePdfViewerSavePrintController } from '@app/modules/pdf-viewer/runtime/usePdfViewerSavePrintController';
import type {
    IScrollSnapshot,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdf';
import type { IScrollToPageOptions } from '@app/composables/pdf/usePdfScroll';

interface IPageRange {
    start: number;
    end: number;
}

interface IUsePdfViewerExposeControllersOptions {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
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
    resolveHorizontalScrollClampForActiveSpread: () => { shouldLock: boolean } | null;
    syncHorizontalScrollForZoomMode: () => boolean;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    isFitWidthScaleCurrent: (container: HTMLElement | null) => boolean;
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

export function usePdfViewerExposeControllers(options: IUsePdfViewerExposeControllersOptions) {
    const {
        captureViewerScrollSnapshot,
        restoreViewerScrollSnapshot,
    } = usePdfViewerScrollSnapshot({
        viewerContainer: options.viewerContainer,
        currentPage: options.currentPage,
        resolveHorizontalScrollClampForActiveSpread: options.resolveHorizontalScrollClampForActiveSpread,
        syncHorizontalScrollForZoomMode: options.syncHorizontalScrollForZoomMode,
        scrollToPage: options.scrollToPage,
    });

    const { applyFitWidthToCurrentPage } = usePdfViewerFitWidthController({
        viewerContainer: options.viewerContainer,
        pdfDocument: options.pdfDocument,
        isLoading: options.isLoading,
        continuousScroll: options.continuousScroll,
        fitMode: options.fitMode,
        zoomMode: options.zoomMode,
        zoom: options.zoom,
        effectiveScale: options.effectiveScale,
        viewMode: options.viewMode,
        numPages: options.numPages,
        pageMetricsVersion: options.pageMetricsVersion,
        visibleRange: options.visibleRange,
        captureViewerScrollSnapshot,
        computeFitWidthScale: options.computeFitWidthScale,
        isFitWidthScaleCurrent: options.isFitWidthScaleCurrent,
        syncHorizontalScrollForZoomMode: options.syncHorizontalScrollForZoomMode,
        cancelInFlightRenders: options.cancelInFlightRenders,
        reRenderAllVisiblePages: options.reRenderAllVisiblePages,
        emitZoomMode: options.emitZoomMode,
    });

    const {
        saveViewerDocument,
        renderLoadedPdfPagesForBrowserPrint,
    } = usePdfViewerSavePrintController({
        getPdfDocument: () => options.pdfDocument.value,
        getAnnotationUiManager: () => options.annotationUiManager.value,
    });

    return {
        captureViewerScrollSnapshot,
        restoreViewerScrollSnapshot,
        applyFitWidthToCurrentPage,
        saveViewerDocument,
        renderLoadedPdfPagesForBrowserPrint,
    };
}
