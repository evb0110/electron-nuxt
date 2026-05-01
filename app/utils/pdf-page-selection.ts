import { uniq } from 'es-toolkit/array';
import type { IPdfPageRange } from '@app/types/pdf';

export function normalizeSelectedPageNumbers(selectedPages: number[], totalPages: number): number[] {
    return uniq(selectedPages)
        .filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages)
        .sort((left, right) => left - right);
}

export function expandPageRange(range: IPdfPageRange | null): number[] | null {
    if (!range) {
        return null;
    }

    const pages: number[] = [];
    for (let page = range.startPage; page <= range.endPage; page += 1) {
        pages.push(page);
    }
    return pages;
}

export function createAllPageNumbers(totalPages: number): number[] {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
}
