import type { ITab } from '@app/types/tabs';
import type {
    IEditorGroupState,
    TEditorLayoutNode,
} from '@app/types/editor-groups';
import {
    appendGroupToLayout,
    collectLayoutGroupIds,
    pruneLayoutToExistingGroups,
} from '@app/modules/workspace-shell/composables/editor-groups/layoutTree';

interface IEditorGroupsStateSnapshot {
    groups: IEditorGroupState[];
    tabs: ITab[];
    layout: TEditorLayoutNode | null;
    activeGroupId: string | null;
    groupMru: string[];
}

interface INormalizeEditorGroupsStateParams extends IEditorGroupsStateSnapshot { createGroup: () => IEditorGroupState; }

export function arraysEqual<T>(left: T[], right: T[]) {
    if (left === right) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function buildNormalizedGroupMru(
    currentActiveGroupId: string | null,
    currentMru: string[],
    groupsOrder: string[],
    validGroupIds: Set<string>,
) {
    const nextMru: string[] = [];
    const mruSeen = new Set<string>();
    const preferredGroupIds = [
        currentActiveGroupId,
        ...currentMru,
        ...groupsOrder,
    ];
    for (const groupId of preferredGroupIds) {
        if (!groupId || !validGroupIds.has(groupId) || mruSeen.has(groupId)) {
            continue;
        }
        mruSeen.add(groupId);
        nextMru.push(groupId);
    }
    return nextMru;
}

export function isEditorGroupsStateNormalized(state: IEditorGroupsStateSnapshot) {
    const validTabIds = new Set<string>();
    for (const tab of state.tabs) {
        if (!tab.id || validTabIds.has(tab.id)) {
            return false;
        }
        validTabIds.add(tab.id);
    }

    if (state.groups.length === 0) {
        return false;
    }

    const validGroupIds = new Set<string>();
    const groupsOrder: string[] = [];
    const assignedTabIds = new Set<string>();
    for (const group of state.groups) {
        if (!group.id || validGroupIds.has(group.id)) {
            return false;
        }
        validGroupIds.add(group.id);
        groupsOrder.push(group.id);

        for (const tabId of group.tabIds) {
            if (!validTabIds.has(tabId) || assignedTabIds.has(tabId)) {
                return false;
            }
            assignedTabIds.add(tabId);
        }

        const expectedActiveTabId = group.activeTabId && group.tabIds.includes(group.activeTabId)
            ? group.activeTabId
            : (group.tabIds[0] ?? null);
        if (group.activeTabId !== expectedActiveTabId) {
            return false;
        }
    }

    if (assignedTabIds.size !== validTabIds.size) {
        return false;
    }

    if (!state.layout) {
        return false;
    }

    const layoutGroupIds = new Set<string>();
    collectLayoutGroupIds(state.layout, layoutGroupIds);
    for (const groupId of layoutGroupIds) {
        if (!validGroupIds.has(groupId)) {
            return false;
        }
    }
    for (const groupId of validGroupIds) {
        if (!layoutGroupIds.has(groupId)) {
            return false;
        }
    }

    if (!state.activeGroupId || !validGroupIds.has(state.activeGroupId)) {
        return false;
    }

    const nextMru = buildNormalizedGroupMru(
        state.activeGroupId,
        state.groupMru,
        groupsOrder,
        validGroupIds,
    );
    return arraysEqual(state.groupMru, nextMru);
}

export function normalizeEditorGroupsState({
    groups,
    tabs,
    layout,
    activeGroupId,
    groupMru,
    createGroup,
}: INormalizeEditorGroupsStateParams): IEditorGroupsStateSnapshot {
    const uniqueTabs: ITab[] = [];
    const validTabIds = new Set<string>();
    for (const tab of tabs) {
        if (!tab.id || validTabIds.has(tab.id)) {
            continue;
        }
        validTabIds.add(tab.id);
        uniqueTabs.push(tab);
    }

    const normalizedGroups: IEditorGroupState[] = [];
    const validGroupIds = new Set<string>();
    const assignedTabIds = new Set<string>();
    for (const group of groups) {
        if (!group.id || validGroupIds.has(group.id)) {
            continue;
        }
        validGroupIds.add(group.id);

        const nextTabIds: string[] = [];
        for (const tabId of group.tabIds) {
            if (!validTabIds.has(tabId) || assignedTabIds.has(tabId)) {
                continue;
            }
            assignedTabIds.add(tabId);
            nextTabIds.push(tabId);
        }

        normalizedGroups.push({
            id: group.id,
            tabIds: nextTabIds,
            activeTabId: group.activeTabId && nextTabIds.includes(group.activeTabId)
                ? group.activeTabId
                : (nextTabIds[0] ?? null),
        });
    }

    if (normalizedGroups.length === 0) {
        const fallbackGroup = createGroup();
        normalizedGroups.push(fallbackGroup);
        validGroupIds.add(fallbackGroup.id);
    }

    const nextGroups = normalizedGroups.map(group => ({
        ...group,
        tabIds: [...group.tabIds],
    }));

    const fallbackGroup = nextGroups[0]!;
    for (const tab of uniqueTabs) {
        if (assignedTabIds.has(tab.id)) {
            continue;
        }
        fallbackGroup.tabIds.push(tab.id);
        assignedTabIds.add(tab.id);
    }

    for (const group of nextGroups) {
        group.activeTabId = group.activeTabId && group.tabIds.includes(group.activeTabId)
            ? group.activeTabId
            : (group.tabIds[0] ?? null);
    }

    const freshGroupIds = new Set(nextGroups.map(group => group.id));
    let nextLayout = layout ? pruneLayoutToExistingGroups(layout, freshGroupIds) : null;
    if (!nextLayout) {
        nextLayout = {
            type: 'leaf',
            groupId: nextGroups[0]!.id,
        };
    }

    const layoutGroupIds = new Set<string>();
    collectLayoutGroupIds(nextLayout, layoutGroupIds);
    for (const group of nextGroups) {
        if (layoutGroupIds.has(group.id)) {
            continue;
        }
        nextLayout = appendGroupToLayout(nextLayout, group.id);
        layoutGroupIds.add(group.id);
    }

    const nextActiveGroupId = activeGroupId && freshGroupIds.has(activeGroupId)
        ? activeGroupId
        : (nextGroups[0]?.id ?? null);
    const nextMru = buildNormalizedGroupMru(
        nextActiveGroupId,
        groupMru,
        nextGroups.map(group => group.id),
        freshGroupIds,
    );

    return {
        groups: nextGroups,
        tabs: uniqueTabs,
        layout: nextLayout,
        activeGroupId: nextActiveGroupId,
        groupMru: nextMru,
    };
}
