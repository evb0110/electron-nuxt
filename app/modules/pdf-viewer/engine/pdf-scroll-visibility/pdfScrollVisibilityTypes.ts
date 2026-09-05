import type { TPageNumber } from '@contracts/pageNumbers';



export interface IVisiblePageRange {
    start: TPageNumber;
    end: TPageNumber;
}

export interface IViewportVisibilityResult {
    range: IVisiblePageRange | null;
    mostVisiblePage: TPageNumber | null;
}

export interface IPageScrollBounds {
    min: number;
    max: number;
}

export interface IVisiblePageDebugEntry {
    pageNumber: TPageNumber;
    pageTop: number;
    pageBottom: number;
    pageHeight: number;
    visibleTop: number;
    visibleBottom: number;
    visibleHeight: number;
}
