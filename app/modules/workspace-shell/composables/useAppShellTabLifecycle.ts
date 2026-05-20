import type { Ref } from 'vue';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/composables/workspaceTabDocumentHint';
import { workspaceHasPdf } from '@app/modules/workspace-shell/composables/useMenuSync';
import type { IEditorGroupState } from '@app/types/editorGroups';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';

interface IWorkspaceSplitCacheLike {
    has: (tabId: string) => boolean;
    clear: (tabId: string) => void;
}

interface IWorkspaceRestoreTrackerLike {
    has: (tabId: string) => boolean;
    start: (tabId: string) => void;
    finish: (tabId: string) => void;
}

interface IUseAppShellTabLifecycleOptions {
    groups: Ref<IEditorGroupState[]>;
    tabs: Ref<ITab[]>;
    activeGroupId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    hasTeleportedToolbarContent: Ref<boolean>;
    workspaceSplitCache: IWorkspaceSplitCacheLike;
    workspaceRestoreTracker: IWorkspaceRestoreTrackerLike;
    getGroupById: (groupId: string | null | undefined) => IEditorGroupState | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    getGroupByTabId: (tabId: string | null | undefined) => IEditorGroupState | null;
    activateGroup: (groupId: string) => void;
    activateTab: (groupId: string, tabId: string) => void;
    closeTab: (groupId: string, tabId: string) => void;
    closeGroup: (groupId: string) => void;
    requestDirtyTabCloseConfirmation: (tabId: string) => Promise<boolean>;
}

interface ICloseHandoffTarget {
    groupId: string;
    tabId: string;
}

export const useAppShellTabLifecycle = (options: IUseAppShellTabLifecycleOptions) => {
    const {
        groups,
        tabs,
        activeGroupId,
        activeTabId,
        workspaceRefs,
        hasTeleportedToolbarContent,
        workspaceSplitCache,
        workspaceRestoreTracker,
        getGroupById,
        getTabById,
        getGroupByTabId,
        activateGroup,
        activateTab,
        closeTab,
        closeGroup,
        requestDirtyTabCloseConfirmation,
    } = options;

    const activeTabTransitions = ref(0);
    let tabTransitionQueue: Promise<void> = Promise.resolve();
    let afterTransitionHook: (() => void) | null = null;

    const isTabTransitionBusy = computed(() => activeTabTransitions.value > 0);

    function isClearedDocumentTabState(tab: ITab) {
        return !tabHasDocumentHint(tab)
            && tab.fileName === null
            && tab.originalPath === null
            && !tab.isDjvu
            && !tab.isDirty;
    }

    function isTransientDocumentClearDuringRemount(tabId: string, tab: ITab, nextTabState: ITab) {
        return tabHasDocumentHint(tab)
            && isClearedDocumentTabState(nextTabState)
            && (
                isTabTransitionBusy.value
                || workspaceSplitCache.has(tabId)
                || workspaceRestoreTracker.has(tabId)
                || (activeTabId.value === tabId && !hasTeleportedToolbarContent.value)
            );
    }

    function logSuppressedDocumentClearDuringRemount(tabId: string, updates: Partial<ITab>, tab: ITab, nextTabState: ITab) {
        BrowserLogger.warn('toolbar-transition', 'Suppressing transient placeholder tab update during remount handoff', {
            tabId,
            updates,
            activeTabId: activeTabId.value,
            activeGroupId: activeGroupId.value,
            isTabTransitionBusy: isTabTransitionBusy.value,
            hasSplitCache: workspaceSplitCache.has(tabId),
            isRestoreTracked: workspaceRestoreTracker.has(tabId),
            previousTabState: {
                fileName: tab.fileName,
                originalPath: tab.originalPath,
                isDirty: tab.isDirty,
                isDjvu: tab.isDjvu,
            },
            nextTabState: {
                fileName: nextTabState.fileName,
                originalPath: nextTabState.originalPath,
                isDirty: nextTabState.isDirty,
                isDjvu: nextTabState.isDjvu,
            },
        });
    }

    function enqueueTabTransition<T>(task: () => Promise<T>): Promise<T> {
        const chained = tabTransitionQueue.then(async () => {
            activeTabTransitions.value += 1;
            try {
                return await task();
            } finally {
                await nextTick();
                activeTabTransitions.value = Math.max(0, activeTabTransitions.value - 1);
                afterTransitionHook?.();
            }
        });

        tabTransitionQueue = chained.then(
            () => undefined,
            () => undefined,
        );

        return chained;
    }

    function updateTab(tabId: string, updates: Partial<ITab>) {
        const tab = getTabById(tabId);
        if (!tab) {
            return;
        }

        const nextTabState: ITab = {
            ...tab,
            ...updates,
        };

        if (isTransientDocumentClearDuringRemount(tabId, tab, nextTabState)) {
            logSuppressedDocumentClearDuringRemount(tabId, updates, tab, nextTabState);
            return;
        }

        Object.assign(tab, updates);
    }

    function removeTabFromState(tabId: string) {
        const group = getGroupByTabId(tabId);
        if (group) {
            closeTab(group.id, tabId);
        }
        workspaceSplitCache.clear(tabId);
    }

    function cleanupEmptyGroups() {
        for (const group of [...groups.value]) {
            if (groups.value.length <= 1) {
                break;
            }
            if (group.tabIds.length === 0) {
                closeGroup(group.id);
            }
        }
    }

    function isPlaceholderTab(tab: ITab) {
        return tab.fileName === null
            && tab.originalPath === null
            && !tab.isDirty
            && !tab.isDjvu;
    }

    function isSingletonPlaceholderCloseBlocked(groupId: string, tabId: string) {
        if (tabs.value.length !== 1) {
            return false;
        }

        const group = getGroupById(groupId);
        if (!group || group.tabIds.length !== 1 || !group.tabIds.includes(tabId)) {
            return false;
        }

        const tab = getTabById(tabId);
        if (!tab || !isPlaceholderTab(tab)) {
            return false;
        }

        const workspace = workspaceRefs.value.get(tabId) ?? null;
        return !workspaceHasPdf(workspace);
    }

    function resolveTabForAction(tabId: string | undefined) {
        const resolvedTabId = tabId ?? activeTabId.value ?? undefined;
        if (!resolvedTabId) {
            return null;
        }

        const tab = getTabById(resolvedTabId);
        if (!tab) {
            return null;
        }

        const group = getGroupByTabId(resolvedTabId);
        if (!group) {
            return null;
        }

        return {
            tab,
            group,
        };
    }

    function scoreTabDocumentReadiness(tabId: string) {
        const workspace = workspaceRefs.value.get(tabId) ?? null;
        if (workspaceHasPdf(workspace)) {
            return 3;
        }

        const tab = getTabById(tabId);
        if (tab && tabHasDocumentHint(tab)) {
            return 2;
        }

        return 1;
    }

    function pickBestTabCandidate(tabIds: Array<string | null | undefined>) {
        const uniqueTabIds = uniq(tabIds.filter((tabId): tabId is string => Boolean(tabId)));

        let bestTabId: string | null = null;
        let bestScore = -1;
        for (const tabId of uniqueTabIds) {
            if (!getTabById(tabId)) {
                continue;
            }
            const score = scoreTabDocumentReadiness(tabId);
            if (score > bestScore) {
                bestScore = score;
                bestTabId = tabId;
            }
        }

        return bestTabId;
    }

    function pickSameGroupCloseReplacement(sourceGroup: IEditorGroupState, tabId: string) {
        const closingTabIndex = sourceGroup.tabIds.indexOf(tabId);
        if (closingTabIndex === -1) {
            return null;
        }

        return pickBestTabCandidate([
            sourceGroup.tabIds[closingTabIndex + 1],
            sourceGroup.tabIds[closingTabIndex - 1],
            ...sourceGroup.tabIds.filter(candidate => candidate !== tabId),
        ]);
    }

    function pickCrossGroupCloseReplacement(sourceGroupId: string) {
        let bestTarget: (ICloseHandoffTarget & { score: number }) | null = null;

        for (const candidateGroup of groups.value) {
            if (candidateGroup.id === sourceGroupId || candidateGroup.tabIds.length === 0) {
                continue;
            }

            const candidateTabId = pickBestTabCandidate([
                candidateGroup.activeTabId,
                ...candidateGroup.tabIds,
            ]);
            if (!candidateTabId) {
                continue;
            }

            const score = scoreTabDocumentReadiness(candidateTabId);
            if (!bestTarget || score > bestTarget.score) {
                bestTarget = {
                    groupId: candidateGroup.id,
                    tabId: candidateTabId,
                    score,
                };
            }
        }

        return bestTarget
            ? {
                groupId: bestTarget.groupId,
                tabId: bestTarget.tabId,
            }
            : null;
    }

    function resolveCloseHandoffTarget(groupId: string, tabId: string) {
        if (activeGroupId.value !== groupId || activeTabId.value !== tabId) {
            return null;
        }

        const sourceGroup = getGroupById(groupId);
        if (!sourceGroup) {
            return null;
        }

        const sameGroupReplacement = pickSameGroupCloseReplacement(sourceGroup, tabId);
        if (sameGroupReplacement) {
            return {
                groupId: sourceGroup.id,
                tabId: sameGroupReplacement,
            };
        }

        return pickCrossGroupCloseReplacement(sourceGroup.id);
    }

    async function handoffActiveTabBeforeClose(groupId: string, tabId: string) {
        const target = resolveCloseHandoffTarget(groupId, tabId);
        if (!target) {
            return;
        }

        activateGroup(target.groupId);
        activateTab(target.groupId, target.tabId);
        await nextTick();
    }

    function closeTabInState(groupId: string, tabId: string) {
        closeTab(groupId, tabId);
        workspaceSplitCache.clear(tabId);
    }

    function closeResolvedTabInState(groupId: string, tabId: string) {
        const resolvedGroup = getGroupByTabId(tabId) ?? getGroupById(groupId);
        if (resolvedGroup) {
            closeTabInState(resolvedGroup.id, tabId);
        }
    }

    function shouldDeferCloseHandoff(
        sourceGroup: IEditorGroupState | null,
        closeHandoffTarget: ICloseHandoffTarget | null,
    ) {
        return Boolean(
            sourceGroup
            && closeHandoffTarget
            && sourceGroup.tabIds.length === 1
            && closeHandoffTarget.groupId !== sourceGroup.id,
        );
    }

    async function activateDeferredCloseHandoff(
        shouldDeferCrossGroupHandoff: boolean,
        closeHandoffTarget: ICloseHandoffTarget | null,
    ) {
        if (!shouldDeferCrossGroupHandoff || !closeHandoffTarget) {
            return;
        }

        const targetTab = getTabById(closeHandoffTarget.tabId);
        const targetGroup = getGroupById(closeHandoffTarget.groupId)
            ?? getGroupByTabId(closeHandoffTarget.tabId);
        if (!targetTab || !targetGroup || !targetGroup.tabIds.includes(targetTab.id)) {
            return;
        }

        activateGroup(targetGroup.id);
        activateTab(targetGroup.id, targetTab.id);
        await nextTick();
    }

    function resolveCloseHandoffContext(groupId: string, tabId: string) {
        const sourceGroupBeforeClose = getGroupById(groupId);
        const closeHandoffTarget = resolveCloseHandoffTarget(groupId, tabId);
        return {
            closeHandoffTarget,
            shouldDeferCrossGroupHandoff: shouldDeferCloseHandoff(sourceGroupBeforeClose, closeHandoffTarget),
        };
    }

    async function resolveClosePersistence(tabId: string, tab: ITab) {
        if (!tab.isDirty) {
            return true;
        }

        const confirmed = await requestDirtyTabCloseConfirmation(tabId);
        return confirmed ? false : null;
    }

    function workspaceHasCloseableDocument(workspace: IWorkspaceExpose | undefined): workspace is IWorkspaceExpose {
        // DjVu workspaces also need proper close handling (temp cleanup, exitDjvuMode).
        return Boolean(workspace && (workspaceHasPdf(workspace) || workspace.getToolbarSnapshot().isDjvuMode));
    }

    async function closeWorkspaceDocument(
        groupId: string,
        tabId: string,
        workspace: IWorkspaceExpose,
        shouldPersistBeforeClose: boolean,
    ) {
        workspaceRestoreTracker.start(tabId);
        let closed = false;
        try {
            closed = await workspace.handleCloseFileFromUi({ persist: shouldPersistBeforeClose });
        } finally {
            workspaceRestoreTracker.finish(tabId);
        }

        if (closed && !workspaceHasPdf(workspace) && !workspace.getToolbarSnapshot().isDjvuMode) {
            closeResolvedTabInState(groupId, tabId);
        }
    }

    async function closeTabDuringTransition(groupId: string, tabId: string) {
        const tab = getTabById(tabId);
        if (!tab) {
            return;
        }

        const {
            closeHandoffTarget,
            shouldDeferCrossGroupHandoff,
        } = resolveCloseHandoffContext(groupId, tabId);

        const shouldPersistBeforeClose = await resolveClosePersistence(tabId, tab);
        if (shouldPersistBeforeClose === null) {
            return;
        }

        if (!shouldDeferCrossGroupHandoff) {
            await handoffActiveTabBeforeClose(groupId, tabId);
        }

        const workspace = workspaceRefs.value.get(tabId);
        if (workspaceHasCloseableDocument(workspace)) {
            await closeWorkspaceDocument(groupId, tabId, workspace, shouldPersistBeforeClose);
        } else {
            closeResolvedTabInState(groupId, tabId);
        }

        cleanupEmptyGroups();
        await activateDeferredCloseHandoff(shouldDeferCrossGroupHandoff, closeHandoffTarget);
    }

    async function handleCloseTab(groupId: string, tabId: string) {
        if (isSingletonPlaceholderCloseBlocked(groupId, tabId)) {
            return;
        }

        await enqueueTabTransition(() => closeTabDuringTransition(groupId, tabId));
    }

    return {
        isTabTransitionBusy,
        enqueueTabTransition,
        setAfterTransitionHook: (callback: (() => void) | null) => {
            afterTransitionHook = callback;
        },
        updateTab,
        removeTabFromState,
        cleanupEmptyGroups,
        isSingletonPlaceholderCloseBlocked,
        resolveTabForAction,
        closeTabInState,
        handoffActiveTabBeforeClose,
        handleCloseTab,
    };
};
