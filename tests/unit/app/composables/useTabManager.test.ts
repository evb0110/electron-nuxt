import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

describe('useTabManager', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('creates tabs and tracks the active tab', async () => {
        const { useTabManager } = await import('@app/composables/useTabManager');
        const manager = useTabManager();

        expect(manager.tabs.value).toEqual([]);
        expect(manager.activeTab.value).toBeNull();

        const first = manager.createTab();

        expect(manager.tabs.value).toHaveLength(1);
        expect(manager.activeTabId.value).toBe(first.id);
        expect(manager.activeTab.value?.id).toBe(first.id);
    });

    it('keeps at least one tab after closing the last tab', async () => {
        const { useTabManager } = await import('@app/composables/useTabManager');
        const manager = useTabManager();

        const onlyTab = manager.createTab();
        manager.closeTab(onlyTab.id);

        expect(manager.tabs.value).toHaveLength(1);
        expect(manager.activeTabId.value).toBe(manager.tabs.value[0]?.id ?? null);
    });

    it('updates, reorders, and ignores invalid tab operations', async () => {
        const { useTabManager } = await import('@app/composables/useTabManager');
        const manager = useTabManager();

        const tabA = manager.createTab();
        const tabB = manager.createTab();

        manager.updateTab(tabA.id, {
            fileName: 'first.pdf',
            isDirty: true,
        });

        expect(manager.getTabById(tabA.id)).toEqual(expect.objectContaining({
            fileName: 'first.pdf',
            isDirty: true,
        }));

        manager.moveTab(1, 0);
        expect(manager.tabs.value[0]?.id).toBe(tabB.id);
        expect(manager.tabs.value[1]?.id).toBe(tabA.id);

        const orderBeforeInvalidMove = manager.tabs.value.map(tab => tab.id);
        manager.moveTab(-1, 0);
        manager.moveTab(0, 99);
        manager.moveTab(0, 0);
        expect(manager.tabs.value.map(tab => tab.id)).toEqual(orderBeforeInvalidMove);

        const activeBeforeInvalidActivate = manager.activeTabId.value;
        manager.activateTab('missing-tab-id');
        expect(manager.activeTabId.value).toBe(activeBeforeInvalidActivate);
    });
});
