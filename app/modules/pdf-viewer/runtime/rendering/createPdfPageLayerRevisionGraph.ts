type TPdfPageLayer = 'base' | 'text' | 'annotations' | 'thumbnail';

export function createPdfPageLayerRevisionGraph() {
    const revisions = new Map<number, Record<TPdfPageLayer, number>>();
    const get = (page: number) => revisions.get(page) ?? {
        base: 0,
        text: 0,
        annotations: 0,
        thumbnail: 0,
    };
    function bump(page: number, layer: TPdfPageLayer) {
        const current = get(page);
        const next = {
            ...current,
            [layer]: current[layer] + 1,
            ...(layer === 'annotations' ? {thumbnail: current.thumbnail + 1} : {}),
        };
        revisions.set(page, next);
        return next[layer];
    }
    return {
        get,
        bump,
        clear: () => revisions.clear(),
        key(page: number, layer: TPdfPageLayer) {
            return `${page}:${layer}:${get(page)[layer]}`;
        },
    };
}
