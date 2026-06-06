import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';

// Intentional client-wide singleton: the workspace shell, toolbar, and tab
// transfer flows share one tab collection within the renderer process.
const tabs = ref<ITab[]>([]);
const activeTabId = ref<string | null>(null);

function createEmptyTab(): ITab {
    return {
        id: crypto.randomUUID(),
        fileName: null,
        originalPath: null,
        isDirty: false,
        isDjvu: false,
    };
}

function reorderTabs(currentTabs: readonly ITab[], fromIndex: number, toIndex: number) {
    const tab = currentTabs[fromIndex];
    if (!tab) {
        return [...currentTabs];
    }
    const withoutTab = currentTabs.filter((_, index) => index !== fromIndex);
    return [
        ...withoutTab.slice(0, toIndex),
        tab,
        ...withoutTab.slice(toIndex),
    ];
}

export const useTabManager = () => {
    const activeTab = computed(() =>
        tabs.value.find(t => t.id === activeTabId.value) ?? null,
    );

    function createTab() {
        const tab = createEmptyTab();
        tabs.value = [
            ...tabs.value,
            tab,
        ];
        activeTabId.value = tab.id;
        return tab;
    }

    function ensureAtLeastOneTab() {
        if (tabs.value.length === 0) {
            createTab();
        }
    }

    function activateTab(id: string) {
        if (tabs.value.some(t => t.id === id)) {
            activeTabId.value = id;
        }
    }

    function closeTab(id: string) {
        const index = tabs.value.findIndex(t => t.id === id);
        if (index === -1) {
            return;
        }

        const nextTabs = tabs.value.filter(t => t.id !== id);
        tabs.value = nextTabs;

        if (activeTabId.value === id) {
            const next = nextTabs[index] ?? nextTabs[index - 1] ?? null;
            activeTabId.value = next?.id ?? null;
        }

        ensureAtLeastOneTab();
    }

    function updateTab(id: string, updates: TTabUpdate) {
        tabs.value = tabs.value.map(tab => (
            tab.id === id
                ? {
                    ...tab,
                    ...updates,
                }
                : tab
        ));
    }

    function moveTab(fromIndex: number, toIndex: number) {
        if (
            fromIndex < 0
            || fromIndex >= tabs.value.length
            || toIndex < 0
            || toIndex >= tabs.value.length
            || fromIndex === toIndex
        ) {
            return;
        }
        tabs.value = reorderTabs(tabs.value, fromIndex, toIndex);
    }

    function getTabById(id: string) {
        return tabs.value.find(t => t.id === id) ?? null;
    }

    return {
        tabs,
        activeTabId,
        activeTab,
        createTab,
        closeTab,
        activateTab,
        updateTab,
        moveTab,
        ensureAtLeastOneTab,
        getTabById,
    };
};
