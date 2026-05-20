export function collectPreservedRenderPageNumbers(options: {
    renderedPages: ReadonlySet<number>;
    pageCanvases: ReadonlyMap<number, unknown>;
}) {
    const pages = new Set<number>();
    options.renderedPages.forEach(pageNumber => pages.add(pageNumber));
    options.pageCanvases.forEach((_, pageNumber) => pages.add(pageNumber));
    return pages;
}

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
