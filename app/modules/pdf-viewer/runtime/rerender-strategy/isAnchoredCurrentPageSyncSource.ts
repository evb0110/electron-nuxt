const RESIZE_RERENDER_SOURCES = new Set([
    'resize-observer',
    'resize-settle',
]);

const ANCHORED_CURRENT_PAGE_SYNC_SOURCES = new Set([
    ...RESIZE_RERENDER_SOURCES,
    'zoom-change',
    'zoom-gesture-change',
    'zoom-settle',
    'fit-width-current-page',
]);

export function isAnchoredCurrentPageSyncSource(source: string) {
    return ANCHORED_CURRENT_PAGE_SYNC_SOURCES.has(source);
}
