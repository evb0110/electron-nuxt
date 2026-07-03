import { uniq } from 'es-toolkit/array';
import { range as createRange } from 'es-toolkit/math';
import type { IPdfPageRange } from '@app/types/pdfUi';

export interface IPageThumbnailClickModifiers {
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
}

export function shouldSelectPageFromThumbnailClick(modifiers: IPageThumbnailClickModifiers) {
    return modifiers.shiftKey === true || modifiers.metaKey === true || modifiers.ctrlKey === true;
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

    return createRange(range.startPage, range.endPage + 1);
}

export function createAllPageNumbers(totalPages: number): number[] {
    return createRange(1, totalPages + 1);
}
