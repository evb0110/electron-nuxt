import type { IUsePdfSinglePageScrollOptions } from '@app/modules/pdf-viewer/runtime/navigation/pdfSinglePageScrollTypes';

export function createPdfNavigationCommitters(options: IUsePdfSinglePageScrollOptions) {
    const commitVisibleRangeValue = (
        range: {
            start: number;
            end: number
        },
        transactionId?: number,
    ) => {
        const didCommit = options.commitVisibleRange?.(
            range,
            transactionId !== undefined ? { transactionId } : undefined,
        );
        if (didCommit !== undefined) {
            return didCommit;
        }
        options.visibleRange.value = range;
        return true;
    };

    const commitCurrentPageValue = (
        page: number,
        previousPage = options.currentPage.value,
        transactionId?: number,
    ) => {
        const didCommit = options.commitCurrentPage?.(page, {
            previousPage,
            ...(transactionId !== undefined ? { transactionId } : {}),
        });
        if (didCommit !== undefined) {
            return didCommit;
        }
        options.currentPage.value = page;
        if (page !== previousPage) {
            options.emitCurrentPage(page);
        }
        return true;
    };

    return {
        commitCurrentPageValue,
        commitVisibleRangeValue,
    };
}
