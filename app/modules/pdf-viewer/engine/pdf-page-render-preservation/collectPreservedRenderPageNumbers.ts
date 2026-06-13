import { union } from 'es-toolkit/array';

export function collectPreservedRenderPageNumbers(options: {
    renderedPages: ReadonlySet<number>;
    pageCanvases: ReadonlyMap<number, unknown>;
}) {
    return new Set(union(
        [...options.renderedPages],
        [...options.pageCanvases.keys()],
    ));
}
