
import type { ITab } from '@app/types/tabs';
import type {
    IEditorGroupRect,
    IEditorGroupState,
    IEditorLayoutLeafNode,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TGroupDirection,
} from '@app/types/editor-groups';

interface ICreateTabOptions {
    groupId?: string | null;
    initial?: Partial<Pick<ITab, 'fileName' | 'originalPath' | 'isDirty' | 'isDjvu'>>;
    activate?: boolean;
}

interface ICloseTabResult {
    tab: ITab | null;
    removedGroupId: string | null;
}

const groups = ref<IEditorGroupState[]>([]);
const tabs = ref<ITab[]>([]);
const layout = ref<TEditorLayoutNode | null>(null);
const activeGroupId = ref<string | null>(null);
const groupMru = ref<string[]>([]);
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

function arraysEqual<T>(left: T[], right: T[]) {
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

function isManagerStateNormalized() {
    const validTabIds = new Set<string>();
    for (const tab of tabs.value) {
        if (!tab.id || validTabIds.has(tab.id)) {
            return false;
        }
        validTabIds.add(tab.id);
    }

    if (groups.value.length === 0) {
        return false;
    }

    const validGroupIds = new Set<string>();
    const groupsOrder: string[] = [];
    const assignedTabIds = new Set<string>();
    for (const group of groups.value) {
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

    if (!layout.value) {
        return false;
    }

    const layoutGroupIds = new Set<string>();
    collectLayoutGroupIds(layout.value, layoutGroupIds);
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

    if (!activeGroupId.value || !validGroupIds.has(activeGroupId.value)) {
        return false;
    }

    const nextMru = buildNormalizedGroupMru(
        activeGroupId.value,
        groupMru.value,
        groupsOrder,
        validGroupIds,
    );
    return arraysEqual(groupMru.value, nextMru);
}

function collectLayoutGroupIds(node: TEditorLayoutNode, target: Set<string>) {
    if (node.type === 'leaf') {
        target.add(node.groupId);
        return;
    }

    collectLayoutGroupIds(node.first, target);
    collectLayoutGroupIds(node.second, target);
}

function pruneLayoutToExistingGroups(
    node: TEditorLayoutNode,
    validGroupIds: Set<string>,
): TEditorLayoutNode | null {
    if (node.type === 'leaf') {
        return validGroupIds.has(node.groupId) ? node : null;
    }

    const nextFirst = pruneLayoutToExistingGroups(node.first, validGroupIds);
    const nextSecond = pruneLayoutToExistingGroups(node.second, validGroupIds);

    if (!nextFirst && !nextSecond) {
        return null;
    }
    if (!nextFirst) {
        return nextSecond;
    }
    if (!nextSecond) {
        return nextFirst;
    }

    if (nextFirst === node.first && nextSecond === node.second) {
        return node;
    }

    return {
        ...node,
        first: nextFirst,
        second: nextSecond,
    };
}

function appendGroupToLayout(
    currentLayout: TEditorLayoutNode | null,
    groupId: string,
): TEditorLayoutNode {
    const nextLeaf: IEditorLayoutLeafNode = {
        type: 'leaf',
        groupId,
    };
    if (!currentLayout) {
        return nextLeaf;
    }

    return {
        type: 'split',
        id: crypto.randomUUID(),
        orientation: 'horizontal',
        ratio: 0.5,
        first: currentLayout,
        second: nextLeaf,
    };
}

function normalizeManagerState() {
    if (isManagerStateNormalized()) {
        return;
    }

    const uniqueTabs: ITab[] = [];
    const validTabIds = new Set<string>();
    let tabsChanged = false;
    for (const tab of tabs.value) {
        if (!tab.id || validTabIds.has(tab.id)) {
            tabsChanged = true;
            continue;
        }
        validTabIds.add(tab.id);
        uniqueTabs.push(tab);
    }
    if (tabsChanged) {
        tabs.value = uniqueTabs;
    }

    const normalizedGroups: IEditorGroupState[] = [];
    const validGroupIds = new Set<string>();
    const assignedTabIds = new Set<string>();
    let groupsArrayChanged = false;
    for (const group of groups.value) {
        if (!group.id || validGroupIds.has(group.id)) {
            groupsArrayChanged = true;
            continue;
        }
        validGroupIds.add(group.id);

        const nextTabIds: string[] = [];
        let groupTabsChanged = false;
        for (const tabId of group.tabIds) {
            if (!validTabIds.has(tabId) || assignedTabIds.has(tabId)) {
                groupTabsChanged = true;
                continue;
            }
            assignedTabIds.add(tabId);
            nextTabIds.push(tabId);
        }

        const nextActiveTabId = group.activeTabId && nextTabIds.includes(group.activeTabId)
            ? group.activeTabId
            : (nextTabIds[0] ?? null);
        if (groupTabsChanged || nextActiveTabId !== group.activeTabId) {
            groupsArrayChanged = true;
            normalizedGroups.push({
                id: group.id,
                tabIds: nextTabIds,
                activeTabId: nextActiveTabId,
            });
            continue;
        }

        normalizedGroups.push(group);
    }

    if (normalizedGroups.length === 0) {
        const fallback = createGroup();
        normalizedGroups.push(fallback);
        validGroupIds.add(fallback.id);
        groupsArrayChanged = true;
    }

    if (groupsArrayChanged) {
        groups.value = normalizedGroups;
    }

    const fallbackGroup = groups.value[0]!;

    for (const tab of tabs.value) {
        if (assignedTabIds.has(tab.id)) {
            continue;
        }
        fallbackGroup.tabIds.push(tab.id);
        assignedTabIds.add(tab.id);
    }

    for (const group of groups.value) {
        const nextActiveTabId = group.activeTabId && group.tabIds.includes(group.activeTabId)
            ? group.activeTabId
            : (group.tabIds[0] ?? null);
        if (group.activeTabId !== nextActiveTabId) {
            group.activeTabId = nextActiveTabId;
        }
    }

    const freshGroupIds = new Set(groups.value.map(group => group.id));
    let nextLayout = layout.value;
    if (layout.value) {
        nextLayout = pruneLayoutToExistingGroups(layout.value, freshGroupIds);
    }
    if (!nextLayout) {
        nextLayout = {
            type: 'leaf',
            groupId: groups.value[0]!.id,
        };
    }

    const layoutGroupIds = new Set<string>();
    collectLayoutGroupIds(nextLayout, layoutGroupIds);
    for (const group of groups.value) {
        if (layoutGroupIds.has(group.id)) {
            continue;
        }
        nextLayout = appendGroupToLayout(nextLayout, group.id);
        layoutGroupIds.add(group.id);
    }
    if (layout.value !== nextLayout) {
        layout.value = nextLayout;
    }

    if (!activeGroupId.value || !freshGroupIds.has(activeGroupId.value)) {
        activeGroupId.value = groups.value[0]?.id ?? null;
    }

    const nextMru = buildNormalizedGroupMru(
        activeGroupId.value,
        groupMru.value,
        groups.value.map(group => group.id),
        freshGroupIds,
    );
    if (!arraysEqual(groupMru.value, nextMru)) {
        groupMru.value = nextMru;
    }
}

function createGroup(): IEditorGroupState {
    return {
        id: crypto.randomUUID(),
        tabIds: [],
        activeTabId: null,
    };
}

function createEmptyTab(initial?: ICreateTabOptions['initial']): ITab {
    return {
        id: crypto.randomUUID(),
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

function removeLeafNode(
    node: TEditorLayoutNode,
    groupId: string,
): TEditorLayoutNode | null {
    if (node.type === 'leaf') {
        if (node.groupId === groupId) {
            return null;
        }
        return node;
    }

    const nextFirst = removeLeafNode(node.first, groupId);
    const nextSecond = removeLeafNode(node.second, groupId);

    if (!nextFirst && !nextSecond) {
        return null;
    }
    if (!nextFirst) {
        return nextSecond;
    }
    if (!nextSecond) {
        return nextFirst;
    }

    return {
        ...node,
        first: nextFirst,
        second: nextSecond,
    };
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

function collectGroupRects(
    node: TEditorLayoutNode,
    x: number,
    y: number,
    width: number,
    height: number,
    target: IEditorGroupRect[],
) {
    if (node.type === 'leaf') {
        target.push({
            groupId: node.groupId,
            x,
            y,
            width,
            height,
        });
        return;
    }

    const ratio = Math.max(0.1, Math.min(0.9, node.ratio));
    if (node.orientation === 'horizontal') {
        const firstWidth = width * ratio;
        const secondWidth = width - firstWidth;
        collectGroupRects(node.first, x, y, firstWidth, height, target);
        collectGroupRects(node.second, x + firstWidth, y, secondWidth, height, target);
        return;
    }

    const firstHeight = height * ratio;
    const secondHeight = height - firstHeight;
    collectGroupRects(node.first, x, y, width, firstHeight, target);
    collectGroupRects(node.second, x, y + firstHeight, width, secondHeight, target);
}

function getRects() {
    if (!layout.value) {
        return [];
    }

    const rects: IEditorGroupRect[] = [];
    collectGroupRects(layout.value, 0, 0, 1, 1, rects);
    return rects;
}

function overlapAmount(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function getMruRank(groupId: string) {
    const index = groupMru.value.indexOf(groupId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function findDirectionalGroup(
    sourceGroupId: string,
    direction: TGroupDirection,
    wrap = true,
) {
    const rects = getRects();
    const sourceRect = rects.find(rect => rect.groupId === sourceGroupId);
    if (!sourceRect) {
        return null;
    }

    interface IScore {
        groupId: string;
        distance: number;
        overlap: number;
        mruRank: number;
    }

    const candidates: IScore[] = [];
    for (const rect of rects) {
        if (rect.groupId === sourceGroupId) {
            continue;
        }

        let distance = Number.MAX_VALUE;
        let overlap = 0;

        if (direction === 'right') {
            if (rect.x >= sourceRect.x + sourceRect.width - 1e-6) {
                distance = rect.x - (sourceRect.x + sourceRect.width);
                overlap = overlapAmount(
                    sourceRect.y,
                    sourceRect.y + sourceRect.height,
                    rect.y,
                    rect.y + rect.height,
                );
            }
        } else if (direction === 'left') {
            if (rect.x + rect.width <= sourceRect.x + 1e-6) {
                distance = sourceRect.x - (rect.x + rect.width);
                overlap = overlapAmount(
                    sourceRect.y,
                    sourceRect.y + sourceRect.height,
                    rect.y,
                    rect.y + rect.height,
                );
            }
        } else if (direction === 'down') {
            if (rect.y >= sourceRect.y + sourceRect.height - 1e-6) {
                distance = rect.y - (sourceRect.y + sourceRect.height);
                overlap = overlapAmount(
                    sourceRect.x,
                    sourceRect.x + sourceRect.width,
                    rect.x,
                    rect.x + rect.width,
                );
            }
        } else if (direction === 'up') {
            if (rect.y + rect.height <= sourceRect.y + 1e-6) {
                distance = sourceRect.y - (rect.y + rect.height);
                overlap = overlapAmount(
                    sourceRect.x,
                    sourceRect.x + sourceRect.width,
                    rect.x,
                    rect.x + rect.width,
                );
            }
        }

        if (distance !== Number.MAX_VALUE) {
            candidates.push({
                groupId: rect.groupId,
                distance,
                overlap,
                mruRank: getMruRank(rect.groupId),
            });
        }
    }

    const sortScores = (left: IScore, right: IScore) => {
        if (left.distance !== right.distance) {
            return left.distance - right.distance;
        }
        if (left.overlap !== right.overlap) {
            return right.overlap - left.overlap;
        }
        return left.mruRank - right.mruRank;
    };

    if (candidates.length > 0) {
        candidates.sort(sortScores);
        const candidate = candidates[0];
        return candidate ? getGroupById(candidate.groupId) : null;
    }

    if (!wrap) {
        return null;
    }

    const wrapCandidates = rects
        .filter(rect => rect.groupId !== sourceGroupId)
        .map((rect) => {
            let anchor = 0;
            let overlap = 0;

            if (direction === 'right') {
                anchor = rect.x;
                overlap = overlapAmount(
                    sourceRect.y,
                    sourceRect.y + sourceRect.height,
                    rect.y,
                    rect.y + rect.height,
                );
            } else if (direction === 'left') {
                anchor = rect.x + rect.width;
                overlap = overlapAmount(
                    sourceRect.y,
                    sourceRect.y + sourceRect.height,
                    rect.y,
                    rect.y + rect.height,
                );
            } else if (direction === 'down') {
                anchor = rect.y;
                overlap = overlapAmount(
                    sourceRect.x,
                    sourceRect.x + sourceRect.width,
                    rect.x,
                    rect.x + rect.width,
                );
            } else {
                anchor = rect.y + rect.height;
                overlap = overlapAmount(
                    sourceRect.x,
                    sourceRect.x + sourceRect.width,
                    rect.x,
                    rect.x + rect.width,
                );
            }

            return {
                groupId: rect.groupId,
                anchor,
                overlap,
                mruRank: getMruRank(rect.groupId),
            };
        });

    wrapCandidates.sort((left, right) => {
        if (direction === 'right' || direction === 'down') {
            if (left.anchor !== right.anchor) {
                return left.anchor - right.anchor;
            }
        } else if (left.anchor !== right.anchor) {
            return right.anchor - left.anchor;
        }

        if (left.overlap !== right.overlap) {
            return right.overlap - left.overlap;
        }

        return left.mruRank - right.mruRank;
    });

    const wrapCandidate = wrapCandidates[0];
    return wrapCandidate ? getGroupById(wrapCandidate.groupId) : null;
}

function replaceLeafWithSplit(
    node: TEditorLayoutNode,
    sourceGroupId: string,
    splitNode: IEditorLayoutSplitNode,
): TEditorLayoutNode {
    if (node.type === 'leaf') {
        return node.groupId === sourceGroupId ? splitNode : node;
    }

    return {
        ...node,
        first: replaceLeafWithSplit(node.first, sourceGroupId, splitNode),
        second: replaceLeafWithSplit(node.second, sourceGroupId, splitNode),
    };
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
        id: crypto.randomUUID(),
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
    const clamped = Math.max(0.15, Math.min(0.85, nextRatio));

    function updateNode(node: TEditorLayoutNode): TEditorLayoutNode {
        if (node.type === 'leaf') {
            return node;
        }

        if (node.id === splitId) {
            return {
                ...node,
                ratio: clamped,
            };
        }

        return {
            ...node,
            first: updateNode(node.first),
            second: updateNode(node.second),
        };
    }

    if (!layout.value) {
        return;
    }

    layout.value = updateNode(layout.value);
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

export const useEditorGroupsManager = () => {
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
