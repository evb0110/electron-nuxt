import type {Ref} from 'vue';
import type {TPdfViewMode} from '@contracts/shared';
import type {IPageRange} from '@app/types/pdfUi';
import {getPageRowBoundsForViewMode} from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import {
    isPdfVisibleRenderRangeCurrent,
    resolvePdfProtectedVisibleRange,
} from '@app/modules/pdf-viewer/engine/pdf-visible-render-range-policy/isPdfVisibleRenderRangeCurrent';

interface ICreatePdfNavigationLayoutAuthorityOptions {
    computeFitScale: (pageNumber: number) => void;
    ensurePageMetricsInRange: (startPage: number, endPage: number) => Promise<boolean>;
    getNavigationTargetPage: () => number | null;
    numPages: Ref<number>;
    setupPagePlaceholders: () => void;
    viewMode: Ref<TPdfViewMode>;
    visibleRange: Ref<IPageRange>;
    zoomMode: Ref<'custom' | 'fit-width' | 'fit-height'>;
}

export function createPdfNavigationLayoutAuthority(
    options: ICreatePdfNavigationLayoutAuthorityOptions,
) {
    function getProtectedVisibleRange() {
        return resolvePdfProtectedVisibleRange({
            visibleRange: options.visibleRange.value,
            navigationTargetPage: options.getNavigationTargetPage(),
            viewMode: options.viewMode.value,
            totalPages: options.numPages.value,
        });
    }

    function isVisibleRenderRangeCurrent(range: IPageRange) {
        return isPdfVisibleRenderRangeCurrent({
            range,
            visibleRange: options.visibleRange.value,
            navigationTargetPage: options.getNavigationTargetPage(),
            viewMode: options.viewMode.value,
            totalPages: options.numPages.value,
        });
    }

    async function prepareNavigationLayout(
        pageNumber: number,
        signal: AbortSignal,
    ) {
        const range = getPageRowBoundsForViewMode({
            pageNumber,
            viewMode: options.viewMode.value,
            totalPages: options.numPages.value,
        });
        await options.ensurePageMetricsInRange(range.start, range.end);
        if (signal.aborted || options.zoomMode.value === 'custom') {
            return;
        }
        options.computeFitScale(pageNumber);
        options.setupPagePlaceholders();
        await nextTick();
    }

    return {
        getProtectedVisibleRange,
        isVisibleRenderRangeCurrent,
        prepareNavigationLayout,
    };
}
