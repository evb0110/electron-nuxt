import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TSplitPayload } from '@contracts/window-tabs';
import { workspaceHasPdf } from '@app/modules/workspace-shell/composables/useMenuSync';
import type {
    IEditorGroupState,
    TGroupDirection,
} from '@app/types/editor-groups';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type {
    ITabContextAvailability,
    TDirectionalCommandAvailability,
    TTabContextCommand,
} from '@app/types/tab-context-menu';

const TAB_TRANSITION_CACHE_GRACE_MS = 1200;
const DIRECTION_ORDER: TGroupDirection[] = [
    'left',
    'right',
    'up',
    'down',
];

interface IWorkspaceSplitCacheLike {
    set: (tabId: string, payload: TSplitPayload | null | undefined) => void;
    clear: (tabId: string) => void;
}

interface IUseAppShellDirectionalTabsOptions {
    activeGroupId: Ref<string | null>;
    groups: Ref<IEditorGroupState[]>;
    tabs: Ref<ITab[]>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    isTabTransitionBusy: ComputedRef<boolean>;
    getGroupById: (groupId: string | null | undefined) => IEditorGroupState | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    findDirectionalGroup: (sourceGroupId: string, direction: TGroupDirection, wrap?: boolean) => IEditorGroupState | null;
    focusGroup: (direction: TGroupDirection, wrap?: boolean) => string | null;
    splitGroup: (sourceGroupId: string, direction: TGroupDirection) => string | null;
    moveTabToGroup: (tabId: string, targetGroupId: string, activate?: boolean) => boolean;
    createTab: (options: {
        groupId?: string | null;
        activate?: boolean;
        initial?: Partial<ITab>;
    }) => ITab;
    activateGroup: (groupId: string) => void;
    activateTab: (groupId: string, tabId: string) => void;
    removeTabFromState: (tabId: string) => void;
    cleanupEmptyGroups: () => void;
    workspaceSplitCache: IWorkspaceSplitCacheLike;
    isSingletonPlaceholderCloseBlocked: (groupId: string, tabId: string) => boolean;
    enqueueTabTransition: <T>(task: () => Promise<T>) => Promise<T>;
    captureWorkspacePayload: (tabId: string) => Promise<TSplitPayload | null>;
    restoreWorkspacePayload: (tabId: string, payload: TSplitPayload | null) => Promise<boolean>;
    moveTabToNewWindow: (tabId: string) => Promise<void>;
    moveTabToWindow: (windowId: number, tabId: string) => Promise<void>;
    handleCloseTab: (groupId: string, tabId: string) => Promise<void>;
}

function createDirectionalAvailability(value: boolean): TDirectionalCommandAvailability {
    return {
        left: value,
        right: value,
        up: value,
        down: value,
    };
}

export function useAppShellDirectionalTabs(options: IUseAppShellDirectionalTabsOptions) {
    const {
        activeGroupId,
        groups,
        tabs,
        workspaceRefs,
        isTabTransitionBusy,
        getGroupById,
        getTabById,
        findDirectionalGroup,
        focusGroup,
        splitGroup,
        moveTabToGroup,
        createTab,
        activateGroup,
        activateTab,
        removeTabFromState,
        cleanupEmptyGroups,
        workspaceSplitCache,
        isSingletonPlaceholderCloseBlocked,
        enqueueTabTransition,
        captureWorkspacePayload,
        restoreWorkspacePayload,
        moveTabToNewWindow,
        moveTabToWindow,
        handleCloseTab,
    } = options;

    const splitCacheCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function getDirectionalTargetGroup(sourceGroupId: string, direction: TGroupDirection) {
        return findDirectionalGroup(sourceGroupId, direction, false);
    }

    function scheduleSplitCacheCleanup(tabId: string) {
        const previousTimer = splitCacheCleanupTimers.get(tabId);
        if (previousTimer) {
            clearTimeout(previousTimer);
        }

        const timer = setTimeout(() => {
            splitCacheCleanupTimers.delete(tabId);
            const workspace = workspaceRefs.value.get(tabId);
            // DjVu mode has hasPdf=false; without this check the cache entry would never be cleared
            if (workspace && (workspaceHasPdf(workspace) || workspace.getToolbarSnapshot().isDjvuMode)) {
                workspaceSplitCache.clear(tabId);
            }
        }, TAB_TRANSITION_CACHE_GRACE_MS);
        timer.unref?.();
        splitCacheCleanupTimers.set(tabId, timer);
    }

    const tabContextAvailabilityByGroup = computed<Record<string, ITabContextAvailability>>(() => {
        const result: Record<string, ITabContextAvailability> = {};
        const transitionsBusy = isTabTransitionBusy.value;

        for (const group of groups.value) {
            const activeTabIdForGroup = group.activeTabId;
            const hasActiveTab = Boolean(activeTabIdForGroup);
            const closeBlocked = activeTabIdForGroup
                ? isSingletonPlaceholderCloseBlocked(group.id, activeTabIdForGroup)
                : false;
            const focus = createDirectionalAvailability(false);
            const move = createDirectionalAvailability(false);
            const copy = createDirectionalAvailability(false);

            for (const direction of DIRECTION_ORDER) {
                const focusTarget = findDirectionalGroup(group.id, direction, true);
                const directionalTarget = getDirectionalTargetGroup(group.id, direction);
                const hasUsableDirectionalGroup = Boolean(directionalTarget && directionalTarget.tabIds.length > 0);
                focus[direction] = groups.value.length > 1
                    ? Boolean(focusTarget && focusTarget.tabIds.length > 0) && !transitionsBusy
                    : false;
                move[direction] = hasActiveTab && hasUsableDirectionalGroup && !transitionsBusy;
                copy[direction] = hasActiveTab && hasUsableDirectionalGroup && !transitionsBusy;
            }

            result[group.id] = {
                split: createDirectionalAvailability(hasActiveTab && !transitionsBusy),
                focus,
                move,
                copy,
                canClose: hasActiveTab && !transitionsBusy && !closeBlocked,
                canCreate: !transitionsBusy,
                canMoveToNewWindow: tabs.value.length > 1 && !transitionsBusy,
            };
        }

        return result;
    });

    async function splitEditor(direction: TGroupDirection) {
        await enqueueTabTransition(async () => {
            const sourceGroup = getGroupById(activeGroupId.value);
            const sourceTabId = sourceGroup?.activeTabId ?? null;
            const sourceTab = getTabById(sourceTabId);
            if (!sourceGroup || !sourceTabId || !sourceTab) {
                return;
            }

            const payload = await captureWorkspacePayload(sourceTabId);
            if (!payload) {
                return;
            }

            workspaceSplitCache.set(sourceTabId, payload);
            scheduleSplitCacheCleanup(sourceTabId);

            const newGroupId = splitGroup(sourceGroup.id, direction);
            if (!newGroupId) {
                return;
            }

            const newTab = createTab({
                groupId: newGroupId,
                activate: false,
                initial: {
                    fileName: sourceTab.fileName,
                    originalPath: sourceTab.originalPath,
                    isDirty: sourceTab.isDirty,
                    isDjvu: sourceTab.isDjvu,
                },
            });

            const restored = await restoreWorkspacePayload(newTab.id, payload);
            if (!restored) {
                removeTabFromState(newTab.id);
                activateTab(sourceGroup.id, sourceTabId);
                return;
            }

            activateGroup(sourceGroup.id);
            activateTab(sourceGroup.id, sourceTabId);
            cleanupEmptyGroups();
        });
    }

    function focusEditorGroup(direction: TGroupDirection) {
        if (isTabTransitionBusy.value) {
            return;
        }
        focusGroup(direction, true);
    }

    function ensureTargetGroupForDirection(direction: TGroupDirection) {
        const sourceGroup = getGroupById(activeGroupId.value);
        if (!sourceGroup) {
            return null;
        }

        const existing = getDirectionalTargetGroup(sourceGroup.id, direction);
        if (!existing || existing.tabIds.length === 0) {
            return null;
        }

        return {
            sourceGroup,
            targetGroupId: existing.id,
        };
    }

    async function moveActiveTab(direction: TGroupDirection) {
        await enqueueTabTransition(async () => {
            const sourceGroup = getGroupById(activeGroupId.value);
            const sourceTabId = sourceGroup?.activeTabId ?? null;
            if (!sourceGroup || !sourceTabId) {
                return;
            }

            const route = ensureTargetGroupForDirection(direction);
            if (!route) {
                return;
            }

            const payload = await captureWorkspacePayload(sourceTabId);
            if (!payload) {
                return;
            }

            if ((payload as { kind?: string }).kind !== 'empty') {
                workspaceSplitCache.set(sourceTabId, payload);
                scheduleSplitCacheCleanup(sourceTabId);
            }

            const moved = moveTabToGroup(sourceTabId, route.targetGroupId, true);
            if (moved) {
                activateTab(route.targetGroupId, sourceTabId);
            }
            cleanupEmptyGroups();
        });
    }

    async function copyActiveTab(direction: TGroupDirection) {
        await enqueueTabTransition(async () => {
            const sourceGroup = getGroupById(activeGroupId.value);
            const sourceTabId = sourceGroup?.activeTabId ?? null;
            const sourceTab = getTabById(sourceTabId);
            if (!sourceGroup || !sourceTabId || !sourceTab) {
                return;
            }

            const payload = await captureWorkspacePayload(sourceTabId);
            if (!payload) {
                return;
            }

            const route = ensureTargetGroupForDirection(direction);
            if (!route) {
                return;
            }

            const targetTab = createTab({
                groupId: route.targetGroupId,
                activate: false,
                initial: {
                    fileName: sourceTab.fileName,
                    originalPath: sourceTab.originalPath,
                    isDirty: sourceTab.isDirty,
                    isDjvu: sourceTab.isDjvu,
                },
            });

            const restored = await restoreWorkspacePayload(targetTab.id, payload);
            if (!restored) {
                removeTabFromState(targetTab.id);
                activateTab(sourceGroup.id, sourceTabId);
                return;
            }

            activateTab(route.targetGroupId, targetTab.id);
            cleanupEmptyGroups();
        });
    }

    async function handleTabContextCommand(
        groupId: string,
        tabId: string,
        command: TTabContextCommand,
    ) {
        const group = getGroupById(groupId);
        if (!group) {
            return;
        }

        activateGroup(groupId);
        activateTab(groupId, tabId);

        if (command.kind === 'new-tab') {
            createTab({
                groupId,
                activate: true,
            });
            return;
        }

        if (command.kind === 'close-tab') {
            await handleCloseTab(groupId, tabId);
            return;
        }

        if (command.kind === 'move-to-new-window') {
            await moveTabToNewWindow(tabId);
            return;
        }

        if (command.kind === 'move-to-window') {
            await moveTabToWindow(command.targetWindowId, tabId);
            return;
        }

        if (command.kind === 'split') {
            await splitEditor(command.direction);
            return;
        }

        if (command.kind === 'focus') {
            focusEditorGroup(command.direction);
            return;
        }

        if (command.kind === 'move') {
            await moveActiveTab(command.direction);
            return;
        }

        await copyActiveTab(command.direction);
    }

    function handleTabMoveDirection(
        groupId: string,
        tabId: string,
        direction: 'left' | 'right',
    ) {
        const group = getGroupById(groupId);
        if (!group || !group.tabIds.includes(tabId)) {
            return;
        }

        activateGroup(groupId);
        activateTab(groupId, tabId);
        void moveActiveTab(direction);
    }

    function cleanup() {
        for (const timer of splitCacheCleanupTimers.values()) {
            clearTimeout(timer);
        }
        splitCacheCleanupTimers.clear();
    }

    return {
        tabContextAvailabilityByGroup,
        splitEditor,
        focusEditorGroup,
        moveActiveTab,
        copyActiveTab,
        handleTabContextCommand,
        handleTabMoveDirection,
        cleanup,
    };
}
