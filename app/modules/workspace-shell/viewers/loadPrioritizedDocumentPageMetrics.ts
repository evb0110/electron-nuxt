import type {
    IDocumentPageMetrics,
    IDocumentPageSource,
} from '@app/utils/document-viewer/source/documentPageSource';

const COLD_OPEN_PROVISIONAL_PAGE_METRIC: IDocumentPageMetrics = Object.freeze({
    widthPoints: 612,
    heightPoints: 792,
    rotation: 0,
});

export async function loadInitialDocumentPageMetric(
    source: IDocumentPageSource,
    pageNumber: number,
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    const metric = await source.getPageMetrics(pageNumber, signal);
    signal.throwIfAborted();
    return metric;
}

/**
 * Gives every page a renderable shell immediately while exact metrics hydrate
 * nearest-first. The initial page is the best available document-local shape;
 * cloning avoids later replacement of one page mutating another page's shell.
 */
export function createProvisionalDocumentPageMetrics(
    pageCount: number,
    initialMetric: IDocumentPageMetrics,
) {
    return Array.from({length: pageCount}, () => ({...initialMetric}));
}

export function createColdOpenProvisionalDocumentPageMetrics(requestedPage: number) {
    const pageCount = Math.max(1, Math.trunc(requestedPage));
    return createProvisionalDocumentPageMetrics(pageCount, COLD_OPEN_PROVISIONAL_PAGE_METRIC);
}

export async function hydrateRemainingDocumentPageMetrics(options: {
    source: IDocumentPageSource;
    initialPage: number;
    initialMetric: IDocumentPageMetrics;
    signal: AbortSignal;
    isCurrent: () => boolean;
    getPriorityPage?: () => number;
    loadMetric?: (
        pageNumber: number,
        signal: AbortSignal,
    ) => Promise<IDocumentPageMetrics>;
    onMetric?: (pageNumber: number, metric: IDocumentPageMetrics) => void;
    concurrency?: number;
}) {
    const {
        source,
        initialPage,
        initialMetric,
        signal,
        isCurrent,
        getPriorityPage = () => initialPage,
        loadMetric = (pageNumber, activeSignal) => source.getPageMetrics(pageNumber, activeSignal),
        onMetric,
        concurrency = 8,
    } = options;
    const metrics = createProvisionalDocumentPageMetrics(source.pageCount, initialMetric);
    const remainingPages = new Set(
        Array.from({length: source.pageCount}, (_, index) => index + 1)
            .filter(pageNumber => pageNumber !== initialPage),
    );
    const takeNextPage = () => {
        if (remainingPages.size === 0) {
            return null;
        }
        const requestedPriority = Math.max(
            1,
            Math.min(source.pageCount, Math.trunc(getPriorityPage())),
        );
        if (remainingPages.delete(requestedPriority)) {
            return requestedPriority;
        }
        let selectedPage: number | null = null;
        let selectedDistance = Number.POSITIVE_INFINITY;
        for (const pageNumber of remainingPages) {
            const distance = Math.abs(pageNumber - requestedPriority);
            if (
                distance < selectedDistance
                || distance === selectedDistance && (selectedPage === null || pageNumber < selectedPage)
            ) {
                selectedPage = pageNumber;
                selectedDistance = distance;
            }
        }
        if (selectedPage !== null) {
            remainingPages.delete(selectedPage);
        }
        return selectedPage;
    };
    const workers = Array.from(
        {length: Math.min(remainingPages.size, Math.max(1, Math.trunc(concurrency)))},
        async () => {
            while (remainingPages.size > 0) {
                signal.throwIfAborted();
                if (!isCurrent()) {
                    return;
                }
                const pageNumber = takeNextPage();
                if (pageNumber === null) {
                    return;
                }
                const metric = await loadMetric(pageNumber, signal);
                signal.throwIfAborted();
                if (!isCurrent()) {
                    return;
                }
                metrics[pageNumber - 1] = metric;
                onMetric?.(pageNumber, metric);
            }
        },
    );
    await Promise.all(workers);
    return isCurrent() ? metrics : null;
}
