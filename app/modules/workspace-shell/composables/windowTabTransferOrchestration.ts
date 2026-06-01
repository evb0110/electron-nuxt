import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@app/types/editorPanes';
import type { ITab } from '@app/types/tabs';

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

export function collectMergeTabOrder(
    layout: TEditorLayoutNode | null,
    panes: IEditorPaneState[],
    tabs: ITab[],
) {
    const orderedPaneIds = collectLayoutPaneOrder(layout);
    const seenTabIds = new Set<string>();
    const orderedTabIds: string[] = [];

    for (const paneId of orderedPaneIds) {
        const pane = panes.find(candidate => candidate.id === paneId);
        if (!pane) {
            continue;
        }

        for (const tabId of pane.tabIds) {
            if (seenTabIds.has(tabId)) {
                continue;
            }
            seenTabIds.add(tabId);
            orderedTabIds.push(tabId);
        }
    }

    for (const tab of tabs) {
        if (seenTabIds.has(tab.id)) {
            continue;
        }

        seenTabIds.add(tab.id);
        orderedTabIds.push(tab.id);
    }

    return orderedTabIds;
}

export function shouldCloseSourceWindowAfterTransfer(
    tabCountBeforeTransfer: number,
    hasElectronBridge: boolean,
) {
    return hasElectronBridge && tabCountBeforeTransfer <= 1;
}
