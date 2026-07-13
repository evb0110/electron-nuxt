import { clamp } from 'es-toolkit/math';

interface IBuildThumbnailRenderQueueOptions {
    totalPages: number;
    currentPage: number;
    visiblePages: readonly number[];
    mountedPages?: readonly number[] | undefined;
    renderedPages: ReadonlySet<number>;
    renderingPages: ReadonlySet<number>;
    immediateRenderRadius: number;
    prefetchRenderRadius: number;
}

function normalizePageNumber(page: number, totalPages: number) {
    if (totalPages <= 0) {
        return 0;
    }

    return clamp(Math.trunc(page), 1, totalPages);
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

    const pushSymmetric = (center: number, radius: number) => {
        for (let distance = 1; distance <= radius; distance += 1) {
            push(center - distance);
            push(center + distance);
        }
    };

    const pushByDistance = (pages: readonly number[], anchor: number) => {
        const sortedPages = [...pages].sort((left, right) => (
            Math.abs(left - anchor) - Math.abs(right - anchor)
            || left - right
        ));
        for (const page of sortedPages) {
            push(page);
        }
    };

    push(currentPage);
    pushSymmetric(currentPage, options.immediateRenderRadius);

    const normalizedVisiblePages = options.visiblePages
        .map(page => normalizePageNumber(page, totalPages))
        .filter(page => page > 0);

    pushByDistance(normalizedVisiblePages, currentPage);

    if (normalizedVisiblePages.length > 0) {
        const firstVisible = normalizedVisiblePages[0]!;
        const lastVisible = normalizedVisiblePages[normalizedVisiblePages.length - 1]!;
        const expandedVisiblePages = Array.from(
            {length: lastVisible - firstVisible + 1 + options.immediateRenderRadius * 2},
            (_, index) => firstVisible - options.immediateRenderRadius + index,
        );
        pushByDistance(expandedVisiblePages, currentPage);
    }

    pushSymmetric(currentPage, options.prefetchRenderRadius);
    pushByDistance(options.mountedPages ?? [], currentPage);

    return queue;
}
