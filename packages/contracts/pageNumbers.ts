declare const pageIndexBrand: unique symbol;
declare const pageNumberBrand: unique symbol;

export type TPageIndex = number & {readonly [pageIndexBrand]: 'TPageIndex'};
export type TPageNumber = number & {readonly [pageNumberBrand]: 'TPageNumber'};

export function toPageIndex(value: number): TPageIndex {
    return value as TPageIndex;
}

export function toPageNumber(value: number): TPageNumber {
    return value as TPageNumber;
}

export function parsePageIndex(value: number, pageCount?: number): TPageIndex | null {
    if (!Number.isSafeInteger(value) || value < 0) {
        return null;
    }
    if (pageCount !== undefined && value >= pageCount) {
        return null;
    }
    return toPageIndex(value);
}

export function parsePageNumber(value: number, pageCount?: number): TPageNumber | null {
    if (!Number.isSafeInteger(value) || value < 1) {
        return null;
    }
    if (pageCount !== undefined && value > pageCount) {
        return null;
    }
    return toPageNumber(value);
}

export function pageIndexToPageNumber(pageIndex: TPageIndex): TPageNumber {
    return toPageNumber(pageIndex + 1);
}

export function pageNumberToPageIndex(pageNumber: TPageNumber): TPageIndex {
    return toPageIndex(pageNumber - 1);
}
