import type {
    ComputedRef,
    Ref,
} from 'vue';
import { range } from 'es-toolkit/math';
import type { IPdfPageMetric } from '@app/types/pdf';
import type { TPdfViewMode } from '@contracts/shared';
import {
    buildPageLayoutMetrics,
    getLeadingSpacerHeight,
    getTrailingSpacerHeight,
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
    continuousScroll: ComputedRef<boolean>;
    viewMode: ComputedRef<TPdfViewMode>;
    numPages: Ref<number>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    pageMetrics: Ref<IPdfPageMetric[]>;
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
        ? Math.max(1, Math.min(totalPages, Math.trunc(options.anchorPage)))
        : null;
    if (anchorPage === null) {
        return {
            start: baseStart,
            end: Math.min(totalPages, baseEnd),
        };
    }

    const buffer = Math.max(0, Math.trunc(options.buffer));
    return {
        start: Math.max(1, Math.min(baseStart, anchorPage - buffer)),
        end: Math.min(totalPages, Math.max(baseEnd, anchorPage + buffer)),
    };
}

export function usePdfViewerVirtualization(options: IUsePdfViewerVirtualizationOptions) {
    const {
        bufferPages,
        continuousScroll,
        viewMode,
        numPages,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        effectiveScale,
        scaledMargin,
        visibleRange,
        searchNavigationTargetPage,
        resizeTransitionAnchorPage,
        zoomVirtualizationFreeze,
    } = options;

    const pageHeightEstimate = computed(() => {
        const layout = pageLayout.value;
        if (!layout || layout.pageHeights.length === 0) {
            return 0;
        }
        return Math.max(...layout.pageHeights);
    });

    const normalizedPageMetrics = computed(() =>
        normalizePageMetrics({
            pageMetrics: pageMetrics.value,
            totalPages: numPages.value,
            fallbackWidth: basePageWidth.value,
            fallbackHeight: basePageHeight.value,
        }),
    );

    const pageLayout = computed(() =>
        buildPageLayoutMetrics({
            pageMetrics: normalizedPageMetrics.value,
            totalPages: numPages.value,
            scale: effectiveScale.value,
            gap: scaledMargin.value,
            paddingTop: scaledMargin.value,
            paddingBottom: scaledMargin.value,
            fallbackWidth: basePageWidth.value,
            fallbackHeight: basePageHeight.value,
        }),
    );

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
        && viewMode.value === 'single'
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

    const baseVirtualWindowStart = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return 1;
        }
        return Math.max(1, visibleRange.value.start - virtualMountBuffer.value);
    });

    const baseVirtualWindowEnd = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return numPages.value;
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
            return 1;
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
            return numPages.value;
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

        const hiddenBefore = Math.max(0, virtualWindowStart.value - 1);
        const spacerHeight = getLeadingSpacerHeight(layout, hiddenBefore);
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

        const hiddenAfter = Math.max(0, numPages.value - virtualWindowEnd.value);
        const spacerHeight = getTrailingSpacerHeight(layout, hiddenAfter);
        if (spacerHeight <= 0) {
            return null;
        }

        return {height: `${spacerHeight}px`};
    });

    const pagesToRender = computed(() => {
        if (numPages.value <= 0) {
            return [];
        }

        if (!virtualizedContinuousMode.value) {
            return range(1, numPages.value + 1);
        }

        return range(virtualWindowStart.value, virtualWindowEnd.value + 1);
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
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        pagesToRender,
    };
}
