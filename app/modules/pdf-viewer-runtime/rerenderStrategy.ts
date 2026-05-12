interface IPageRange {
    start: number;
    end: number;
}

const PRESERVE_EXISTING_RENDER_SOURCES = new Set([
    'zoom-change',
    'zoom-settle',
    'fit-mode',
]);

const RESIZE_RERENDER_SOURCES = new Set([
    'resize-observer',
    'resize-settle',
]);

const ANCHORED_CURRENT_PAGE_SYNC_SOURCES = new Set([
    ...RESIZE_RERENDER_SOURCES,
    'zoom-change',
    'zoom-settle',
]);

export function isResizeRerenderSource(source: string) {
    return RESIZE_RERENDER_SOURCES.has(source);
}

export function isAnchoredCurrentPageSyncSource(source: string) {
    return ANCHORED_CURRENT_PAGE_SYNC_SOURCES.has(source);
}

export function hasRenderedPageInRange(
    visibleRange: IPageRange,
    isPageRendered: (page: number) => boolean,
) {
    const start = Math.max(1, Math.trunc(visibleRange.start));
    const end = Math.max(start, Math.trunc(visibleRange.end));

    for (let page = start; page <= end; page += 1) {
        if (isPageRendered(page)) {
            return true;
        }
    }

    return false;
}

export function shouldPreserveExistingRerenderContent(options: {
    source: string;
    visibleRange: IPageRange;
    isPageRendered: (page: number) => boolean;
}) {
    const { source } = options;

    if (PRESERVE_EXISTING_RENDER_SOURCES.has(source)) {
        return true;
    }

    if (!isResizeRerenderSource(source)) {
        return false;
    }

    return true;
}
