import type {IDocumentPageMetrics} from '@app/utils/document-viewer/source/documentPageSource';

/**
 * Page metrics are fixed-shape records (two point dimensions and a rotation),
 * so an entry count is a faithful stand-in for a byte budget: the whole cache
 * at its limit is a few tens of kilobytes including the promise wrappers.
 *
 * The budget is several times the largest demand window the rail can ask for
 * (the visible range plus the 700 px virtual overscan plus the current-page
 * neighbours), so every page the rail can currently show stays resident and
 * scrolling back over a chapter still hits. Beyond that the least recently
 * used pages go first, which keeps a 5000-page document from growing the
 * cache without bound.
 *
 * An eviction is cheap: aspect ratios that drive layout are kept by
 * DocumentThumbnailLayout, so re-measuring an evicted page costs one extra
 * getPageMetrics call and never a layout shift.
 */
export const DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT = 256;

export interface IDocumentThumbnailMetricsCache {
    clear(): void;
    delete(pageNumber: number): void;
    /** Reads and marks the page as most recently used. */
    get(pageNumber: number): Promise<IDocumentPageMetrics> | undefined;
    readonly limit: number;
    /** Reads without changing eviction order. */
    peek(pageNumber: number): Promise<IDocumentPageMetrics> | undefined;
    set(pageNumber: number, metrics: Promise<IDocumentPageMetrics>): void;
    readonly size: number;
}

export function createDocumentThumbnailMetricsCache(
    limit: number = DOCUMENT_THUMBNAIL_METRICS_CACHE_LIMIT,
): IDocumentThumbnailMetricsCache {
    const maxEntries = Math.max(1, Math.trunc(limit));
    // Map insertion order is the eviction order: oldest key first.
    const entries = new Map<number, Promise<IDocumentPageMetrics>>();

    function touch(pageNumber: number, metrics: Promise<IDocumentPageMetrics>) {
        entries.delete(pageNumber);
        entries.set(pageNumber, metrics);
    }

    function evictToBudget() {
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next();
            if (oldest.done) {
                return;
            }
            entries.delete(oldest.value);
        }
    }

    return {
        clear() {
            entries.clear();
        },
        delete(pageNumber) {
            entries.delete(pageNumber);
        },
        get(pageNumber) {
            const metrics = entries.get(pageNumber);
            if (metrics === undefined) {
                return undefined;
            }
            touch(pageNumber, metrics);
            return metrics;
        },
        get limit() {
            return maxEntries;
        },
        peek(pageNumber) {
            return entries.get(pageNumber);
        },
        set(pageNumber, metrics) {
            touch(pageNumber, metrics);
            evictToBudget();
        },
        get size() {
            return entries.size;
        },
    };
}
