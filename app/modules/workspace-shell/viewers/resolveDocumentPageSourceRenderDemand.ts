export interface IDocumentPageSourceRenderDemandOptions {
    bufferRadius?: number;
    continuousScroll: boolean;
    currentPage: number;
    pageCount: number;
    pageHeights: readonly number[];
    pageTops: readonly number[];
    scrollTop: number;
    viewportHeight: number;
}
export interface IDocumentPageSourceRenderDemand {
    bufferPages: number[];
    residentPages: number[];
    visiblePages: number[];
}

function normalizePage(pageNumber: number, pageCount: number) {
    return Math.max(1, Math.min(pageCount, Math.trunc(pageNumber)));
}

/**
 * Keeps geometry virtualization independent from raster residency. The page
 * source may mount a broad positional window, but only viewport pages and a
 * short contiguous guard band own decoded full-page surfaces.
 */
export function resolveDocumentPageSourceRenderDemand(
    options: IDocumentPageSourceRenderDemandOptions,
): IDocumentPageSourceRenderDemand {
    const pageCount = Math.max(0, Math.trunc(options.pageCount));
    if (pageCount === 0) {
        return {
            bufferPages: [],
            residentPages: [],
            visiblePages: [],
        };
    }

    const currentPage = normalizePage(options.currentPage, pageCount);
    const visiblePages = options.continuousScroll
        ? Array.from({length: pageCount}, (_, index) => index + 1).filter((pageNumber) => {
            const top = options.pageTops[pageNumber - 1];
            const height = options.pageHeights[pageNumber - 1];
            return top !== undefined
                && height !== undefined
                && top + height > options.scrollTop
                && top < options.scrollTop + Math.max(1, options.viewportHeight);
        })
        : [currentPage];
    if (!visiblePages.includes(currentPage)) {
        visiblePages.push(currentPage);
        visiblePages.sort((left, right) => left - right);
    }

    const visibleSet = new Set(visiblePages);
    const bufferSet = new Set<number>();
    const bufferRadius = Math.max(0, Math.trunc(options.bufferRadius ?? 1));
    for (const pageNumber of visiblePages) {
        for (let distance = 1; distance <= bufferRadius; distance += 1) {
            const before = pageNumber - distance;
            const after = pageNumber + distance;
            if (before >= 1 && !visibleSet.has(before)) bufferSet.add(before);
            if (after <= pageCount && !visibleSet.has(after)) bufferSet.add(after);
        }
    }
    const bufferPages = [...bufferSet].sort((left, right) => left - right);

    return {
        bufferPages,
        residentPages: [
            ...visiblePages,
            ...bufferPages,
        ].sort((left, right) => left - right),
        visiblePages,
    };
}
