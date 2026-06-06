import { clamp } from 'es-toolkit/math';
import type { IPdfPageLayoutMetrics } from '@app/utils/pdf-viewer/pdf-page-layout/pdfPageLayoutTypes';

export function getTrailingSpacerHeight(
    layout: IPdfPageLayoutMetrics,
    hiddenPages: number,
) {
    const clampedHiddenPages = clamp(hiddenPages, 0, layout.totalPages);
    if (clampedHiddenPages === 0) {
        return 0;
    }

    return (
        (layout.pageHeightPrefixSums[layout.totalPages - 1] ?? 0)
        - (layout.pageHeightPrefixSums[layout.totalPages - clampedHiddenPages - 1] ?? 0)
    )
        + Math.max(0, clampedHiddenPages - 1) * layout.gap;
}
