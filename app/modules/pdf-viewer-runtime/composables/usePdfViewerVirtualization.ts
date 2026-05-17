import type {
    ComputedRef,
    Ref,
} from 'vue';
import {
    clamp,
    range,
} from 'es-toolkit/math';
import type { IPdfPageMetric } from '@app/types/pdf';
import type { TPdfViewMode } from '@contracts/shared';
import {
    buildPageLayoutMetrics,
    getLeadingSpacerHeightForPage,
    getPageRowBounds,
    getPageRowBoundsForViewMode,
    getTrailingSpacerHeightForPage,
    normalizePageMetrics,
} from '@app/composables/pdf/pdfPageLayout';

export interface IZoomVirtualizationFreeze {
    sessionId: number | null;
    capturedAtMs: number;
    windowStart: number;
    windowEnd: number;
    topSpacerHeight: number;
    bottomSpacerHeight: number;
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
    searchNavigationTargetPage: Ref<number | null>;
    resizeTransitionAnchorPage: Ref<number | null>;
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
}

const VIRTUAL_MOUNT_BUFFER_MIN = 6;
const SEARCH_NAV_VIRTUAL_BUFFER_MIN = 18;
const PAGED_MOUNT_ROW_BUFFER_BEFORE_MIN = 1;
const PAGED_MOUNT_ROW_BUFFER_AFTER_MIN = 2;

export function expandVirtualWindowForAnchor(options: {
    baseStart: number;
    baseEnd: number;
    anchorPage: number | null;
    totalPages: number;
    buffer: number;
}) {
    const baseStart = Math.max(1, Math.trunc(options.baseStart));
    const baseEnd = Math.max(baseStart, Math.trunc(options.baseEnd));
    const totalPages = Math.max(baseEnd, Math.trunc(options.totalPages));
    const anchorPage = typeof options.anchorPage === 'number' && Number.isFinite(options.anchorPage)
        ? clamp(Math.trunc(options.anchorPage), 1, totalPages)
        : null;
    if (anchorPage === null) {
        return {
            start: baseStart,
            end: Math.min(totalPages, baseEnd),
        };
    }

    const buffer = Math.max(0, Math.trunc(options.buffer));
    return {
        start: clamp(anchorPage - buffer, 1, baseStart),
        end: clamp(anchorPage + buffer, baseEnd, totalPages),
    };
}

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
        searchNavigationTargetPage,
        resizeTransitionAnchorPage,
        zoomVirtualizationFreeze,
    } = options;

    let normalizedMetricsCacheKey = '';
    let normalizedMetricsCacheValue: IPdfPageMetric[] = [];
    const normalizedPageMetrics = computed(() => {
        const cacheKey = [
            pageMetricsVersion.value,
            numPages.value,
            basePageWidth.value ?? 'null',
            basePageHeight.value ?? 'null',
        ].join('|');

        if (cacheKey === normalizedMetricsCacheKey) {
            return normalizedMetricsCacheValue;
        }

        normalizedMetricsCacheKey = cacheKey;
        normalizedMetricsCacheValue = normalizePageMetrics({
            pageMetrics: pageMetrics.value,
            totalPages: numPages.value,
            fallbackWidth: basePageWidth.value,
            fallbackHeight: basePageHeight.value,
        });
        return normalizedMetricsCacheValue;
    });

    const pageHeightEstimate = computed(() => {
        let maxHeight = 0;
        for (const metric of normalizedPageMetrics.value) {
            maxHeight = Math.max(maxHeight, metric.height * effectiveScale.value);
        }
        return maxHeight;
    });

    let pageLayoutCacheKey = '';
    let pageLayoutCacheValue: ReturnType<typeof buildPageLayoutMetrics> = null;
    const pageLayout = computed(() => {
        if (numPages.value <= 0 || pageHeightEstimate.value <= 0) {
            pageLayoutCacheKey = '';
            pageLayoutCacheValue = null;
            return null;
        }

        const cacheKey = [
            pageMetricsVersion.value,
            numPages.value,
            viewMode.value,
            effectiveScale.value,
            scaledMargin.value,
            basePageWidth.value ?? 'null',
            basePageHeight.value ?? 'null',
        ].join('|');

        if (cacheKey === pageLayoutCacheKey) {
            return pageLayoutCacheValue;
        }

        pageLayoutCacheKey = cacheKey;
        pageLayoutCacheValue = buildPageLayoutMetrics({
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
        return pageLayoutCacheValue;
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

    const isSearchNavigationActive = computed(() =>
        searchNavigationTargetPage.value !== null,
    );

    const virtualMountBuffer = computed(() =>
        isSearchNavigationActive.value
            ? Math.max(SEARCH_NAV_VIRTUAL_BUFFER_MIN, VIRTUAL_MOUNT_BUFFER_MIN, bufferPages.value + 2)
            : Math.max(VIRTUAL_MOUNT_BUFFER_MIN, bufferPages.value + 2),
    );

    const pagedWindowBounds = computed(() => {
        if (numPages.value <= 0) {
            return {
                start: 1,
                end: 0,
            };
        }

        const anchorPage = searchNavigationTargetPage.value ?? currentPage.value;
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

    const searchNavigationWindow = computed<{
        start: number;
        end: number;
    } | null>(() => {
        const anchorPage = searchNavigationTargetPage.value;
        if (!virtualizedContinuousMode.value || numPages.value <= 0 || anchorPage === null) {
            return null;
        }

        return {
            start: Math.max(1, anchorPage - virtualMountBuffer.value),
            end: Math.min(numPages.value, anchorPage + virtualMountBuffer.value),
        };
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

    const virtualWindowStart = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return pagedWindowBounds.value.start;
        }
        if (zoomVirtualizationFreeze.value) {
            return zoomVirtualizationFreeze.value.windowStart;
        }

        let nextStart = baseVirtualWindowStart.value;
        if (searchNavigationWindow.value) {
            nextStart = Math.min(nextStart, searchNavigationWindow.value.start);
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
        if (zoomVirtualizationFreeze.value) {
            return zoomVirtualizationFreeze.value.windowEnd;
        }

        let nextEnd = baseVirtualWindowEnd.value;
        if (searchNavigationWindow.value) {
            nextEnd = Math.max(nextEnd, searchNavigationWindow.value.end);
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
        const freeze = zoomVirtualizationFreeze.value;
        if (freeze) {
            if (freeze.topSpacerHeight <= 0) {
                return null;
            }
            return {height: `${freeze.topSpacerHeight}px`};
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
        const freeze = zoomVirtualizationFreeze.value;
        if (freeze) {
            if (freeze.bottomSpacerHeight <= 0) {
                return null;
            }
            return {height: `${freeze.bottomSpacerHeight}px`};
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
            return range(1, numPages.value + 1);
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
        searchNavigationWindow,
        resizeTransitionWindow,
        virtualWindowStart,
        virtualWindowEnd,
        virtualWindowStartPage,
        virtualWindowEndPage,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        pagesToRender,
        isPageBuffered,
    };
};
