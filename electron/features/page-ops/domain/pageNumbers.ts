import { range } from 'es-toolkit/math';

export function formatPageRange(pages: number[]) {
    const sorted = [...pages].sort((a, b) => a - b);
    const parts: string[] = [];
    let i = 0;
    while (i < sorted.length) {
        const start = sorted[i]!;
        let end = start;
        while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
            end = sorted[++i]!;
        }
        parts.push(start === end ? `${start}` : `${start}-${end}`);
        i++;
    }
    return `p${parts.join(',')}`;
}

function isValidPageNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isPageWithinTotalPages(page: number, totalPages: unknown) {
    return (
        typeof totalPages !== 'number'
        || !Number.isInteger(totalPages)
        || totalPages <= 0
        || page <= totalPages
    );
}

export function validatePageNumbers(
    pages: unknown,
    label: string,
    options: {
        totalPages?: number;
        requireUnique?: boolean;
    } = {},
): asserts pages is number[] {
    if (!Array.isArray(pages) || pages.length === 0) {
        throw new Error(`${label}: must be a non-empty array of page numbers`);
    }

    const pageSet = new Set<number>();
    const pageCandidates: unknown[] = pages;
    for (const p of pageCandidates) {
        if (!isValidPageNumber(p)) {
            throw new Error(`${label}: invalid page number ${p}`);
        }
        if (!isPageWithinTotalPages(p, options.totalPages)) {
            throw new Error(`${label}: page number ${p} is out of range 1-${options.totalPages}`);
        }
        if (options.requireUnique && pageSet.has(p)) {
            throw new Error(`${label}: duplicate page number ${p}`);
        }
        pageSet.add(p);
    }
}

export function validateReorderPermutation(newOrder: number[]) {
    const maxPage = newOrder.length;
    const pageSet = new Set(newOrder);
    for (const pageNumber of range(1, maxPage + 1)) {
        if (!pageSet.has(pageNumber)) {
            throw new Error(`reorderPages: missing page ${pageNumber} in reorder payload`);
        }
    }
}
