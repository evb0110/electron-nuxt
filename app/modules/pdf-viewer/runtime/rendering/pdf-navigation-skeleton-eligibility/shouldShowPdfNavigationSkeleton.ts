import type { TPdfViewMode } from '@contracts/shared';
import { getPageRowBoundsForViewMode } from '@app/utils/pdf-viewer/pdf-page-layout/getPageRowBoundsForViewMode';

interface IShouldShowPdfNavigationSkeletonOptions {
    pageNumber: number;
    navigationAnchorPage: number | null;
    totalPages: number;
    viewMode: TPdfViewMode;
    isPageRendered: (pageNumber: number) => boolean;
    shouldShowSkeleton: (pageNumber: number) => boolean;
}

export function shouldShowPdfNavigationSkeleton(options: IShouldShowPdfNavigationSkeletonOptions) {
    if (options.shouldShowSkeleton(options.pageNumber)) {
        return true;
    }

    if (
        options.navigationAnchorPage === null
        || options.totalPages <= 0
        || options.isPageRendered(options.pageNumber)
    ) {
        return false;
    }

    const rowBounds = getPageRowBoundsForViewMode({
        pageNumber: options.navigationAnchorPage,
        viewMode: options.viewMode,
        totalPages: options.totalPages,
    });

    return options.pageNumber >= rowBounds.start && options.pageNumber <= rowBounds.end;
}
