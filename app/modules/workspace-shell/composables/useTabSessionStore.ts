import type { TTabMemoryPolicy } from '@contracts/shared';
import type { Ref } from 'vue';
import type { IEditorPaneState } from '@app/types/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { resolveTabLifecycleStates } from '@app/modules/workspace-shell/tabs/resolveTabLifecycleStates';

export function useTabSessionStore(options: {
    tabs: Ref<ITab[]>;
    panes: Ref<IEditorPaneState[]>;
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
            panes: options.panes.value,
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
