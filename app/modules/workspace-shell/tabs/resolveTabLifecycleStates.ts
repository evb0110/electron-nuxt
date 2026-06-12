import type { TTabMemoryPolicy } from '@contracts/shared';
import type { IEditorPaneState } from '@app/types/editorPanes';
import type { ITab } from '@app/types/tabs';
import type {
    ITabLifecycleState,
    TTabTemperature,
} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

const TAB_POLICY_WARM_COUNTS: Record<TTabMemoryPolicy, number> = {
    conservative: 2,
    aggressive: 0,
};

export function resolveTabLifecycleStates(options: {
    tabs: ITab[];
    panes: IEditorPaneState[];
    activeTabId: string | null;
    activationOrder: string[];
    policy: TTabMemoryPolicy;
}): ITabLifecycleState[] {
    const warmCount = TAB_POLICY_WARM_COUNTS[options.policy];
    const tabIds = new Set(options.tabs.map(tab => tab.id));
    const visibleTabIds = new Set(
        options.panes.flatMap(pane => pane.activeTabId ? [pane.activeTabId] : []),
    );
    const recentWarmTabIds = options.activationOrder
        .filter(tabId => tabIds.has(tabId) && !visibleTabIds.has(tabId))
        .slice(0, warmCount);
    const warmTabIds = new Set([...recentWarmTabIds]);

    return options.tabs.map((tab) => {
        const isHot = visibleTabIds.has(tab.id);
        const isWarm = !isHot && warmTabIds.has(tab.id);
        const temperature: TTabTemperature = isHot ? 'hot' : isWarm ? 'warm' : 'cold';

        return {
            tabId: tab.id,
            temperature,
            shouldMountHost: temperature !== 'cold',
        };
    });
}
