import { usePdfSinglePageScroll } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageScroll';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

type TUsePdfSinglePageScrollOptions = Parameters<typeof usePdfSinglePageScroll>[0];

interface IUsePdfSinglePageNavigationControllerOptions extends TUsePdfSinglePageScrollOptions {
    requestedCurrentPage: Ref<number | undefined>;
    viewerContainer: Ref<HTMLElement | null>;
    cancelPendingSearchScroll: () => void;
}

export const usePdfSinglePageNavigationController = (options: IUsePdfSinglePageNavigationControllerOptions) => {
    const singlePageScroll = usePdfSinglePageScroll(options);

    const navigationAnchorPage = computed(() =>
        singlePageScroll.pagedNavigationTargetPage.value
        ?? singlePageScroll.searchNavigationTargetPage.value
        ?? singlePageScroll.continuousNavigationTargetPage.value,
    );

    watch(
        [
            options.requestedCurrentPage,
            options.numPages,
            options.viewerContainer,
        ],
        ([pageNumber]) => {
            if (
                typeof pageNumber !== 'number'
                || !Number.isFinite(pageNumber)
                || options.numPages.value <= 0
                || !options.viewerContainer.value
            ) {
                return;
            }

            const targetPage = Math.min(
                Math.max(Math.trunc(pageNumber), 1),
                options.numPages.value,
            );
            if (targetPage === options.currentPage.value) {
                logPdfRenderTrace('viewer-requested-current-page-skip', {
                    requestedPage: pageNumber,
                    targetPage,
                    viewerCurrentPage: options.currentPage.value,
                });
                return;
            }

            logPdfRenderTrace('viewer-requested-current-page-scroll', {
                requestedPage: pageNumber,
                targetPage,
                viewerCurrentPage: options.currentPage.value,
                visibleRange: {
                    start: options.visibleRange.value.start,
                    end: options.visibleRange.value.end,
                },
            });
            options.cancelPendingSearchScroll();
            singlePageScroll.scrollToPage(targetPage);
        },
        {
            flush: 'post',
            immediate: true,
        },
    );

    return {
        ...singlePageScroll,
        navigationAnchorPage,
    };
};
