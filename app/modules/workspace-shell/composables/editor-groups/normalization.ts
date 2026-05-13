import type { ITab } from '@app/types/tabs';
import type {
    IEditorGroupState,
    TEditorLayoutNode,
} from '@app/types/editorGroups';
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

interface IUniqueTabsResult {
    tabs: ITab[];
    tabIds: Set<string>;
    hasInvalidTabs: boolean;
}

interface INormalizedGroupsResult {
    groups: IEditorGroupState[];
    groupIds: Set<string>;
    assignedTabIds: Set<string>;
    hasInvalidGroups: boolean;
}

interface IActiveGroupMruResult {
    activeGroupId: string | null;
    groupMru: string[];
}

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

function collectUniqueTabs(tabs: ITab[]): IUniqueTabsResult {
    const uniqueTabs: ITab[] = [];
    const validTabIds = new Set<string>();
    let hasInvalidTabs = false;

    for (const tab of tabs) {
        if (!tab.id || validTabIds.has(tab.id)) {
            hasInvalidTabs = true;
            continue;
        }
        validTabIds.add(tab.id);
        uniqueTabs.push(tab);
    }

    return {
        tabs: uniqueTabs,
        tabIds: validTabIds,
        hasInvalidTabs,
    };
}

function normalizeGroupTabIds(
    groups: IEditorGroupState[],
    validTabIds: Set<string>,
): INormalizedGroupsResult {
    const normalizedGroups: IEditorGroupState[] = [];
    const validGroupIds = new Set<string>();
    const assignedTabIds = new Set<string>();
    let hasInvalidGroups = false;

    for (const group of groups) {
        if (!group.id || validGroupIds.has(group.id)) {
            hasInvalidGroups = true;
            continue;
        }
        validGroupIds.add(group.id);

        const nextTabIds: string[] = [];
        for (const tabId of group.tabIds) {
            if (!validTabIds.has(tabId) || assignedTabIds.has(tabId)) {
                hasInvalidGroups = true;
                continue;
            }
            assignedTabIds.add(tabId);
            nextTabIds.push(tabId);
        }

        const activeTabId = group.activeTabId && nextTabIds.includes(group.activeTabId)
            ? group.activeTabId
            : (nextTabIds[0] ?? null);
        hasInvalidGroups ||= group.activeTabId !== activeTabId;
        normalizedGroups.push({
            id: group.id,
            tabIds: nextTabIds,
            activeTabId,
        });
    }

    return {
        groups: normalizedGroups,
        groupIds: validGroupIds,
        assignedTabIds,
        hasInvalidGroups,
    };
}

function normalizeLayoutForGroups(
    layout: TEditorLayoutNode | null,
    groups: IEditorGroupState[],
    validGroupIds: Set<string>,
): TEditorLayoutNode {
    let nextLayout = layout ? pruneLayoutToExistingGroups(layout, validGroupIds) : null;
    if (!nextLayout) {
        nextLayout = {
            type: 'leaf',
            groupId: groups[0]!.id,
        };
    }

    const layoutGroupIds = new Set<string>();
    collectLayoutGroupIds(nextLayout, layoutGroupIds);
    for (const group of groups) {
        if (layoutGroupIds.has(group.id)) {
            continue;
        }
        nextLayout = appendGroupToLayout(nextLayout, group.id);
        layoutGroupIds.add(group.id);
    }

    return nextLayout;
}

function layoutMatchesGroups(layout: TEditorLayoutNode | null, validGroupIds: Set<string>) {
    if (!layout) {
        return false;
    }
    const layoutGroupIds = new Set<string>();
    collectLayoutGroupIds(layout, layoutGroupIds);
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

    return true;
}

function normalizeActiveGroupAndMru(
    activeGroupId: string | null,
    groupMru: string[],
    groups: IEditorGroupState[],
    validGroupIds: Set<string>,
): IActiveGroupMruResult {
    const nextActiveGroupId = activeGroupId && validGroupIds.has(activeGroupId)
        ? activeGroupId
        : (groups[0]?.id ?? null);
    const nextMru = buildNormalizedGroupMru(
        nextActiveGroupId,
        groupMru,
        groups.map(group => group.id),
        validGroupIds,
    );

    return {
        activeGroupId: nextActiveGroupId,
        groupMru: nextMru,
    };
}

function cloneGroupsWithUnassignedTabs(
    groups: IEditorGroupState[],
    tabs: ITab[],
    assignedTabIds: Set<string>,
) {
    const nextGroups = groups.map(group => ({
        ...group,
        tabIds: [...group.tabIds],
    }));
    const fallbackGroup = nextGroups[0]!;

    for (const tab of tabs) {
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

    return nextGroups;
}

export function isEditorGroupsStateNormalized(state: IEditorGroupsStateSnapshot) {
    const tabs = collectUniqueTabs(state.tabs);
    if (tabs.hasInvalidTabs || tabs.tabs.length !== state.tabs.length) {
        return false;
    }

    if (state.groups.length === 0) {
        return false;
    }

    const groups = normalizeGroupTabIds(state.groups, tabs.tabIds);
    if (
        groups.hasInvalidGroups
        || groups.assignedTabIds.size !== tabs.tabIds.size
        || groups.groups.length !== state.groups.length
    ) {
        return false;
    }

    if (!layoutMatchesGroups(state.layout, groups.groupIds)) {
        return false;
    }

    if (!state.activeGroupId || !groups.groupIds.has(state.activeGroupId)) {
        return false;
    }

    const nextMru = normalizeActiveGroupAndMru(
        state.activeGroupId,
        state.groupMru,
        groups.groups,
        groups.groupIds,
    ).groupMru;
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
    const uniqueTabs = collectUniqueTabs(tabs);
    const normalizedGroups = normalizeGroupTabIds(groups, uniqueTabs.tabIds);

    if (normalizedGroups.groups.length === 0) {
        const fallbackGroup = createGroup();
        normalizedGroups.groups.push(fallbackGroup);
        normalizedGroups.groupIds.add(fallbackGroup.id);
    }

    const nextGroups = cloneGroupsWithUnassignedTabs(
        normalizedGroups.groups,
        uniqueTabs.tabs,
        normalizedGroups.assignedTabIds,
    );
    const freshGroupIds = new Set(nextGroups.map(group => group.id));
    const nextLayout = normalizeLayoutForGroups(layout, nextGroups, freshGroupIds);
    const activeGroupMru = normalizeActiveGroupAndMru(
        activeGroupId,
        groupMru,
        nextGroups,
        freshGroupIds,
    );

    return {
        groups: nextGroups,
        tabs: uniqueTabs.tabs,
        layout: nextLayout,
        activeGroupId: activeGroupMru.activeGroupId,
        groupMru: activeGroupMru.groupMru,
    };
}
