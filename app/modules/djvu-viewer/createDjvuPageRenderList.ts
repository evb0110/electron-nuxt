export type TDjvuScrollDirection = -1 | 0 | 1;

export interface ICreateDjvuPageRenderListOptions {
    anchorPage: number;
    direction?: TDjvuScrollDirection;
    endPage: number;
    prefetchPages: number;
    startPage: number;
    totalPages: number;
}

function clampPage(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function normalizePositiveInteger(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : fallback;
}

function addPage(pageNumbers: number[], pageNumber: number, startPage: number, endPage: number) {
    if (pageNumber < startPage || pageNumber > endPage || pageNumbers.includes(pageNumber)) {
        return;
    }

    pageNumbers.push(pageNumber);
}

function addPagesInDirection(
    pageNumbers: number[],
    firstPage: number,
    direction: -1 | 1,
    startPage: number,
    endPage: number,
) {
    for (
        let pageNumber = firstPage;
        pageNumber >= startPage && pageNumber <= endPage;
        pageNumber += direction
    ) {
        addPage(pageNumbers, pageNumber, startPage, endPage);
    }
}

function addPagesAroundAnchor(
    pageNumbers: number[],
    anchorPage: number,
    startPage: number,
    endPage: number,
) {
    const maxDistance = Math.max(anchorPage - startPage, endPage - anchorPage);

    for (let distance = 1; distance <= maxDistance; distance += 1) {
        addPage(pageNumbers, anchorPage + distance, startPage, endPage);
        addPage(pageNumbers, anchorPage - distance, startPage, endPage);
    }
}

export function createDjvuPageRenderList(options: ICreateDjvuPageRenderListOptions) {
    const totalPages = normalizePositiveInteger(options.totalPages, 0);
    if (totalPages <= 0) {
        return [] as number[];
    }

    const prefetchPages = Math.max(0, Math.trunc(options.prefetchPages));
    const baseStart = clampPage(Math.min(options.startPage, options.endPage), 1, totalPages);
    const baseEnd = clampPage(Math.max(options.startPage, options.endPage), 1, totalPages);
    const startPage = clampPage(baseStart - prefetchPages, 1, totalPages);
    const endPage = clampPage(baseEnd + prefetchPages, 1, totalPages);
    const anchorPage = clampPage(options.anchorPage, startPage, endPage);
    const direction = options.direction ?? 0;
    const pageNumbers: number[] = [];

    addPage(pageNumbers, anchorPage, startPage, endPage);

    if (direction === 0) {
        addPagesAroundAnchor(pageNumbers, anchorPage, startPage, endPage);
        return pageNumbers;
    }

    const oppositeDirection = direction === 1 ? -1 : 1;
    addPage(pageNumbers, anchorPage + direction, startPage, endPage);
    addPage(pageNumbers, anchorPage + oppositeDirection, startPage, endPage);
    addPagesInDirection(pageNumbers, anchorPage + direction * 2, direction, startPage, endPage);
    addPagesInDirection(pageNumbers, anchorPage + oppositeDirection * 2, oppositeDirection, startPage, endPage);

    return pageNumbers;
}
