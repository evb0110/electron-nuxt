import type { TTabMemoryPolicy } from '@contracts/shared';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type {
    ITabLifecycleState,
    TTabTemperature,
} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import {
    isTabTemperatureReclaimCandidate,
    resolveTabTemperatureResidency,
} from '@app/modules/workspace-shell/memory/viewerResidencyPolicy';

export function resolveTabLifecycleStates(options: {
    tabs: ITab[];
    panes: IEditorPaneState[];
    activationOrder: string[];
    policy: TTabMemoryPolicy;
    targetWarmViewers: number;
}): ITabLifecycleState[] {
    const warmCount = options.policy === 'conservative' ? options.targetWarmViewers : 0;
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
        const isSaveProtected = tab.isDirty;
        const isWarm = !isHot && (warmTabIds.has(tab.id) || isSaveProtected);
        const temperature: TTabTemperature = isHot ? 'hot' : isWarm ? 'warm' : 'cold';

        return {
            tabId: tab.id,
            temperature,
            viewerResidency: resolveTabTemperatureResidency(temperature),
            isReclaimCandidate: isTabTemperatureReclaimCandidate(temperature, { isSaveProtected }),
            shouldMountHost: temperature !== 'cold',
        };
    });
}
