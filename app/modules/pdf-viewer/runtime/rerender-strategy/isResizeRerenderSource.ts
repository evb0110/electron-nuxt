const RESIZE_RERENDER_SOURCES = new Set([
    'resize-observer',
    'resize-settle',
]);

export function isResizeRerenderSource(source: string) {
    return RESIZE_RERENDER_SOURCES.has(source);
}
