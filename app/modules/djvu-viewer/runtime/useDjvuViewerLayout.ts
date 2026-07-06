import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfViewMode } from '@contracts/shared';
import type { IDjvuPageSize } from '@app/platform/browser-api/public';
import { getViewColumnCount } from '@app/utils/pdfViewMode';

interface IUseDjvuViewerLayoutOptions {
    containerHeight: Ref<number>;
    containerWidth: Ref<number>;
    currentPage: Ref<number>;
    getRenderedPageNumbers: () => readonly number[];
    isContinuousScroll: ComputedRef<boolean>;
    manualZoom: ComputedRef<number>;
    pageSizes: Ref<IDjvuPageSize[]>;
    totalPages: ComputedRef<number>;
    viewMode: ComputedRef<TPdfViewMode>;
    viewerContainer: Ref<HTMLElement | null>;
    zoomMode: ComputedRef<'custom' | 'fit-width' | 'fit-height'>;
}

const DJVU_BASE_MARGIN = 16;
const DJVU_PREVIEW_DEVICE_PIXEL_RATIO_CAP = 2;
const DJVU_BASE_UNITS_PER_INCH = 72;
const DJVU_FALLBACK_DPI = 300;

export const useDjvuViewerLayout = (options: IUseDjvuViewerLayoutOptions) => {
    function getFitHeightAvailableHeight() {
        return Math.max(1, options.containerHeight.value - DJVU_BASE_MARGIN * 2);
    }

    function getPageCssScale(pageSize: IDjvuPageSize | null | undefined) {
        const dpi = pageSize?.dpi;
        const safeDpi = typeof dpi === 'number' && Number.isFinite(dpi) && dpi > 0
            ? dpi
            : DJVU_FALLBACK_DPI;
        return DJVU_BASE_UNITS_PER_INCH / safeDpi;
    }

    function getPageBaseWidth(pageSize: IDjvuPageSize) {
        return pageSize.width * getPageCssScale(pageSize);
    }

    function getPageBaseHeight(pageSize: IDjvuPageSize) {
        return pageSize.height * getPageCssScale(pageSize);
    }

    function resolveFitHeightZoomForPageSize(pageSize: IDjvuPageSize | null | undefined) {
        const baseHeight = pageSize ? getPageBaseHeight(pageSize) : 0;
        if (!baseHeight || baseHeight <= 0) {
            return options.manualZoom.value;
        }

        return Math.max(0.1, getFitHeightAvailableHeight() / baseHeight);
    }

    const currentSpreadWidth = computed(() => {
        const pageNumbers = options.getRenderedPageNumbers();
        if (pageNumbers.length === 0) {
            return null;
        }

        let total = 0;
        for (const pageNumber of pageNumbers) {
            const pageSize = options.pageSizes.value[pageNumber - 1];
            if (pageSize && pageSize.width > 0) {
                total += getPageBaseWidth(pageSize);
            }
        }
        return total > 0 ? total : null;
    });

    function fitWidthAvailable() {
        const columns = options.isContinuousScroll.value
            ? 1
            : getViewColumnCount(options.viewMode.value, options.totalPages.value);
        return Math.max(1, options.containerWidth.value - DJVU_BASE_MARGIN * (columns + 1));
    }

    function resolveFitHeightZoom() {
        const currentPageSize = options.pageSizes.value[options.currentPage.value - 1] ?? options.pageSizes.value[0] ?? null;
        return resolveFitHeightZoomForPageSize(currentPageSize);
    }

    function resolveFitWidthBaseWidth() {
        const currentPageSize = options.pageSizes.value[options.currentPage.value - 1];
        const baseWidth = options.isContinuousScroll.value
            ? (currentPageSize ? getPageBaseWidth(currentPageSize) : null)
            : currentSpreadWidth.value;
        return baseWidth && baseWidth > 0 ? baseWidth : null;
    }

    function resolveFitWidthZoom() {
        const baseWidth = resolveFitWidthBaseWidth();
        if (baseWidth === null) {
            return options.manualZoom.value;
        }

        return Math.max(0.1, fitWidthAvailable() / baseWidth);
    }

    const effectiveZoom = computed(() => {
        if (options.zoomMode.value === 'custom') {
            return options.manualZoom.value;
        }

        if (options.zoomMode.value === 'fit-height') {
            return resolveFitHeightZoom();
        }

        return resolveFitWidthZoom();
    });

    function getPageZoom(pageNumber: number) {
        const pageSize = options.pageSizes.value[pageNumber - 1];
        if (options.isContinuousScroll.value && pageSize) {
            if (options.zoomMode.value === 'fit-width' && pageSize.width > 0) {
                return Math.max(0.1, fitWidthAvailable() / getPageBaseWidth(pageSize));
            }
            if (options.zoomMode.value === 'fit-height') {
                return resolveFitHeightZoomForPageSize(pageSize);
            }
        }

        return effectiveZoom.value;
    }

    function getPageDisplayScale(pageNumber: number) {
        const pageSize = options.pageSizes.value[pageNumber - 1];
        if (!pageSize) {
            return 1;
        }

        return getPageZoom(pageNumber) * getPageCssScale(pageSize);
    }

    const continuousScrollSurfaceWidth = computed(() => {
        if (!options.isContinuousScroll.value) {
            return 0;
        }

        const maxPageWidth = options.pageSizes.value.reduce((maxWidth, pageSize, index) => {
            const scale = getPageDisplayScale(index + 1);
            return Math.max(maxWidth, Math.round(pageSize.width * scale));
        }, 0);

        return Math.max(
            options.containerWidth.value,
            maxPageWidth + DJVU_BASE_MARGIN * 2,
            1,
        );
    });

    function getNeededDeviceWidth(pageNumber: number) {
        const pageSize = options.pageSizes.value[pageNumber - 1];
        if (!pageSize) {
            return 1;
        }

        const cssWidth = Math.max(1, Math.round(pageSize.width * getPageDisplayScale(pageNumber)));
        const devicePixelRatio = typeof window !== 'undefined'
            ? Math.min(window.devicePixelRatio || 1, DJVU_PREVIEW_DEVICE_PIXEL_RATIO_CAP)
            : 1;
        return Math.max(1, Math.ceil(cssWidth * devicePixelRatio));
    }

    function syncHorizontalScrollForZoomMode() {
        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }

        if (options.zoomMode.value === 'fit-width') {
            container.scrollLeft = 0;
            return;
        }

        if (options.zoomMode.value === 'fit-height' && container.scrollWidth <= container.clientWidth) {
            container.scrollLeft = 0;
        }
    }

    return {
        continuousScrollSurfaceWidth,
        effectiveZoom,
        getNeededDeviceWidth,
        getPageDisplayScale,
        syncHorizontalScrollForZoomMode,
    };
};
