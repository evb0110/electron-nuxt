import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@app/types/editorPanes';
import type { ITab } from '@app/types/tabs';
import { collectLayoutPaneOrder } from '@app/modules/workspace-shell/window-tabs/collectLayoutPaneOrder';

export function collectMergeTabOrder(
    layout: TEditorLayoutNode | null,
    panes: IEditorPaneState[],
    tabs: ITab[],
) {
    const orderedPaneIds = collectLayoutPaneOrder(layout);
    const seenTabIds = new Set<string>();
    const orderedTabIds: string[] = [];

    for (const paneId of orderedPaneIds) {
        const pane = panes.find(candidate => candidate.paneId === paneId);
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
