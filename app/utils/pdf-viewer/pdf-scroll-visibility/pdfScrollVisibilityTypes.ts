

export interface IVisiblePageRange {
    start: number;
    end: number;
}

export interface IViewportVisibilityResult {
    range: IVisiblePageRange | null;
    mostVisiblePage: number | null;
}

export interface IPageScrollBounds {
    min: number;
    max: number;
}

export interface IVisiblePageDebugEntry {
    pageNumber: number;
    pageTop: number;
    pageBottom: number;
    pageHeight: number;
    visibleTop: number;
    visibleBottom: number;
    visibleHeight: number;
}
