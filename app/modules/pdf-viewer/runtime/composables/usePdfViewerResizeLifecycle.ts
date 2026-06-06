import type { Ref } from 'vue';
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { captureScrollSnapshot } from '@app/utils/pdf-viewer/pdf-page-render-pipeline/captureScrollSnapshot';
import { restoreScrollFromSnapshot } from '@app/utils/pdf-viewer/pdf-page-render-pipeline/restoreScrollFromSnapshot';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
    summarizeViewerMetrics,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import { resolveResizeAnchorPage } from '@app/modules/pdf-viewer/runtime/resize-anchor/resolveResizeAnchorPage';

type TViewerMetrics = ReturnType<typeof summarizeViewerMetrics>;

export interface IBuildResizeAnchorContextOptions {
    anchorViewportX?: number | null;
    anchorViewportY?: number | null;
    preferredAnchorPage?: number | null;
    trustPreferredAnchorPage?: boolean;
    preferSnapshotAnchorPage?: boolean | undefined;
}

interface IUsePdfViewerResizeLifecycleOptions {
    viewerContainer: Ref<HTMLElement | null>;
    isLoading: Ref<boolean>;
    isActive?: Ref<boolean> | undefined;
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
    setResizeTransitionVisible?: ((payload: {
        active: boolean;
        source: string;
        token: number;
        anchorPage: number | null;
    }) => void) | undefined;
}

export const usePdfViewerResizeLifecycle = (options: IUsePdfViewerResizeLifecycleOptions) => {
    const {
        viewerContainer,
        isLoading,
        isActive,
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

    function normalizePreferredAnchorPage(page: number | null | undefined) {
        if (
            typeof page !== 'number'
            || !Number.isFinite(page)
            || page < 1
            || page > numPages.value
        ) {
            return null;
        }
        return Math.trunc(page);
    }

    function buildResizeAnchorContext(optionsOverride?: IBuildResizeAnchorContextOptions) {
        if (isActive?.value === false) {
            return {
                capturedAtMs: Date.now(),
                page: currentPage.value,
                transitionToken: 0,
                snapshot: null,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                viewerMetrics: summarizeViewerMetricsForLog(viewerContainer.value),
            } satisfies IResizeAnchorContext;
        }
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
        const preferredAnchorPage = optionsOverride?.trustPreferredAnchorPage
            ? normalizePreferredAnchorPage(optionsOverride.preferredAnchorPage)
            : null;
        const trustedPreferredAnchorPage =
            preferredAnchorPage !== null
            && (
                snapshotAnchorPage === null
                || Math.abs(preferredAnchorPage - snapshotAnchorPage) <= 1
            )
                ? preferredAnchorPage
                : null;
        const anchorPage = trustedPreferredAnchorPage ?? resolveResizeAnchorPage({
            totalPages: numPages.value,
            mostVisiblePage,
            snapshotAnchorPage,
            currentPage: currentPage.value,
            preferSnapshotAnchorPage: optionsOverride?.preferSnapshotAnchorPage,
        });
        const snapshot = captureScrollSnapshot(viewerContainer.value, {
            ...optionsOverride,
            preferredAnchorPage: anchorPage,
        }) ?? initialSnapshot;
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'anchor-build-captured', ZOOM_QUEUE_LOG_THROTTLE_MS, '[anchor-build] captured', {
            optionsOverride: optionsOverride ?? null,
            snapshotAnchorPage,
            mostVisiblePage,
            trustedPreferredAnchorPage,
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

    const debouncedRenderOnResizeWithAnchor = useDebounceFn(() => {
        if (isActive?.value === false || isLoading.value || !pdfDocument.value) {
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

    function restoreResizeAnchorAfterLayout(anchor: IResizeAnchorContext, source: string) {
        if (!anchor.snapshot || typeof window === 'undefined') {
            return;
        }

        const token = anchor.transitionToken;
        const restoreIfCurrent = (phase: string) => {
            if (token !== resizeTransitionToken) {
                return;
            }

            restoreScrollFromSnapshot(viewerContainer.value, anchor.snapshot, {
                restoreHorizontal: false,
                restoreVertical: true,
                preferPageAnchor: true,
                allowVerticalRatioFallback: true,
            });
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'resize-anchor-immediate-restore',
                ZOOM_QUEUE_LOG_THROTTLE_MS,
                '[resize-anchor] immediate vertical restore after layout',
                {
                    source,
                    phase,
                    token,
                    anchorPage: anchor.page,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                },
            );
        };

        void nextTick(() => {
            restoreIfCurrent('next-tick');
            window.requestAnimationFrame(() => {
                restoreIfCurrent('animation-frame');
            });
        });
    }

    function handleResize() {
        if (isActive?.value === false) {
            return;
        }
        if (isLoading.value || isResizing.value) {
            return;
        }
        const resizeAnchor = buildResizeAnchorContext({
            preferredAnchorPage: currentPage.value,
            trustPreferredAnchorPage: true,
        });
        const updated = computeFitWidthScale(viewerContainer.value);
        if (pdfDocument.value) {
            if (pendingResizeAnchor) {
                BrowserLogger.warnThrottled('pdf-zoom-debug', 'resize-anchor-preserved', ZOOM_QUEUE_LOG_THROTTLE_MS, '[resize-anchor] preserved first anchor in resize burst', {
                    updated,
                    preservedAnchorPage: pendingResizeAnchor.page,
                    ignoredAnchorPage: resizeAnchor.page,
                    preservedAnchorAgeMs: Date.now() - pendingResizeAnchor.capturedAtMs,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                });
                void debouncedRenderOnResizeWithAnchor();
                return;
            }
            if (!updated) {
                return;
            }
            const transitionToken = beginResizeTransition('resize-observer', resizeAnchor.page);
            const anchoredResizeContext: IResizeAnchorContext = {
                ...resizeAnchor,
                transitionToken,
            };
            pendingResizeAnchor = anchoredResizeContext;
            if (updated) {
                restoreResizeAnchorAfterLayout(anchoredResizeContext, 'resize-observer');
            }
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
        }
    }

    useResizeObserver(viewerContainer, handleResize);

    function cleanupResizeLifecycle() {
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
            pendingResizeTransitionHideTimer = null;
        }
        pendingResizeAnchor = null;
        resizeTransitionToken += 1;
        emitResizeTransitionSignal(false, 'unmount', resizeTransitionToken, currentPage.value);
    }

    return {
        buildResizeAnchorContext,
        beginResizeTransition,
        scheduleEndResizeTransition,
        cleanupResizeLifecycle,
    };
};
