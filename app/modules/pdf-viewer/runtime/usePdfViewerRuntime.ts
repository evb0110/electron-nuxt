import type { Ref } from 'vue';
import { usePdfDocument } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument';
import { usePdfScale } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScale';
import { usePdfScroll } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '@app/modules/pdf-viewer/runtime/skeleton/usePdfSkeletonInsets';
import { useViewportPagePin } from '@app/modules/pdf-viewer/runtime/composables/pdf/useViewportPagePin';
import { usePdfViewerReloadTransition } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerReloadTransition';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import { createPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';

interface IUsePdfViewerRuntimeOptions {
    viewerContainer: Ref<HTMLElement | null>;
    zoom: Ref<number>;
    zoomMode: Ref<TZoomMode>;
    fitMode: Ref<TFitMode>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    emitEffectiveZoom: (value: number) => void;
    summarizeViewerStateForLog: () => unknown;
    viewportWritePort?: IPdfViewportWritePort | undefined;
}

export const usePdfViewerRuntime = (options: IUsePdfViewerRuntimeOptions) => {
    const document = usePdfDocument();
    const {
        pdfDocument,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
    } = document;

    const viewportPin = useViewportPagePin({ summarizeViewerStateForLog: options.summarizeViewerStateForLog });

    const scroll = usePdfScroll({
        getPinnedMostVisiblePage: () => viewportPin.getPinnedViewportPage(),
        viewportWritePort: options.viewportWritePort ?? createPdfViewportWritePort(),
    });

    const scale = usePdfScale(
        options.zoom,
        options.zoomMode,
        options.fitMode,
        options.viewMode,
        numPages,
        pageMetrics,
        pageMetricsVersion,
        basePageWidth,
        basePageHeight,
        scroll.currentPage,
    );

    const reloadTransition = usePdfViewerReloadTransition({
        emitEffectiveZoom: options.emitEffectiveZoom,
        summarizeViewerStateForLog: options.summarizeViewerStateForLog,
    });

    watch(
        // The toolbar is a projection of the geometry currently on screen.
        // During divider/window resize that is the live preview scale; the
        // canonical fit scale catches up at settle without a visible jump.
        () => scale.layoutScale.value,
        value => reloadTransition.emitEffectiveZoom(value),
        { immediate: true },
    );

    const skeletonInsets = usePdfSkeletonInsets(basePageWidth, basePageHeight, scale.effectiveScale);

    return {
        document,
        pdfDocument,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        viewportPin,
        scroll,
        scale,
        reloadTransition,
        skeletonInsets,
        state: {
            pdfDocument,
            numPages,
            isLoading,
            basePageWidth,
            basePageHeight,
            pageMetrics,
            pageMetricsVersion,
            currentPage: scroll.currentPage,
            visibleRange: scroll.visibleRange,
            effectiveScale: scale.effectiveScale,
            scaledMargin: scale.scaledMargin,
            isVisualReloadTransitionActive: reloadTransition.isVisualReloadTransitionActive,
        },
    };
};
