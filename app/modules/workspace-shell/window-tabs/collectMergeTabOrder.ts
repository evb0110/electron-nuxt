import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@app/types/editorPanes';
import type { ITab } from '@app/types/tabs';
import { uniq } from 'es-toolkit/array';
import { collectLayoutPaneOrder } from '@app/modules/workspace-shell/window-tabs/collectLayoutPaneOrder';

export function collectMergeTabOrder(
    layout: TEditorLayoutNode | null,
    panes: IEditorPaneState[],
    tabs: ITab[],
) {
    const orderedPaneIds = collectLayoutPaneOrder(layout);
    const orderedTabIds = orderedPaneIds.flatMap((paneId) => {
        const pane = panes.find(candidate => candidate.paneId === paneId);
        return pane?.tabIds ?? [];
    });

    return uniq([
        ...orderedTabIds,
        ...tabs.map(tab => tab.id),
    ]);
}
