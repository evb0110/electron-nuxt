import { union } from 'es-toolkit/array';

export function collectPreservedRenderPageNumbers(options: {
    renderedPages: Iterable<number>;
    pageCanvases: ReadonlyMap<number, unknown>;
}) {
    return new Set(union(
        [...options.renderedPages],
        [...options.pageCanvases.keys()],
    ));
}
