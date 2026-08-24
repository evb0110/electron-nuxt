import type { TPdfViewMode } from '@contracts/shared';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';

interface IShouldShowPdfNavigationSkeletonOptions {
    pageNumber: number;
    navigationAnchorPage: number | null;
    totalPages: number;
    viewMode: TPdfViewMode;
    isPageRendered: (pageNumber: number) => boolean;
    shouldShowSkeleton: (pageNumber: number) => boolean;
}

export function shouldShowPdfNavigationSkeleton(options: IShouldShowPdfNavigationSkeletonOptions) {
    if (options.isPageRendered(options.pageNumber)) {
        return false;
    }

    if (
        options.navigationAnchorPage === null
        || options.totalPages <= 0
    ) {
        return options.shouldShowSkeleton(options.pageNumber);
    }

    const rowBounds = getPageRowBoundsForViewMode({
        pageNumber: options.navigationAnchorPage,
        viewMode: options.viewMode,
        totalPages: options.totalPages,
    });

    // The committed page remains visible while the destination row paints.
    // Do not let ordinary near-viewport skeletons from adjacent buffered rows
    // appear at the edge when the atomic viewport write lands.
    return options.pageNumber >= rowBounds.start && options.pageNumber <= rowBounds.end;
}
