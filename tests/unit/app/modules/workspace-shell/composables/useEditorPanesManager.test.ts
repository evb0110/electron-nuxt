import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';

const stateStore = new Map<string, ReturnType<typeof ref>>();

interface ILegacyEditorPaneState {
    id: string;
    tabIds: string[];
    activeTabId: string | null;
}

function installUseStateStub() {
    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
        const existing = stateStore.get(key);
        if (existing) {
            return existing;
        }
        const state = ref(init());
        stateStore.set(key, state);
        return state;
    });
}

function collectLeafPaneIds(node: TEditorLayoutNode | null, target: Set<string>) {
    if (!node) {
        return;
    }
    if (node.type === 'leaf') {
        target.add(node.paneId);
        return;
    }
    collectLeafPaneIds(node.first, target);
    collectLeafPaneIds(node.second, target);
}

describe('useEditorPanesManager', () => {
    beforeEach(() => {
        vi.resetModules();
        stateStore.clear();
        installUseStateStub();
    });

    it('repairs duplicate tab assignment and invalid active tab references', async () => {
        const { useEditorPanesManager } = await import('@app/modules/workspace-shell/composables/useEditorPanesManager');
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const firstPane = manager.panes.value[0]!;
        const firstTab = manager.createTab({
            paneId: firstPane.paneId,
            activate: true,
        });
        const secondPaneId = manager.splitPane(firstPane.paneId, 'right');
        expect(secondPaneId).toBeTruthy();
        const secondPane = manager.getPaneById(secondPaneId);
        expect(secondPane).not.toBeNull();

        if (secondPane) {
            secondPane.tabIds.push(firstTab.id);
            secondPane.tabIds.push('missing-tab-id');
            secondPane.activeTabId = 'missing-tab-id';
        }
        firstPane.activeTabId = 'missing-tab-id';
        manager.tabs.value.push({
            ...firstTab,
            fileName: 'duplicate-id',
        });
        const panesWithLegacyState = manager.panes.value as Array<IEditorPaneState | ILegacyEditorPaneState>;
        panesWithLegacyState.push({
            id: firstPane.paneId,
            tabIds: [firstTab.id],
            activeTabId: firstTab.id,
        });

        manager.ensureAtLeastOneTab();

        const tabIds = manager.tabs.value.map(tab => tab.id);
        expect(new Set(tabIds).size).toBe(tabIds.length);

        const occurrences = manager.panes.value.reduce((count, pane) => (
            count + pane.tabIds.filter(tabId => tabId === firstTab.id).length
        ), 0);
        expect(occurrences).toBe(1);

        const uniquePaneIds = new Set(manager.panes.value.map(pane => pane.paneId));
        expect(uniquePaneIds.size).toBe(manager.panes.value.length);

        for (const pane of manager.panes.value) {
            expect(pane.tabIds).not.toContain('missing-tab-id');
            if (pane.tabIds.length === 0) {
                expect(pane.activeTabId).toBeNull();
                continue;
            }
            expect(pane.tabIds).toContain(pane.activeTabId);
        }
    });

    it('repairs layout leaves that reference removed panes', async () => {
        const { useEditorPanesManager } = await import('@app/modules/workspace-shell/composables/useEditorPanesManager');
        const manager = useEditorPanesManager();

        manager.layout.value = {
            type: 'leaf',
            paneId: 'missing-pane-id',
        };
        manager.activePaneId.value = 'missing-pane-id';

        manager.ensureAtLeastOneTab();

        const validPaneIds = new Set(manager.panes.value.map(pane => pane.paneId));
        const layoutPaneIds = new Set<string>();
        collectLeafPaneIds(manager.layout.value, layoutPaneIds);

        expect(layoutPaneIds.size).toBeGreaterThan(0);
        for (const paneId of layoutPaneIds) {
            expect(validPaneIds.has(paneId)).toBe(true);
        }
        expect(manager.activePaneId.value).not.toBe('missing-pane-id');
        expect(manager.activePaneId.value).not.toBeNull();
    });

    it('keeps key refs stable when normalization is a no-op', async () => {
        const { useEditorPanesManager } = await import('@app/modules/workspace-shell/composables/useEditorPanesManager');
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const panesRef = manager.panes.value;
        const tabsRef = manager.tabs.value;
        const layoutRef = manager.layout.value;
        const firstPaneRef = manager.panes.value[0];
        const firstPaneTabIdsRef = manager.panes.value[0]?.tabIds;

        manager.ensureAtLeastOneTab();

        expect(manager.panes.value).toBe(panesRef);
        expect(manager.tabs.value).toBe(tabsRef);
        expect(manager.layout.value).toBe(layoutRef);
        expect(manager.panes.value[0]).toBe(firstPaneRef);
        expect(manager.panes.value[0]?.tabIds).toBe(firstPaneTabIdsRef);
    });

    it('selects the adjacent source tab after moving the active tab to another pane', async () => {
        const { useEditorPanesManager } = await import('@app/modules/workspace-shell/composables/useEditorPanesManager');
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const sourcePane = manager.activePane.value!;
        const firstTabId = sourcePane.activeTabId!;
        const secondTab = manager.createTab({
            paneId: sourcePane.paneId,
            activate: true,
        });
        const thirdTab = manager.createTab({
            paneId: sourcePane.paneId,
            activate: true,
        });
        const targetPaneId = manager.splitPane(sourcePane.paneId, 'right');
        expect(targetPaneId).toBeTruthy();

        manager.activateTab(sourcePane.paneId, secondTab.id);
        expect(manager.moveTabToPane(secondTab.id, targetPaneId!, false)).toBe(true);
        expect(manager.getPaneById(sourcePane.paneId)?.activeTabId).toBe(thirdTab.id);

        manager.activateTab(sourcePane.paneId, thirdTab.id);
        expect(manager.moveTabToPane(thirdTab.id, targetPaneId!, false)).toBe(true);
        expect(manager.getPaneById(sourcePane.paneId)?.activeTabId).toBe(firstTabId);
    });
});
