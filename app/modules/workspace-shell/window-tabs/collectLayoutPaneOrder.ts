import type { TEditorLayoutNode } from '@app/types/editorPanes';

export function collectLayoutPaneOrder(node: TEditorLayoutNode | null): string[] {
    if (!node) {
        return [];
    }

    if (node.type === 'leaf') {
        return [node.paneId];
    }

    return [
        ...collectLayoutPaneOrder(node.first),
        ...collectLayoutPaneOrder(node.second),
    ];
}
