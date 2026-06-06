import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    TFitMode,
    TPdfSource,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdf';
import type { IPdfPageLayoutMetrics } from '@app/utils/pdf-viewer/pdf-page-layout/pdfPageLayoutTypes';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IPageRange {
    start: number;
    end: number;
}

interface IResizeTransitionSignal {
    active: boolean;
    source: string;
    token: number;
    anchorPage: number | null;
}

interface IUsePdfViewerViewportLifecycleOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    viewerHost: Ref<HTMLElement | null>;
    viewerContainer: Ref<HTMLElement | null>;
    resizeTransitionVisible: Ref<boolean>;
    resizeTransitionAnchorPage: Ref<number | null>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    continuousScroll: ComputedRef<boolean>;
    fitMode: ComputedRef<TFitMode>;
    zoomMode: ComputedRef<TZoomMode>;
    zoom: ComputedRef<number>;
    effectiveScale: ComputedRef<number>;
    viewMode: ComputedRef<TPdfViewMode>;
    numPages: Ref<number>;
    pageMetricsVersion: Ref<number>;
    pageLayout: ComputedRef<IPdfPageLayoutMetrics | null>;
    clearPinnedViewportPage: (source: string) => void;
    clearPendingImagePlacement: () => void;
    setPageLayoutMetrics: (metrics: IPdfPageLayoutMetrics | null) => void;
    syncHorizontalScrollForZoomMode: () => void;
    handleViewerScroll: (event: Event) => void;
    summarizeViewerStateForLog: () => unknown;
    loadingLabel: () => string;
}

export function usePdfViewerViewportLifecycle(options: IUsePdfViewerViewportLifecycleOptions) {
    function handleResizeTransitionSignal(payload: IResizeTransitionSignal) {
        const nextAnchorPage = payload.active ? payload.anchorPage : null;
        if (
            options.resizeTransitionVisible.value === payload.active
            && options.resizeTransitionAnchorPage.value === nextAnchorPage
        ) {
            return;
        }
        options.resizeTransitionVisible.value = payload.active;
        options.resizeTransitionAnchorPage.value = nextAnchorPage;
        BrowserLogger.warn('pdf-nav', `[resize-transition-ui] active=${payload.active}`, {
            ...payload,
            storedAnchorPage: options.resizeTransitionAnchorPage.value,
            viewer: options.summarizeViewerStateForLog(),
            currentPage: options.currentPage.value,
            visibleRange: {
                start: options.visibleRange.value.start,
                end: options.visibleRange.value.end,
            },
        });
    }

    function handleViewerContainerRef(element: HTMLElement | null) {
        options.viewerContainer.value = element;
    }

    function handleViewportScroll(event: Event) {
        options.syncHorizontalScrollForZoomMode();
        options.handleViewerScroll(event);
        options.syncHorizontalScrollForZoomMode();
    }

    watch(
        [
            () => Boolean(options.src.value),
            options.isLoading,
        ],
        ([
            hasSrc,
            loading,
        ], [
            prevHasSrc,
            prevLoading,
        ]) => {
            if (hasSrc === prevHasSrc && loading === prevLoading) {
                return;
            }

            const hostRect = options.viewerHost.value?.getBoundingClientRect();
            BrowserLogger.debug('loader', 'PDF viewer loader state changed', {
                hasSrc,
                loading,
                overlayVisible: false,
                label: options.loadingLabel(),
                hostWidth: hostRect ? Math.round(hostRect.width) : null,
                hostHeight: hostRect ? Math.round(hostRect.height) : null,
            });
        },
        { immediate: true },
    );

    watch(
        () => [
            options.zoomMode.value,
            options.fitMode.value,
            options.currentPage.value,
            options.effectiveScale.value,
            options.viewMode.value,
            options.numPages.value,
            options.pageMetricsVersion.value,
        ] as const,
        () => {
            void nextTick(options.syncHorizontalScrollForZoomMode);
        },
        { immediate: true },
    );

    watchEffect(() => {
        if (options.pageLayout.value) {
            options.setPageLayoutMetrics(options.pageLayout.value);
            return;
        }

        options.setPageLayoutMetrics(null);
    });

    onBeforeUnmount(() => {
        options.clearPinnedViewportPage('before-unmount');
        options.clearPendingImagePlacement();
        options.setPageLayoutMetrics(null);
        options.resizeTransitionVisible.value = false;
        options.resizeTransitionAnchorPage.value = null;
    });

    return {
        handleResizeTransitionSignal,
        handleViewerContainerRef,
        handleViewportScroll,
    };
}
