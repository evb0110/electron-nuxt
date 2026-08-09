interface INativePdfRenderQueueOptions {
    activePage: number;
    activePages: Iterable<number>;
    deferAdjacentPages: boolean;
}

export function resolveNativePdfRenderQueue(options: INativePdfRenderQueueOptions) {
    return [...options.activePages]
        .filter(pageNumber => !options.deferAdjacentPages || pageNumber === options.activePage)
        .sort((left, right) => (
            Math.abs(left - options.activePage) - Math.abs(right - options.activePage)
        ));
}
