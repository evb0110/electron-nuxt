interface IBuildThumbnailRenderQueueOptions {
    totalPages: number;
    currentPage: number;
    visiblePages: readonly number[];
    renderedPages: ReadonlySet<number>;
    renderingPages: ReadonlySet<number>;
    immediateRenderRadius: number;
    prefetchRenderRadius: number;
}

function normalizePageNumber(page: number, totalPages: number) {
    if (totalPages <= 0) {
        return 0;
    }

    return Math.max(1, Math.min(totalPages, Math.trunc(page)));
}

export function buildThumbnailRenderQueue(
    options: IBuildThumbnailRenderQueueOptions,
) {
    const totalPages = Math.max(0, Math.trunc(options.totalPages));
    if (totalPages <= 0) {
        return [] as number[];
    }

    const currentPage = normalizePageNumber(options.currentPage, totalPages);
    const queue: number[] = [];
    const seen = new Set<number>();

    const push = (page: number) => {
        const normalizedPage = normalizePageNumber(page, totalPages);
        if (
            normalizedPage <= 0
            || seen.has(normalizedPage)
            || options.renderedPages.has(normalizedPage)
            || options.renderingPages.has(normalizedPage)
        ) {
            return;
        }

        seen.add(normalizedPage);
        queue.push(normalizedPage);
    };

    const pushRange = (start: number, end: number) => {
        for (let page = start; page <= end; page += 1) {
            push(page);
        }
    };

    push(currentPage);

    const normalizedVisiblePages = options.visiblePages
        .map(page => normalizePageNumber(page, totalPages))
        .filter(page => page > 0);

    for (const page of normalizedVisiblePages) {
        push(page);
    }

    pushRange(
        currentPage - options.immediateRenderRadius,
        currentPage + options.immediateRenderRadius,
    );

    if (normalizedVisiblePages.length > 0) {
        const firstVisible = normalizedVisiblePages[0]!;
        const lastVisible = normalizedVisiblePages[normalizedVisiblePages.length - 1]!;
        pushRange(
            firstVisible - options.immediateRenderRadius,
            lastVisible + options.immediateRenderRadius,
        );
    }

    pushRange(
        currentPage - options.prefetchRenderRadius,
        currentPage + options.prefetchRenderRadius,
    );

    return queue;
}
