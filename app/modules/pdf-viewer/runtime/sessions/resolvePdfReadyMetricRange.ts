import {clamp} from 'es-toolkit/math';
import {PDF_PAGE_METRICS_DENSE_LIMIT} from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';

/**
 * A dense-document reload historically hydrated the metric prefix from page
 * one through the restored page. Large documents use sparse geometry instead,
 * so reopening one must measure only the restored page. The layout fallback
 * supplies the other pages until they enter a bounded viewport range.
 */
export function resolvePdfReadyMetricRange(input: {
    currentPage: number;
    totalPages: number;
    isReload: boolean;
    isSelectiveReload: boolean;
}) {
    const totalPages = Math.max(0, Math.trunc(input.totalPages));
    if (totalPages === 0) {
        return {
            start: 0,
            end: 0,
        };
    }

    const currentPage = clamp(Math.trunc(input.currentPage), 1, totalPages);
    const hydrateReloadPrefix = input.isReload
        && !input.isSelectiveReload
        && currentPage > 1
        && totalPages <= PDF_PAGE_METRICS_DENSE_LIMIT;

    return {
        start: hydrateReloadPrefix ? 1 : currentPage,
        end: currentPage,
    };
}
