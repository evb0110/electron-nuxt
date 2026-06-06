export function shouldRenderPageWithPreservedState(options: {
    pageNumber: number;
    renderedPages: ReadonlySet<number>;
    staleRenderedPages: ReadonlySet<number>;
    forceRerender: boolean;
    hasMountedCanvas: (pageNumber: number) => boolean;
}) {
    if (options.forceRerender || options.staleRenderedPages.has(options.pageNumber)) {
        return true;
    }

    if (!options.renderedPages.has(options.pageNumber)) {
        return true;
    }

    return !options.hasMountedCanvas(options.pageNumber);
}
