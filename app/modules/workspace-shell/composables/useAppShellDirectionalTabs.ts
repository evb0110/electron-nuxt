import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TSplitPayload } from '@contracts/window-tabs';
import { workspaceHasPdf } from '@app/modules/workspace-shell/composables/useMenuSync';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/composables/workspace-split-payload-cleanup';
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
import { hasElectronAPI } from '@app/utils/platform';
import { isWindowTabTransferSupported } from '@app/utils/platform-window-tabs';
import { getDocumentsCapability } from '@app/utils/platform-documents';

const TAB_TRANSITION_CACHE_GRACE_MS = 1200;
const DIRECTION_ORDER: TGroupDirection[] = [
    'left',
    'right',
    'up',
    'down',
];

interface IWorkspaceSplitCacheLike {
    set: (tabId: string, payload: TSplitPayload | null | undefined) => string | null;
    clear: (tabId: string, entryId?: string | null) => void;
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

type TDirectionalTabContextCommand = Extract<TTabContextCommand, { direction: TGroupDirection }>;
type TStaticTabContextCommand = Exclude<TTabContextCommand, TDirectionalTabContextCommand>;
type TStaticTabContextCommandWithoutTargetWindow = Exclude<TStaticTabContextCommand, { kind: 'move-to-window' }>;

function createDirectionalAvailability(value: boolean): TDirectionalCommandAvailability {
    return {
        left: value,
        right: value,
        up: value,
        down: value,
    };
}

function hasTabs(group: IEditorGroupState | null | undefined) {
    return Boolean(group && group.tabIds.length > 0);
}

export const useAppShellDirectionalTabs = (options: IUseAppShellDirectionalTabsOptions) => {
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
    const canTransferTabsAcrossWindows = computed(() => hasElectronAPI() || isWindowTabTransferSupported());

    function getDirectionalTargetGroup(sourceGroupId: string, direction: TGroupDirection) {
        return findDirectionalGroup(sourceGroupId, direction, false);
    }

    function buildDirectionalCommandAvailability(
        group: IEditorGroupState,
        hasActiveTab: boolean,
        transitionsBusy: boolean,
    ) {
        const focus = createDirectionalAvailability(false);
        const move = createDirectionalAvailability(false);
        const copy = createDirectionalAvailability(false);

        for (const direction of DIRECTION_ORDER) {
            const focusTarget = findDirectionalGroup(group.id, direction, true);
            const directionalTarget = getDirectionalTargetGroup(group.id, direction);
            const hasUsableDirectionalGroup = hasTabs(directionalTarget);
            const canUseDirectionalGroup = hasActiveTab && hasUsableDirectionalGroup && !transitionsBusy;

            focus[direction] = groups.value.length > 1 && hasTabs(focusTarget) && !transitionsBusy;
            move[direction] = canUseDirectionalGroup;
            copy[direction] = canUseDirectionalGroup;
        }

        return {
            focus,
            move,
            copy,
        };
    }

    function buildTabContextAvailabilityForGroup(
        group: IEditorGroupState,
        transitionsBusy: boolean,
    ): ITabContextAvailability {
        const activeTabIdForGroup = group.activeTabId;
        const hasActiveTab = Boolean(activeTabIdForGroup);
        const closeBlocked = activeTabIdForGroup
            ? isSingletonPlaceholderCloseBlocked(group.id, activeTabIdForGroup)
            : false;
        const {
            focus,
            move,
            copy,
        } = buildDirectionalCommandAvailability(group, hasActiveTab, transitionsBusy);

        return {
            split: createDirectionalAvailability(hasActiveTab && !transitionsBusy),
            splitEmpty: createDirectionalAvailability(!transitionsBusy),
            focus,
            move,
            copy,
            canClose: hasActiveTab && !transitionsBusy && !closeBlocked,
            canCreate: !transitionsBusy,
            canMoveToNewWindow: canTransferTabsAcrossWindows.value && tabs.value.length > 1 && !transitionsBusy,
        };
    }

    function scheduleSplitCacheCleanup(tabId: string, entryId: string | null) {
        if (!entryId) {
            return;
        }

        const previousTimer = splitCacheCleanupTimers.get(tabId);
        if (previousTimer) {
            clearTimeout(previousTimer);
        }

        const timer = setTimeout(() => {
            splitCacheCleanupTimers.delete(tabId);
            const workspace = workspaceRefs.value.get(tabId);
            // DjVu mode has hasPdf=false; without this check the cache entry would never be cleared
            if (workspace && (workspaceHasPdf(workspace) || workspace.getToolbarSnapshot().isDjvuMode)) {
                workspaceSplitCache.clear(tabId, entryId);
            }
        }, TAB_TRANSITION_CACHE_GRACE_MS);
        timer.unref?.();
        splitCacheCleanupTimers.set(tabId, timer);
    }

    async function captureActiveTabPayload() {
        const sourceGroup = getGroupById(activeGroupId.value);
        const sourceTabId = sourceGroup?.activeTabId ?? null;
        const sourceTab = getTabById(sourceTabId);
        if (!sourceGroup || !sourceTabId || !sourceTab) {
            return null;
        }

        const payload = await captureWorkspacePayload(sourceTabId);
        if (!payload) {
            return null;
        }

        return {
            payload,
            sourceGroup,
            sourceTab,
            sourceTabId,
        };
    }

    async function createIndependentSplitRestorePayload(payload: TSplitPayload): Promise<TSplitPayload> {
        if (payload.kind !== 'pdfSnapshot') {
            return payload;
        }

        const snapshotPath = await getDocumentsCapability().createWorkingCopyFromPath(
            payload.snapshotPath,
            payload.originalPath ?? undefined,
        );
        return {
            ...payload,
            snapshotPath,
        };
    }

    const tabContextAvailabilityByGroup = computed<Record<string, ITabContextAvailability>>(() => {
        const result: Record<string, ITabContextAvailability> = {};
        const transitionsBusy = isTabTransitionBusy.value;

        for (const group of groups.value) {
            result[group.id] = buildTabContextAvailabilityForGroup(group, transitionsBusy);
        }

        return result;
    });

    async function splitEditor(direction: TGroupDirection) {
        await enqueueTabTransition(async () => {
            const activeTabPayload = await captureActiveTabPayload();
            if (!activeTabPayload) {
                return;
            }
            const {
                payload,
                sourceGroup,
                sourceTab,
                sourceTabId,
            } = activeTabPayload;

            const cacheEntryId = workspaceSplitCache.set(sourceTabId, payload);
            scheduleSplitCacheCleanup(sourceTabId, cacheEntryId);

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

            const targetPayload = await createIndependentSplitRestorePayload(payload);
            const restored = await restoreWorkspacePayload(newTab.id, targetPayload);
            if (!restored) {
                await cleanupSplitPayloadSnapshot(targetPayload, {
                    logSection: 'split-cache',
                    context: 'split-editor-restore-failed',
                    metadata: { tabId: newTab.id },
                });
                removeTabFromState(newTab.id);
                activateTab(sourceGroup.id, sourceTabId);
                return;
            }

            activateGroup(sourceGroup.id);
            activateTab(sourceGroup.id, sourceTabId);
            cleanupEmptyGroups();
        });
    }

    async function splitEditorEmpty(direction: TGroupDirection) {
        await enqueueTabTransition(async () => {
            const sourceGroup = getGroupById(activeGroupId.value);
            const sourceTabId = sourceGroup?.activeTabId ?? null;
            if (!sourceGroup) {
                return;
            }

            if (sourceTabId) {
                const payload = await captureWorkspacePayload(sourceTabId);
                if (payload) {
                    const cacheEntryId = workspaceSplitCache.set(sourceTabId, payload);
                    scheduleSplitCacheCleanup(sourceTabId, cacheEntryId);
                }
            }

            const newGroupId = splitGroup(sourceGroup.id, direction);
            if (!newGroupId) {
                return;
            }

            createTab({
                groupId: newGroupId,
                activate: true,
            });

            activateGroup(newGroupId);
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
                const cacheEntryId = workspaceSplitCache.set(sourceTabId, payload);
                scheduleSplitCacheCleanup(sourceTabId, cacheEntryId);
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
            const activeTabPayload = await captureActiveTabPayload();
            if (!activeTabPayload) {
                return;
            }
            const {
                payload,
                sourceGroup,
                sourceTab,
                sourceTabId,
            } = activeTabPayload;

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

    function isDirectionalContextCommand(command: TTabContextCommand): command is TDirectionalTabContextCommand {
        return 'direction' in command;
    }

    function getStaticContextCommandRunner(
        groupId: string,
        tabId: string,
        command: TStaticTabContextCommand,
    ) {
        if (command.kind === 'move-to-window') {
            return () => moveTabToWindow(command.targetWindowId, tabId);
        }

        const handlers = {
            'new-tab': () => {
                createTab({
                    groupId,
                    activate: true,
                });
                return Promise.resolve();
            },
            'close-tab': () => handleCloseTab(groupId, tabId),
            'move-to-new-window': () => moveTabToNewWindow(tabId),
        } satisfies Record<TStaticTabContextCommandWithoutTargetWindow['kind'], () => Promise<void>>;

        return handlers[command.kind];
    }

    async function runDirectionalContextCommand(command: TDirectionalTabContextCommand) {
        const handlers = {
            split: splitEditor,
            'split-empty': splitEditorEmpty,
            focus: (direction: TGroupDirection) => {
                focusEditorGroup(direction);
                return Promise.resolve();
            },
            move: moveActiveTab,
            copy: copyActiveTab,
        } satisfies Record<TDirectionalTabContextCommand['kind'], (direction: TGroupDirection) => Promise<void>>;

        await handlers[command.kind](command.direction);
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
        await runTabContextCommand(groupId, tabId, command);
    }

    async function runTabContextCommand(
        groupId: string,
        tabId: string,
        command: TTabContextCommand,
    ) {
        if (isDirectionalContextCommand(command)) {
            await runDirectionalContextCommand(command);
            return;
        }

        await getStaticContextCommandRunner(groupId, tabId, command)();
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
        splitEditorEmpty,
        focusEditorGroup,
        moveActiveTab,
        copyActiveTab,
        handleTabContextCommand,
        handleTabMoveDirection,
        cleanup,
    };
};
