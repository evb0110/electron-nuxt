import type {
    TTabMemoryPolicy,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type { Ref } from 'vue';
import type { IEditorGroupState } from '@app/types/editorGroups';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';

export type TTabTemperature = 'hot' | 'warm' | 'cold';

export interface ITabViewSessionState {
    currentPage: number;
    zoom: number;
    effectiveZoom: number;
    zoomMode: TZoomMode;
    fitMode: TFitMode;
    viewMode: TPdfViewMode;
    showSidebar: boolean;
    continuousScroll: boolean;
}

export interface ITabLifecycleState {
    tabId: string;
    temperature: TTabTemperature;
    shouldMountHost: boolean;
}

const TAB_POLICY_WARM_COUNTS: Record<TTabMemoryPolicy, number> = {
    conservative: 2,
    aggressive: 0,
};

function normalizePage(value: number) {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

export function createTabViewSessionState(snapshot: IWorkspaceToolbarSnapshot): ITabViewSessionState {
    return {
        currentPage: normalizePage(snapshot.currentPage),
        zoom: snapshot.zoom,
        effectiveZoom: snapshot.effectiveZoom,
        zoomMode: snapshot.zoomMode,
        fitMode: snapshot.fitMode,
        viewMode: snapshot.viewMode,
        showSidebar: snapshot.showSidebar,
        continuousScroll: snapshot.continuousScroll,
    };
}

export function resolveTabLifecycleStates(options: {
    tabs: ITab[];
    groups: IEditorGroupState[];
    activeTabId: string | null;
    activationOrder: string[];
    policy: TTabMemoryPolicy;
}): ITabLifecycleState[] {
    const warmCount = TAB_POLICY_WARM_COUNTS[options.policy];
    const tabIds = new Set(options.tabs.map(tab => tab.id));
    const visibleTabIds = new Set(
        options.groups
            .map(group => group.activeTabId)
            .filter((tabId): tabId is string => Boolean(tabId)),
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

export function useTabSessionStore(options: {
    tabs: Ref<ITab[]>;
    groups: Ref<IEditorGroupState[]>;
    activeTabId: Ref<string | null>;
    policy: Ref<TTabMemoryPolicy>;
}) {
    const viewStateByTabId = ref<Record<string, ITabViewSessionState>>({});
    const activationOrder = ref<string[]>([]);

    function rememberActivation(tabId: string | null) {
        if (!tabId) {
            return;
        }

        activationOrder.value = [
            tabId,
            ...activationOrder.value.filter(candidate => candidate !== tabId),
        ];
    }

    watch(options.activeTabId, rememberActivation, { immediate: true });

    watch(options.tabs, (tabs) => {
        const tabIds = new Set(tabs.map(tab => tab.id));
        activationOrder.value = activationOrder.value.filter(tabId => tabIds.has(tabId));
        viewStateByTabId.value = Object.fromEntries(
            Object.entries(viewStateByTabId.value).filter(([tabId]) => tabIds.has(tabId)),
        );
    });

    function updateViewState(tabId: string, state: ITabViewSessionState) {
        viewStateByTabId.value = {
            ...viewStateByTabId.value,
            [tabId]: state,
        };
    }

    const lifecycleByTabId = computed(() => Object.fromEntries(
        resolveTabLifecycleStates({
            tabs: options.tabs.value,
            groups: options.groups.value,
            activeTabId: options.activeTabId.value,
            activationOrder: activationOrder.value,
            policy: options.policy.value,
        }).map(state => [
            state.tabId,
            state,
        ]),
    ));

    return {
        lifecycleByTabId,
        updateViewState,
        viewStateByTabId,
    };
}
