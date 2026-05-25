import { uniq } from 'es-toolkit/array';
import type { IPdfPageRange } from '@app/types/pdf';

export interface IPageThumbnailClickModifiers {
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
}

export function shouldSelectPageFromThumbnailClick(modifiers: IPageThumbnailClickModifiers): boolean {
    return Boolean(modifiers.shiftKey || modifiers.metaKey || modifiers.ctrlKey);
}

export function resolveThumbnailContextMenuPages(
    page: number,
    selectedPages: number[],
    totalPages: number,
) {
    const normalizedSelection = normalizeSelectedPageNumbers(selectedPages, totalPages);
    if (normalizedSelection.includes(page)) {
        return normalizedSelection;
    }

    return normalizeSelectedPageNumbers([page], totalPages);
}

export function normalizeSelectedPageNumbers(selectedPages: number[], totalPages: number): number[] {
    return uniq(selectedPages)
        .filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages)
        .sort((left, right) => left - right);
}

export function arePageNumberListsEqual(left: number[], right: number[]) {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((value, index) => value === right[index]);
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
