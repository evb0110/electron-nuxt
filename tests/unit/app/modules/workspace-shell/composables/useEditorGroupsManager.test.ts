import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TEditorLayoutNode } from '@app/types/editor-groups';

function collectLeafGroupIds(node: TEditorLayoutNode | null, target: Set<string>) {
    if (!node) {
        return;
    }
    if (node.type === 'leaf') {
        target.add(node.groupId);
        return;
    }
    collectLeafGroupIds(node.first, target);
    collectLeafGroupIds(node.second, target);
}

describe('useEditorGroupsManager', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('repairs duplicate tab assignment and invalid active tab references', async () => {
        const { useEditorGroupsManager } = await import('@app/modules/workspace-shell/composables/useEditorGroupsManager');
        const manager = useEditorGroupsManager();

        const firstGroup = manager.groups.value[0]!;
        const firstTab = manager.createTab({
            groupId: firstGroup.id,
            activate: true,
        });
        const secondGroupId = manager.splitGroup(firstGroup.id, 'right');
        expect(secondGroupId).toBeTruthy();
        const secondGroup = manager.getGroupById(secondGroupId);
        expect(secondGroup).not.toBeNull();

        if (secondGroup) {
            secondGroup.tabIds.push(firstTab.id);
            secondGroup.tabIds.push('missing-tab-id');
            secondGroup.activeTabId = 'missing-tab-id';
        }
        firstGroup.activeTabId = 'missing-tab-id';
        manager.tabs.value.push({
            ...firstTab,
            fileName: 'duplicate-id',
        });
        manager.groups.value.push({
            id: firstGroup.id,
            tabIds: [firstTab.id],
            activeTabId: firstTab.id,
        });

        manager.ensureAtLeastOneTab();

        const tabIds = manager.tabs.value.map(tab => tab.id);
        expect(new Set(tabIds).size).toBe(tabIds.length);

        const occurrences = manager.groups.value.reduce((count, group) => (
            count + group.tabIds.filter(tabId => tabId === firstTab.id).length
        ), 0);
        expect(occurrences).toBe(1);

        const uniqueGroupIds = new Set(manager.groups.value.map(group => group.id));
        expect(uniqueGroupIds.size).toBe(manager.groups.value.length);

        for (const group of manager.groups.value) {
            expect(group.tabIds).not.toContain('missing-tab-id');
            if (group.tabIds.length === 0) {
                expect(group.activeTabId).toBeNull();
                continue;
            }
            expect(group.tabIds).toContain(group.activeTabId);
        }
    });

    it('repairs layout leaves that reference removed groups', async () => {
        const { useEditorGroupsManager } = await import('@app/modules/workspace-shell/composables/useEditorGroupsManager');
        const manager = useEditorGroupsManager();

        manager.layout.value = {
            type: 'leaf',
            groupId: 'missing-group-id',
        };
        manager.activeGroupId.value = 'missing-group-id';

        manager.ensureAtLeastOneTab();

        const validGroupIds = new Set(manager.groups.value.map(group => group.id));
        const layoutGroupIds = new Set<string>();
        collectLeafGroupIds(manager.layout.value, layoutGroupIds);

        expect(layoutGroupIds.size).toBeGreaterThan(0);
        for (const groupId of layoutGroupIds) {
            expect(validGroupIds.has(groupId)).toBe(true);
        }
        expect(manager.activeGroupId.value).not.toBe('missing-group-id');
        expect(manager.activeGroupId.value).not.toBeNull();
    });

    it('keeps key refs stable when normalization is a no-op', async () => {
        const { useEditorGroupsManager } = await import('@app/modules/workspace-shell/composables/useEditorGroupsManager');
        const manager = useEditorGroupsManager();

        const groupsRef = manager.groups.value;
        const tabsRef = manager.tabs.value;
        const layoutRef = manager.layout.value;
        const firstGroupRef = manager.groups.value[0];
        const firstGroupTabIdsRef = manager.groups.value[0]?.tabIds;

        manager.ensureAtLeastOneTab();

        expect(manager.groups.value).toBe(groupsRef);
        expect(manager.tabs.value).toBe(tabsRef);
        expect(manager.layout.value).toBe(layoutRef);
        expect(manager.groups.value[0]).toBe(firstGroupRef);
        expect(manager.groups.value[0]?.tabIds).toBe(firstGroupTabIdsRef);
    });
});
