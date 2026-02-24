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
        const { useEditorGroupsManager } = await import('@app/composables/useEditorGroupsManager');
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
            secondGroup.activeTabId = 'missing-tab-id';
        }
        firstGroup.activeTabId = 'missing-tab-id';

        manager.ensureAtLeastOneTab();

        const occurrences = manager.groups.value.reduce((count, group) => (
            count + group.tabIds.filter(tabId => tabId === firstTab.id).length
        ), 0);
        expect(occurrences).toBe(1);
        for (const group of manager.groups.value) {
            if (group.tabIds.length === 0) {
                expect(group.activeTabId).toBeNull();
                continue;
            }
            expect(group.tabIds).toContain(group.activeTabId);
        }
    });

    it('repairs layout leaves that reference removed groups', async () => {
        const { useEditorGroupsManager } = await import('@app/composables/useEditorGroupsManager');
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
});
