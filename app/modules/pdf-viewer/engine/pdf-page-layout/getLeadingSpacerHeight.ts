import { clamp } from 'es-toolkit/math';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

export function getLeadingSpacerHeight(
    layout: IPdfPageLayoutMetrics,
    hiddenPages: number,
) {
    const clampedHiddenPages = clamp(hiddenPages, 0, layout.totalPages);
    if (clampedHiddenPages === 0) {
        return 0;
    }

    return (layout.pageHeightPrefixSums[clampedHiddenPages - 1] ?? 0)
        + Math.max(0, clampedHiddenPages - 1) * layout.gap;
}
