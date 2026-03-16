import type { Ref } from 'vue';
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browser-logger';
import { captureScrollSnapshot } from '@app/composables/pdf/pdfPageRenderPipeline';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
    summarizeViewerMetrics,
} from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerCurrentPageSync';
import { resolveResizeAnchorPage } from '@app/modules/pdf-viewer-runtime/resizeAnchor';

type TViewerMetrics = ReturnType<typeof summarizeViewerMetrics>;

interface IUsePdfViewerResizeLifecycleOptions {
    viewerContainer: Ref<HTMLElement | null>;
    isLoading: Ref<boolean>;
    isResizing: Ref<boolean>;
    pdfDocument: Ref<unknown | null>;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    numPages: Ref<number>;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    getMostVisiblePage: (container: HTMLElement | null, numPages: number) => number;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => TViewerMetrics;
    summarizeVisiblePageSnapshotForLog: (container: HTMLElement | null) => unknown;
    scheduleResizeAwareRerender: (
        stage: string,
        syncOptions?: ICurrentPageSyncOptions,
    ) => void;
    setResizeTransitionVisible?: (payload: {
        active: boolean;
        source: string;
        token: number;
        anchorPage: number | null;
    }) => void;
}

export function usePdfViewerResizeLifecycle(options: IUsePdfViewerResizeLifecycleOptions) {
    const {
        viewerContainer,
        isLoading,
        isResizing,
        pdfDocument,
        currentPage,
        visibleRange,
        numPages,
        computeFitWidthScale,
        getMostVisiblePage,
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        scheduleResizeAwareRerender,
        setResizeTransitionVisible,
    } = options;

    const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
    let resizeTransitionToken = 0;
    let pendingResizeTransitionHideTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingResizeAnchor: IResizeAnchorContext | null = null;

    function emitResizeTransitionSignal(
        active: boolean,
        source: string,
        token: number,
        anchorPage: number | null,
    ) {
        setResizeTransitionVisible?.({
            active,
            source,
            token,
            anchorPage,
        });
    }

    function beginResizeTransition(source: string, anchorPage: number | null) {
        resizeTransitionToken += 1;
        const token = resizeTransitionToken;
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
            pendingResizeTransitionHideTimer = null;
        }
        emitResizeTransitionSignal(true, source, token, anchorPage);
        return token;
    }

    function scheduleEndResizeTransition(
        token: number,
        source: string,
        anchorPage: number | null,
    ) {
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
        }
        pendingResizeTransitionHideTimer = setTimeout(() => {
            if (token !== resizeTransitionToken) {
                return;
            }
            emitResizeTransitionSignal(false, source, token, anchorPage);
            pendingResizeTransitionHideTimer = null;
        }, 90);
    }

    function buildResizeAnchorContext(optionsOverride?: {
        anchorViewportX?: number | null;
        anchorViewportY?: number | null;
    }) {
        const initialSnapshot = captureScrollSnapshot(viewerContainer.value, optionsOverride);
        const snapshotAnchorPage =
            initialSnapshot
            && typeof initialSnapshot.anchorPage === 'number'
            && Number.isFinite(initialSnapshot.anchorPage)
                ? initialSnapshot.anchorPage
                : null;
        const mostVisiblePage = getMostVisiblePage(
            viewerContainer.value,
            numPages.value,
        );
        const anchorPage = resolveResizeAnchorPage({
            totalPages: numPages.value,
            mostVisiblePage,
            snapshotAnchorPage,
            currentPage: currentPage.value,
        });
        const snapshot = captureScrollSnapshot(viewerContainer.value, {
            ...optionsOverride,
            preferredAnchorPage: anchorPage,
        }) ?? initialSnapshot;
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'anchor-build-captured', ZOOM_QUEUE_LOG_THROTTLE_MS, '[anchor-build] captured', {
            optionsOverride: optionsOverride ?? null,
            snapshotAnchorPage,
            mostVisiblePage,
            anchorPage,
            snapshot,
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
        return {
            capturedAtMs: Date.now(),
            page: anchorPage,
            transitionToken: 0,
            snapshot,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewerMetrics: summarizeViewerMetricsForLog(viewerContainer.value),
        } satisfies IResizeAnchorContext;
    }

    const debouncedRenderOnResize = useDebounceFn(() => {
        if (isLoading.value || !pdfDocument.value) {
            return;
        }
        scheduleResizeAwareRerender('re-render visible pages after resize', {
            source: 'resize-observer',
            stabilize: true,
        });
    }, 200);

    const debouncedRenderOnResizeWithAnchor = useDebounceFn(() => {
        if (isLoading.value || !pdfDocument.value) {
            if (pendingResizeAnchor) {
                scheduleEndResizeTransition(
                    pendingResizeAnchor.transitionToken,
                    'resize-cancelled',
                    pendingResizeAnchor.page,
                );
            }
            pendingResizeAnchor = null;
            return;
        }
        const anchor = pendingResizeAnchor;
        pendingResizeAnchor = null;
        scheduleResizeAwareRerender('re-render visible pages after resize', {
            source: 'resize-observer',
            stabilize: true,
            resizeAnchor: anchor,
        });
    }, 200);

    function handleResize() {
        if (isLoading.value || isResizing.value) {
            return;
        }
        const resizeAnchor = buildResizeAnchorContext();
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated && pdfDocument.value) {
            const transitionToken = beginResizeTransition('resize-observer', resizeAnchor.page);
            const anchoredResizeContext: IResizeAnchorContext = {
                ...resizeAnchor,
                transitionToken,
            };
            pendingResizeAnchor = anchoredResizeContext;
            BrowserLogger.warn('pdf-nav', 'Resize observer requested re-render'
                + ` anchorPage=${anchoredResizeContext.page}`
                + ` anchorRange=${anchoredResizeContext.visibleRange.start}-${anchoredResizeContext.visibleRange.end}`
                + ` token=${anchoredResizeContext.transitionToken}`, {
                currentPage: currentPage.value,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                anchorSnapshot: anchoredResizeContext.snapshot,
                anchorViewerMetrics: anchoredResizeContext.viewerMetrics,
                pendingAnchorPage: pendingResizeAnchor.page,
                pendingAnchorAgeMs: Date.now() - pendingResizeAnchor.capturedAtMs,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
            });
            void debouncedRenderOnResizeWithAnchor();
            return;
        }
        void debouncedRenderOnResize();
    }

    useResizeObserver(viewerContainer, handleResize);

    function cleanupResizeLifecycle() {
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
            pendingResizeTransitionHideTimer = null;
        }
        emitResizeTransitionSignal(false, 'unmount', resizeTransitionToken, currentPage.value);
    }

    return {
        buildResizeAnchorContext,
        beginResizeTransition,
        scheduleEndResizeTransition,
        cleanupResizeLifecycle,
    };
}
