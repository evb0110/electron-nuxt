import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import {
    getLayoutPageTop,
    getLayoutRowHeight,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

/**
 * Returns the physical spacer height between two non-contiguous mounted rows.
 *
 * The page track owns a CSS gap between every pair of direct children. An
 * inter-segment spacer is itself a child, so the browser contributes one gap
 * before it and another after it. Those two gaps already belong to the
 * analytical distance between the mounted rows and must not be counted again
 * in the spacer box.
 */
export function getInterSegmentSpacerHeight(
    layout: IPdfPageLayoutMetrics,
    previousVisiblePage: number,
    nextVisiblePage: number,
) {
    if (
        !Number.isFinite(previousVisiblePage)
        || !Number.isFinite(nextVisiblePage)
        || previousVisiblePage < 1
        || nextVisiblePage <= previousVisiblePage
    ) {
        return 0;
    }

    const previousPageIndex = Math.min(layout.base.totalPages, Math.floor(previousVisiblePage)) - 1;
    const nextPageIndex = Math.min(layout.base.totalPages, Math.floor(nextVisiblePage)) - 1;
    const previousRowIndex = layout.base.pageRowIndices[previousPageIndex] ?? -1;
    const nextRowIndex = layout.base.pageRowIndices[nextPageIndex] ?? -1;
    if (previousRowIndex < 0 || nextRowIndex <= previousRowIndex) {
        return 0;
    }

    const previousTop = getLayoutPageTop(layout, previousPageIndex) ?? 0;
    const previousHeight = getLayoutRowHeight(layout, previousRowIndex);
    const nextTop = getLayoutPageTop(layout, nextPageIndex) ?? previousTop + previousHeight;
    return Math.max(
        0,
        nextTop - previousTop - previousHeight - 2 * layout.gap,
    );
}
