export function collectPreservedRenderPageNumbers(options: {
    renderedPages: ReadonlySet<number>;
    pageCanvases: ReadonlyMap<number, unknown>;
}) {
    const pages = new Set<number>();
    options.renderedPages.forEach(pageNumber => pages.add(pageNumber));
    options.pageCanvases.forEach((_, pageNumber) => pages.add(pageNumber));
    return pages;
}
