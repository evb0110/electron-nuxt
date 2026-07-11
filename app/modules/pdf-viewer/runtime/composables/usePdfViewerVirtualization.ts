import type {
    ComputedRef,
    Ref,
} from 'vue';
import { range } from 'es-toolkit/math';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type { TPdfViewMode } from '@contracts/shared';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import { getLeadingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getLeadingSpacerHeightForPage';
import { getPageRowBounds } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBounds';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { getTrailingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getTrailingSpacerHeightForPage';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import {
    createAnchorPageWindow,
    expandVirtualWindowForAnchor,
} from '@app/utils/document-viewer/virtualization/pageVirtualization';

export interface IZoomVirtualizationFreeze {
    sessionId: number | null;
    capturedAtMs: number;
    windowStart: number;
    windowEnd: number;
}

export interface IPdfVirtualPageSegment {
    end: number;
    key: string;
    pages: number[];
    spacerBeforeStyle: Record<string, string> | null;
    start: number;
}

interface IUsePdfViewerVirtualizationOptions {
    bufferPages: ComputedRef<number>;
    viewMode: ComputedRef<TPdfViewMode>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    continuousScroll: ComputedRef<boolean>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    pageMetrics: Ref<IPdfPageMetric[]>;
    pageMetricsVersion: Ref<number>;
    effectiveScale: Ref<number>;
    scaledMargin: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    navigationAnchorPage: Ref<number | null>;
    resizeTransitionAnchorPage: Ref<number | null>;
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
}

const VIRTUAL_MOUNT_BUFFER_MIN = 6;
const NAVIGATION_ANCHOR_VIRTUAL_BUFFER_MIN = 18;
const PAGED_MOUNT_ROW_BUFFER_BEFORE_MIN = 1;
const PAGED_MOUNT_ROW_BUFFER_AFTER_MIN = 2;
const CONTINUOUS_LAYOUT_PENDING_FALLBACK_RADIUS = 30;

export const usePdfViewerVirtualization = (options: IUsePdfViewerVirtualizationOptions) => {
    const {
        bufferPages,
        viewMode,
        numPages,
        currentPage,
        continuousScroll,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        effectiveScale,
        scaledMargin,
        visibleRange,
        navigationAnchorPage,
        resizeTransitionAnchorPage,
        zoomVirtualizationFreeze,
    } = options;

    const pageMetricsSnapshot = computed(() => ({
        metrics: pageMetrics.value,
        version: pageMetricsVersion.value,
    }));

    const normalizedPageMetrics = computed(() =>
        normalizePageMetrics({
            pageMetrics: pageMetricsSnapshot.value.metrics,
            totalPages: numPages.value,
            fallbackWidth: basePageWidth.value,
            fallbackHeight: basePageHeight.value,
        }),
    );

    const pageHeightEstimate = computed(() => {
        let maxHeight = 0;
        for (const metric of normalizedPageMetrics.value) {
            maxHeight = Math.max(maxHeight, metric.height * effectiveScale.value);
        }
        return maxHeight;
    });

    const pageLayout = computed(() => {
        if (numPages.value <= 0 || pageHeightEstimate.value <= 0) {
            return null;
        }

        return buildPageLayoutMetrics({
            pageMetrics: normalizedPageMetrics.value,
            totalPages: numPages.value,
            viewMode: viewMode.value,
            scale: effectiveScale.value,
            gap: scaledMargin.value,
            paddingTop: scaledMargin.value,
            paddingBottom: scaledMargin.value,
            fallbackWidth: basePageWidth.value,
            fallbackHeight: basePageHeight.value,
        });
    });

    function getPagePlaceholderStyle(pageNumber: number): Record<string, string> | null {
        const metric = normalizedPageMetrics.value[pageNumber - 1];
        if (!metric) {
            return null;
        }

        return {
            width: `${metric.width * effectiveScale.value}px`,
            height: `${metric.height * effectiveScale.value}px`,
        };
    }

    const virtualizedContinuousMode = computed(() =>
        continuousScroll.value
        && numPages.value > 0
        && pageHeightEstimate.value > 0,
    );

    const isNavigationAnchorActive = computed(() =>
        navigationAnchorPage.value !== null,
    );

    const virtualMountBuffer = computed(() =>
        isNavigationAnchorActive.value
            ? Math.max(NAVIGATION_ANCHOR_VIRTUAL_BUFFER_MIN, VIRTUAL_MOUNT_BUFFER_MIN, bufferPages.value + 2)
            : Math.max(VIRTUAL_MOUNT_BUFFER_MIN, bufferPages.value + 2),
    );

    const pagedWindowBounds = computed(() => {
        if (numPages.value <= 0) {
            return {
                start: 1,
                end: 0,
            };
        }

        const anchorPage = navigationAnchorPage.value ?? currentPage.value;
        return getPageRowBoundsForViewMode({
            pageNumber: anchorPage,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
    });

    const pagedMountRowsBefore = computed(() =>
        Math.max(PAGED_MOUNT_ROW_BUFFER_BEFORE_MIN, Math.trunc(bufferPages.value) - 1),
    );

    const pagedMountRowsAfter = computed(() =>
        Math.max(PAGED_MOUNT_ROW_BUFFER_AFTER_MIN, Math.trunc(bufferPages.value)),
    );

    const pagedMountedWindowBounds = computed(() => {
        const activeBounds = pagedWindowBounds.value;
        if (activeBounds.end < activeBounds.start) {
            return activeBounds;
        }

        let startBounds = activeBounds;
        for (let rowOffset = 0; rowOffset < pagedMountRowsBefore.value; rowOffset += 1) {
            if (startBounds.start <= 1) {
                break;
            }
            startBounds = getPageRowBoundsForViewMode({
                pageNumber: startBounds.start - 1,
                viewMode: viewMode.value,
                totalPages: numPages.value,
            });
        }

        let endBounds = activeBounds;
        for (let rowOffset = 0; rowOffset < pagedMountRowsAfter.value; rowOffset += 1) {
            if (endBounds.end >= numPages.value) {
                break;
            }
            endBounds = getPageRowBoundsForViewMode({
                pageNumber: endBounds.end + 1,
                viewMode: viewMode.value,
                totalPages: numPages.value,
            });
        }

        return {
            start: startBounds.start,
            end: endBounds.end,
        };
    });

    function isPageBuffered(pageNumber: number) {
        if (continuousScroll.value) {
            return false;
        }

        const activeBounds = pagedWindowBounds.value;
        return pageNumber < activeBounds.start || pageNumber > activeBounds.end;
    }

    const baseVirtualWindowStart = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.start;
        }
        return Math.max(1, visibleRange.value.start - virtualMountBuffer.value);
    });

    const baseVirtualWindowEnd = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.end;
        }
        return Math.min(numPages.value, visibleRange.value.end + virtualMountBuffer.value);
    });

    const navigationAnchorWindow = computed<{
        start: number;
        end: number;
    } | null>(() => {
        const anchorPage = navigationAnchorPage.value;
        if (!virtualizedContinuousMode.value || numPages.value <= 0 || anchorPage === null) {
            return null;
        }

        return createAnchorPageWindow({
            anchorPage,
            totalPages: numPages.value,
            radiusPages: virtualMountBuffer.value,
        });
    });

    const resizeTransitionWindow = computed<{
        start: number;
        end: number;
    } | null>(() => {
        if (!virtualizedContinuousMode.value || numPages.value <= 0) {
            return null;
        }

        const anchorPage = resizeTransitionAnchorPage.value;
        if (anchorPage === null) {
            return null;
        }

        return expandVirtualWindowForAnchor({
            baseStart: baseVirtualWindowStart.value,
            baseEnd: baseVirtualWindowEnd.value,
            anchorPage,
            totalPages: numPages.value,
            buffer: virtualMountBuffer.value,
        });
    });

    /**
     * Keeps the zoom freeze only while it still contains the active navigation
     * anchor. Otherwise a stale frozen window can hide a bookmark target row.
     */
    const activeZoomVirtualizationFreeze = computed(() => {
        const freeze = zoomVirtualizationFreeze.value;
        if (!virtualizedContinuousMode.value || !freeze) {
            return null;
        }

        const anchorPage = navigationAnchorPage.value;
        if (
            anchorPage !== null
            && (anchorPage < freeze.windowStart || anchorPage > freeze.windowEnd)
        ) {
            return null;
        }

        return freeze;
    });

    const virtualWindowStart = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.start;
        }
        if (activeZoomVirtualizationFreeze.value) {
            return activeZoomVirtualizationFreeze.value.windowStart;
        }

        let nextStart = baseVirtualWindowStart.value;
        if (navigationAnchorWindow.value) {
            nextStart = Math.min(nextStart, navigationAnchorWindow.value.start);
        }
        if (resizeTransitionWindow.value) {
            nextStart = Math.min(nextStart, resizeTransitionWindow.value.start);
        }
        return nextStart;
    });

    const virtualWindowEnd = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.end;
        }
        if (activeZoomVirtualizationFreeze.value) {
            return activeZoomVirtualizationFreeze.value.windowEnd;
        }

        let nextEnd = baseVirtualWindowEnd.value;
        if (navigationAnchorWindow.value) {
            nextEnd = Math.max(nextEnd, navigationAnchorWindow.value.end);
        }
        if (resizeTransitionWindow.value) {
            nextEnd = Math.max(nextEnd, resizeTransitionWindow.value.end);
        }
        return nextEnd;
    });

    const topVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
        if (!virtualizedContinuousMode.value) {
            return null;
        }
        const layout = pageLayout.value;
        if (!layout) {
            return null;
        }
        const spacerHeight = getLeadingSpacerHeightForPage(layout, virtualWindowStartPage.value);
        if (spacerHeight <= 0) {
            return null;
        }

        return {height: `${spacerHeight}px`};
    });

    const bottomVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
        if (!virtualizedContinuousMode.value) {
            return null;
        }
        const layout = pageLayout.value;
        if (!layout) {
            return null;
        }
        const spacerHeight = getTrailingSpacerHeightForPage(layout, virtualWindowEndPage.value);
        if (spacerHeight <= 0) {
            return null;
        }

        return {height: `${spacerHeight}px`};
    });

    const pagesToRender = computed(() => {
        if (numPages.value <= 0) {
            return [];
        }

        const layout = pageLayout.value;
        if (!layout) {
            if (!continuousScroll.value) {
                const bounds = pagedMountedWindowBounds.value;
                return bounds.end >= bounds.start
                    ? range(bounds.start, bounds.end + 1)
                    : [];
            }
            const start = Math.max(1, currentPage.value - CONTINUOUS_LAYOUT_PENDING_FALLBACK_RADIUS);
            const end = Math.min(numPages.value, currentPage.value + CONTINUOUS_LAYOUT_PENDING_FALLBACK_RADIUS);
            return range(start, end + 1);
        }

        if (!continuousScroll.value) {
            const bounds = pagedMountedWindowBounds.value;
            return bounds.end >= bounds.start
                ? range(bounds.start, bounds.end + 1)
                : [];
        }

        const startBounds = getPageRowBounds(layout, virtualWindowStart.value);
        const endBounds = getPageRowBounds(layout, virtualWindowEnd.value);
        const renderStartPage = startBounds?.start ?? virtualWindowStart.value;
        const renderEndPage = endBounds?.end ?? virtualWindowEnd.value;

        return range(renderStartPage, renderEndPage + 1);
    });

    const virtualPageSegments = computed<IPdfVirtualPageSegment[]>(() => {
        const pages = pagesToRender.value;
        if (!virtualizedContinuousMode.value || pages.length === 0) {
            const start = pages[0];
            const end = pages.at(-1);
            return start === undefined || end === undefined
                ? []
                : [{
                    end,
                    key: `${start}:${end}`,
                    pages,
                    spacerBeforeStyle: null,
                    start,
                }];
        }

        const layout = pageLayout.value;
        if (!layout) {
            return [{
                end: pages.at(-1) ?? 0,
                key: `${pages[0] ?? 0}:${pages.at(-1) ?? 0}`,
                pages,
                spacerBeforeStyle: null,
                start: pages[0] ?? 0,
            }];
        }

        const requestedWindows = activeZoomVirtualizationFreeze.value
            ? [{
                start: activeZoomVirtualizationFreeze.value.windowStart,
                end: activeZoomVirtualizationFreeze.value.windowEnd,
            }]
            : [
                {
                    start: baseVirtualWindowStart.value,
                    end: baseVirtualWindowEnd.value,
                },
                navigationAnchorWindow.value,
                resizeTransitionWindow.value,
            ].filter((window): window is {
                start: number;
                end: number;
            } => window !== null);

        const rowWindows = requestedWindows
            .map((window) => ({
                start: getPageRowBounds(layout, window.start)?.start ?? window.start,
                end: getPageRowBounds(layout, window.end)?.end ?? window.end,
            }))
            .sort((left, right) => left.start - right.start);
        const mergedWindows: Array<{
            start: number;
            end: number;
        }> = [];
        for (const window of rowWindows) {
            const previous = mergedWindows.at(-1);
            if (previous && window.start <= previous.end + 1) {
                previous.end = Math.max(previous.end, window.end);
            } else {
                mergedWindows.push({...window});
            }
        }

        return mergedWindows.map((window, index) => {
            const previous = mergedWindows[index - 1];
            let spacerHeight = getLeadingSpacerHeightForPage(layout, window.start);
            if (previous) {
                const previousPageIndex = previous.end - 1;
                const previousRowIndex = layout.pageRowIndices[previousPageIndex] ?? 0;
                const previousTop = layout.pageTops[previousPageIndex] ?? 0;
                const previousHeight = layout.rowHeights[previousRowIndex] ?? 0;
                const nextTop = layout.pageTops[window.start - 1] ?? previousTop + previousHeight;
                spacerHeight = Math.max(0, nextTop - previousTop - previousHeight);
            }
            return {
                ...window,
                key: `${window.start}:${window.end}`,
                pages: range(window.start, window.end + 1),
                spacerBeforeStyle: spacerHeight > 0
                    ? {height: `${spacerHeight}px`}
                    : null,
            };
        });
    });

    const disjointPagesToRender = computed(() =>
        virtualPageSegments.value.flatMap(segment => segment.pages),
    );

    const virtualWindowStartPage = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.start;
        }
        const layout = pageLayout.value;
        if (!layout) {
            return virtualWindowStart.value;
        }
        return getPageRowBounds(layout, virtualWindowStart.value)?.start ?? virtualWindowStart.value;
    });

    const virtualWindowEndPage = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.end;
        }

        const layout = pageLayout.value;
        if (!layout) {
            return virtualWindowEnd.value;
        }
        return getPageRowBounds(layout, virtualWindowEnd.value)?.end ?? virtualWindowEnd.value;
    });

    return {
        pageHeightEstimate,
        pageLayout,
        getPagePlaceholderStyle,
        virtualizedContinuousMode,
        navigationAnchorWindow,
        resizeTransitionWindow,
        virtualWindowStart,
        virtualWindowEnd,
        virtualWindowStartPage,
        virtualWindowEndPage,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        pagesToRender: disjointPagesToRender,
        virtualPageSegments,
        isPageBuffered,
    };
};
