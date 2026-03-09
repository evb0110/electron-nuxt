import type {
    ComputedRef,
    Ref,
} from 'vue';
import { range } from 'es-toolkit/math';
import type { TPdfViewMode } from '@app/types/pdf';

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
    effectiveScale: Ref<number>;
    scaledMargin: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    searchNavigationTargetPage: Ref<number | null>;
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
}

const VIRTUAL_MOUNT_BUFFER_MIN = 6;
const SEARCH_NAV_VIRTUAL_BUFFER_MIN = 18;

export function usePdfViewerVirtualization(options: IUsePdfViewerVirtualizationOptions) {
    const {
        bufferPages,
        continuousScroll,
        viewMode,
        numPages,
        basePageWidth,
        basePageHeight,
        effectiveScale,
        scaledMargin,
        visibleRange,
        searchNavigationTargetPage,
        zoomVirtualizationFreeze,
    } = options;

    const pageHeightEstimate = computed(() => {
        const baseHeight = basePageHeight.value;
        if (!baseHeight) {
            return 0;
        }
        return baseHeight * effectiveScale.value;
    });

    const pageGapEstimate = computed(() => scaledMargin.value);

    const pagePlaceholderStyle = computed<Record<string, string> | null>(() => {
        const baseWidth = basePageWidth.value;
        const baseHeight = basePageHeight.value;
        if (!baseWidth || !baseHeight) {
            return null;
        }

        return {
            width: `${baseWidth * effectiveScale.value}px`,
            height: `${baseHeight * effectiveScale.value}px`,
        };
    });

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

    const virtualWindowStart = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return 1;
        }
        if (zoomVirtualizationFreeze.value) {
            return zoomVirtualizationFreeze.value.windowStart;
        }

        if (searchNavigationWindow.value) {
            return searchNavigationWindow.value.start;
        }
        return baseVirtualWindowStart.value;
    });

    const virtualWindowEnd = computed(() => {
        if (!virtualizedContinuousMode.value) {
            return numPages.value;
        }
        if (zoomVirtualizationFreeze.value) {
            return zoomVirtualizationFreeze.value.windowEnd;
        }

        if (searchNavigationWindow.value) {
            return searchNavigationWindow.value.end;
        }
        return baseVirtualWindowEnd.value;
    });

    function computeVirtualSpacerHeight(hiddenPages: number) {
        if (hiddenPages <= 0) {
            return 0;
        }
        return hiddenPages * pageHeightEstimate.value
            + Math.max(0, hiddenPages - 1) * pageGapEstimate.value;
    }

    const topVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
        if (!virtualizedContinuousMode.value) {
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
        const spacerHeight = computeVirtualSpacerHeight(hiddenBefore);
        if (spacerHeight <= 0) {
            return null;
        }

        return {height: `${spacerHeight}px`};
    });

    const bottomVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
        if (!virtualizedContinuousMode.value) {
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
        const spacerHeight = computeVirtualSpacerHeight(hiddenAfter);
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
        pageGapEstimate,
        pagePlaceholderStyle,
        virtualizedContinuousMode,
        searchNavigationWindow,
        virtualWindowStart,
        virtualWindowEnd,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        pagesToRender,
    };
}
