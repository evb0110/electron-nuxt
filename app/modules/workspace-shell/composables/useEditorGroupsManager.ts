import type { ITab } from '@app/types/tabs';
import { clamp } from 'es-toolkit/math';
import type {
    IEditorGroupState,
    IEditorLayoutLeafNode,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TGroupDirection,
} from '@app/types/editorGroups';
import {
    removeLeafNode,
    replaceLeafWithSplit,
    updateLayoutSplitRatio,
} from '@app/modules/workspace-shell/composables/editor-groups/layoutTree';
import { findDirectionalGroupId } from '@app/modules/workspace-shell/composables/editor-groups/navigation';
import {
    arraysEqual,
    isEditorGroupsStateNormalized,
    normalizeEditorGroupsState,
} from '@app/modules/workspace-shell/composables/editor-groups/normalization';

interface ICreateTabOptions {
    groupId?: string | null;
    initial?: Partial<Pick<ITab, 'fileName' | 'originalPath' | 'isDirty' | 'isDjvu'>>;
    activate?: boolean;
}

interface ICloseTabResult {
    tab: ITab | null;
    removedGroupId: string | null;
}

export const useEditorGroupsManager = () => {
    const groups = useState<IEditorGroupState[]>(
        'editorGroups:groups',
        () => [],
    );
    const tabs = useState<ITab[]>(
        'editorGroups:tabs',
        () => [],
    );
    const layout = useState<TEditorLayoutNode | null>(
        'editorGroups:layout',
        () => null,
    );
    const activeGroupId = useState<string | null>(
        'editorGroups:active-group-id',
        () => null,
    );
    const groupMru = useState<string[]>(
        'editorGroups:group-mru',
        () => [],
    );
    const nextEntityId = useState<number>(
        'editorGroups:entity-id',
        () => 0,
    );

    function allocateEntityId(prefix: 'group' | 'tab' | 'split') {
        nextEntityId.value += 1;
        return `${prefix}-${nextEntityId.value.toString(36)}`;
    }

    const groupLookup = computed(() => {
        const map = new Map<string, IEditorGroupState>();
        for (const group of groups.value) {
            map.set(group.id, group);
        }
        return map;
    });
    const tabLookup = computed(() => {
        const map = new Map<string, ITab>();
        for (const tab of tabs.value) {
            map.set(tab.id, tab);
        }
        return map;
    });
    const tabGroupLookup = computed(() => {
        const map = new Map<string, string>();
        for (const group of groups.value) {
            for (const tabId of group.tabIds) {
                map.set(tabId, group.id);
            }
        }
        return map;
    });

    function createGroup(): IEditorGroupState {
        return {
            id: allocateEntityId('group'),
            tabIds: [],
            activeTabId: null,
        };
    }

    function isManagerStateNormalized() {
        return isEditorGroupsStateNormalized({
            groups: groups.value,
            tabs: tabs.value,
            layout: layout.value,
            activeGroupId: activeGroupId.value,
            groupMru: groupMru.value,
        });
    }

    function normalizeManagerState() {
        if (isManagerStateNormalized()) {
            return;
        }
        const nextState = normalizeEditorGroupsState({
            groups: groups.value,
            tabs: tabs.value,
            layout: layout.value,
            activeGroupId: activeGroupId.value,
            groupMru: groupMru.value,
            createGroup,
        });
        tabs.value = nextState.tabs;
        groups.value = nextState.groups;
        layout.value = nextState.layout;
        activeGroupId.value = nextState.activeGroupId;
        groupMru.value = nextState.groupMru;
    }

    function createEmptyTab(initial?: ICreateTabOptions['initial']): ITab {
        return {
            id: allocateEntityId('tab'),
            fileName: initial?.fileName ?? null,
            originalPath: initial?.originalPath ?? null,
            isDirty: initial?.isDirty ?? false,
            isDjvu: initial?.isDjvu ?? false,
        };
    }

    function touchGroupMru(groupId: string) {
        if (
            groupMru.value[0] === groupId
            && groupMru.value.indexOf(groupId, 1) === -1
        ) {
            return;
        }
        const next = groupMru.value.filter(candidate => candidate !== groupId);
        next.unshift(groupId);
        if (!arraysEqual(groupMru.value, next)) {
            groupMru.value = next;
        }
    }

    function getGroupById(id: string | null | undefined) {
        if (!id) {
            return null;
        }
        return groupLookup.value.get(id) ?? null;
    }

    function getTabById(id: string | null | undefined) {
        if (!id) {
            return null;
        }
        return tabLookup.value.get(id) ?? null;
    }

    function getGroupByTabId(tabId: string) {
        const groupId = tabGroupLookup.value.get(tabId);
        return groupId ? getGroupById(groupId) : null;
    }

    function getGroupTabs(groupId: string) {
        const group = getGroupById(groupId);
        if (!group) {
            return [];
        }
        return group.tabIds
            .map(tabId => getTabById(tabId))
            .filter((tab): tab is ITab => Boolean(tab));
    }

    function ensureLayoutInitialized() {
        if (layout.value && groups.value.length > 0) {
            return;
        }

        const group = createGroup();
        groups.value = [group];
        activeGroupId.value = group.id;
        groupMru.value = [group.id];
        layout.value = {
            type: 'leaf',
            groupId: group.id,
        };
        normalizeManagerState();
    }

    function ensureAtLeastOneTab() {
        normalizeManagerState();
        ensureLayoutInitialized();

        const hasAnyTab = groups.value.some(group => group.tabIds.length > 0);
        if (hasAnyTab) {
            const activeGroup = getGroupById(activeGroupId.value) ?? groups.value[0] ?? null;
            if (activeGroup) {
                activeGroupId.value = activeGroup.id;
                touchGroupMru(activeGroup.id);
                if (!activeGroup.activeTabId && activeGroup.tabIds.length > 0) {
                    activeGroup.activeTabId = activeGroup.tabIds[0] ?? null;
                }
            }
            normalizeManagerState();
            return;
        }

        createTab({
            groupId: activeGroupId.value,
            activate: true,
        });
        normalizeManagerState();
    }

    function activateGroup(groupId: string) {
        const group = getGroupById(groupId);
        if (!group) {
            return;
        }

        activeGroupId.value = group.id;
        touchGroupMru(group.id);

        if (!group.activeTabId && group.tabIds.length > 0) {
            group.activeTabId = group.tabIds[0] ?? null;
        }
        normalizeManagerState();
    }

    function activateTab(groupId: string, tabId: string) {
        const group = getGroupById(groupId);
        if (!group || !group.tabIds.includes(tabId)) {
            return;
        }

        group.activeTabId = tabId;
        activateGroup(groupId);
        normalizeManagerState();
    }

    function createTab(options: ICreateTabOptions = {}) {
        normalizeManagerState();
        ensureLayoutInitialized();

        let group = getGroupById(options.groupId ?? activeGroupId.value);
        if (!group) {
            group = groups.value[0] ?? null;
        }
        if (!group) {
            group = createGroup();
            groups.value.push(group);
            if (!layout.value) {
                layout.value = {
                    type: 'leaf',
                    groupId: group.id,
                };
            }
        }

        const tab = createEmptyTab(options.initial);
        tabs.value.push(tab);
        group.tabIds.push(tab.id);

        if (options.activate !== false || !group.activeTabId) {
            group.activeTabId = tab.id;
        }

        if (options.activate !== false) {
            activateGroup(group.id);
        }

        normalizeManagerState();
        return tab;
    }

    function moveTabWithinGroup(groupId: string, fromIndex: number, toIndex: number) {
        const group = getGroupById(groupId);
        if (!group) {
            return;
        }

        if (
            fromIndex < 0
            || fromIndex >= group.tabIds.length
            || toIndex < 0
            || toIndex >= group.tabIds.length
            || fromIndex === toIndex
        ) {
            return;
        }

        const [tabId] = group.tabIds.splice(fromIndex, 1);
        if (!tabId) {
            return;
        }
        group.tabIds.splice(toIndex, 0, tabId);
        normalizeManagerState();
    }

    function closeGroup(groupId: string) {
        if (groups.value.length <= 1) {
            return false;
        }

        const group = getGroupById(groupId);
        if (!group) {
            return false;
        }

        groups.value = groups.value.filter(candidate => candidate.id !== group.id);
        groupMru.value = groupMru.value.filter(candidate => candidate !== group.id);

        if (layout.value) {
            layout.value = removeLeafNode(layout.value, group.id);
        }

        const nextActiveGroup = getGroupById(activeGroupId.value)
            ?? groupMru.value.map(id => getGroupById(id)).find((candidate): candidate is IEditorGroupState => Boolean(candidate))
            ?? groups.value[0]
            ?? null;

        activeGroupId.value = nextActiveGroup?.id ?? null;
        if (nextActiveGroup) {
            touchGroupMru(nextActiveGroup.id);
            if (!nextActiveGroup.activeTabId && nextActiveGroup.tabIds.length > 0) {
                nextActiveGroup.activeTabId = nextActiveGroup.tabIds[0] ?? null;
            }
        }

        normalizeManagerState();
        return true;
    }

    function closeTab(groupId: string, tabId: string): ICloseTabResult {
        const group = getGroupById(groupId);
        if (!group) {
            return {
                tab: null,
                removedGroupId: null,
            };
        }

        const tabIndex = group.tabIds.findIndex(candidate => candidate === tabId);
        if (tabIndex === -1) {
            return {
                tab: null,
                removedGroupId: null,
            };
        }

        const tab = getTabById(tabId);
        group.tabIds.splice(tabIndex, 1);
        tabs.value = tabs.value.filter(candidate => candidate.id !== tabId);

        if (group.activeTabId === tabId) {
            const replacement = group.tabIds[tabIndex] ?? group.tabIds[tabIndex - 1] ?? null;
            group.activeTabId = replacement;
        }

        let removedGroupId: string | null = null;
        if (group.tabIds.length === 0) {
            if (groups.value.length > 1) {
                removedGroupId = group.id;
                closeGroup(group.id);
            } else {
                const replacement = createTab({
                    groupId: group.id,
                    activate: true,
                });
                group.activeTabId = replacement.id;
            }
        }

        normalizeManagerState();
        return {
            tab,
            removedGroupId,
        };
    }

    function findDirectionalGroup(
        sourceGroupId: string,
        direction: TGroupDirection,
        wrap = true,
    ) {
        const targetGroupId = findDirectionalGroupId({
            layout: layout.value,
            sourceGroupId,
            direction,
            groupMru: groupMru.value,
            wrap,
        });
        return targetGroupId ? getGroupById(targetGroupId) : null;
    }

    function splitGroup(sourceGroupId: string, direction: TGroupDirection) {
        const sourceGroup = getGroupById(sourceGroupId);
        if (!sourceGroup || !layout.value) {
            return null;
        }

        const newGroup = createGroup();
        groups.value.push(newGroup);

        const sourceLeaf: IEditorLayoutLeafNode = {
            type: 'leaf',
            groupId: sourceGroupId,
        };
        const newLeaf: IEditorLayoutLeafNode = {
            type: 'leaf',
            groupId: newGroup.id,
        };

        const horizontal = direction === 'left' || direction === 'right';
        const beforeSource = direction === 'left' || direction === 'up';

        const splitNode: IEditorLayoutSplitNode = {
            type: 'split',
            id: allocateEntityId('split'),
            orientation: horizontal ? 'horizontal' : 'vertical',
            ratio: 0.5,
            first: beforeSource ? newLeaf : sourceLeaf,
            second: beforeSource ? sourceLeaf : newLeaf,
        };

        layout.value = replaceLeafWithSplit(layout.value, sourceGroupId, splitNode);
        touchGroupMru(newGroup.id);
        normalizeManagerState();

        return newGroup.id;
    }

    function setSplitRatio(splitId: string, nextRatio: number) {
        const clamped = clamp(nextRatio, 0.15, 0.85);

        if (!layout.value) {
            return;
        }

        layout.value = updateLayoutSplitRatio(layout.value, splitId, clamped);
        normalizeManagerState();
    }

    function focusGroup(direction: TGroupDirection, wrap = true) {
        const sourceGroup = getGroupById(activeGroupId.value) ?? groups.value[0] ?? null;
        if (!sourceGroup) {
            return null;
        }

        const target = findDirectionalGroup(sourceGroup.id, direction, wrap);
        if (!target) {
            return null;
        }

        activateGroup(target.id);
        return target.id;
    }

    function moveTabToGroup(tabId: string, targetGroupId: string, activate = true) {
        const sourceGroup = getGroupByTabId(tabId);
        const targetGroup = getGroupById(targetGroupId);
        if (!sourceGroup || !targetGroup) {
            return false;
        }

        if (sourceGroup.id === targetGroup.id) {
            if (activate) {
                activateTab(targetGroup.id, tabId);
            }
            normalizeManagerState();
            return true;
        }

        sourceGroup.tabIds = sourceGroup.tabIds.filter(candidate => candidate !== tabId);
        targetGroup.tabIds.push(tabId);
        targetGroup.activeTabId = tabId;

        if (sourceGroup.activeTabId === tabId) {
            sourceGroup.activeTabId = sourceGroup.tabIds[sourceGroup.tabIds.length - 1] ?? null;
        }

        if (sourceGroup.tabIds.length === 0) {
            closeGroup(sourceGroup.id);
        }

        if (activate) {
            activateTab(targetGroup.id, tabId);
        }

        normalizeManagerState();
        return true;
    }

    function copyTabToGroup(tabId: string, targetGroupId: string, activate = true) {
        const sourceTab = getTabById(tabId);
        const targetGroup = getGroupById(targetGroupId);
        if (!sourceTab || !targetGroup) {
            return null;
        }

        const copied = createTab({
            groupId: targetGroup.id,
            activate,
            initial: {
                fileName: sourceTab.fileName,
                originalPath: sourceTab.originalPath,
                isDirty: sourceTab.isDirty,
                isDjvu: sourceTab.isDjvu,
            },
        });

        return copied;
    }

    function ensureTargetGroupForDirection(sourceGroupId: string, direction: TGroupDirection) {
        const existing = findDirectionalGroup(sourceGroupId, direction, false);
        if (existing) {
            return {
                group: existing,
                created: false,
            };
        }

        const groupId = splitGroup(sourceGroupId, direction);
        const group = getGroupById(groupId);
        if (!group) {
            return null;
        }

        return {
            group,
            created: true,
        };
    }

    function moveActiveTabToDirection(direction: TGroupDirection) {
        const sourceGroup = getGroupById(activeGroupId.value);
        if (!sourceGroup || !sourceGroup.activeTabId) {
            return null;
        }
        const sourceTabId = sourceGroup.activeTabId;

        const target = ensureTargetGroupForDirection(sourceGroup.id, direction);
        if (!target) {
            return null;
        }

        const moved = moveTabToGroup(sourceTabId, target.group.id, true);
        if (!moved) {
            return null;
        }

        return {
            tabId: sourceTabId,
            targetGroupId: target.group.id,
            createdGroup: target.created,
        };
    }

    function copyActiveTabToDirection(direction: TGroupDirection) {
        const sourceGroup = getGroupById(activeGroupId.value);
        if (!sourceGroup || !sourceGroup.activeTabId) {
            return null;
        }

        const target = ensureTargetGroupForDirection(sourceGroup.id, direction);
        if (!target) {
            return null;
        }

        const copied = copyTabToGroup(sourceGroup.activeTabId, target.group.id, true);
        if (!copied) {
            return null;
        }

        return {
            sourceTabId: sourceGroup.activeTabId,
            targetTabId: copied.id,
            targetGroupId: target.group.id,
            createdGroup: target.created,
        };
    }

    const activeGroup = computed(() => getGroupById(activeGroupId.value));
    const activeTabId = computed(() => activeGroup.value?.activeTabId ?? null);

    ensureAtLeastOneTab();

    return {
        groups,
        tabs,
        layout,
        activeGroupId,
        activeGroup,
        activeTabId,
        ensureAtLeastOneTab,
        getGroupById,
        getTabById,
        getGroupByTabId,
        getGroupTabs,
        activateGroup,
        activateTab,
        createTab,
        closeTab,
        moveTabWithinGroup,
        splitGroup,
        closeGroup,
        setSplitRatio,
        focusGroup,
        findDirectionalGroup,
        moveTabToGroup,
        copyTabToGroup,
        moveActiveTabToDirection,
        copyActiveTabToDirection,
    };
};
