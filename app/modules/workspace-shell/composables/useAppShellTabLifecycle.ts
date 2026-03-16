import type { Ref } from 'vue';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browser-logger';
import { hasDocumentMountHint } from '@app/modules/workspace-shell/composables/workspace-host-mounting';
import { workspaceHasPdf } from '@app/modules/workspace-shell/composables/useMenuSync';
import type { IEditorGroupState } from '@app/types/editor-groups';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';

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

export function useAppShellTabLifecycle(options: IUseAppShellTabLifecycleOptions) {
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

        const wasDocumentTab = hasDocumentMountHint(tab);
        const becomesPlaceholder = !hasDocumentMountHint(nextTabState)
            && nextTabState.fileName === null
            && nextTabState.originalPath === null
            && !nextTabState.isDjvu
            && !nextTabState.isDirty;
        const shouldSuppressPlaceholderDowngrade = wasDocumentTab
            && becomesPlaceholder
            && (
                isTabTransitionBusy.value
                || workspaceSplitCache.has(tabId)
                || workspaceRestoreTracker.has(tabId)
                || (activeTabId.value === tabId && !hasTeleportedToolbarContent.value)
            );

        if (shouldSuppressPlaceholderDowngrade) {
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
        if (tab && hasDocumentMountHint(tab)) {
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

    function resolveCloseHandoffTarget(groupId: string, tabId: string) {
        if (activeGroupId.value !== groupId || activeTabId.value !== tabId) {
            return null;
        }

        const sourceGroup = getGroupById(groupId);
        if (!sourceGroup) {
            return null;
        }

        const closingTabIndex = sourceGroup.tabIds.indexOf(tabId);
        if (closingTabIndex === -1) {
            return null;
        }

        const sameGroupReplacement = pickBestTabCandidate([
            sourceGroup.tabIds[closingTabIndex + 1],
            sourceGroup.tabIds[closingTabIndex - 1],
            ...sourceGroup.tabIds.filter(candidate => candidate !== tabId),
        ]);
        if (sameGroupReplacement) {
            return {
                groupId: sourceGroup.id,
                tabId: sameGroupReplacement,
            };
        }

        let bestTarget: {
            groupId: string;
            tabId: string;
            score: number;
        } | null = null;

        for (const candidateGroup of groups.value) {
            if (candidateGroup.id === sourceGroup.id || candidateGroup.tabIds.length === 0) {
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

        if (!bestTarget) {
            return null;
        }

        return {
            groupId: bestTarget.groupId,
            tabId: bestTarget.tabId,
        };
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

    async function handleCloseTab(groupId: string, tabId: string) {
        if (isSingletonPlaceholderCloseBlocked(groupId, tabId)) {
            return;
        }

        await enqueueTabTransition(async () => {
            const tab = getTabById(tabId);
            if (!tab) {
                return;
            }

            const sourceGroupBeforeClose = getGroupById(groupId);
            const closeHandoffTarget = resolveCloseHandoffTarget(groupId, tabId);
            const shouldDeferCrossGroupHandoff = Boolean(
                sourceGroupBeforeClose
                && closeHandoffTarget
                && sourceGroupBeforeClose.tabIds.length === 1
                && closeHandoffTarget.groupId !== sourceGroupBeforeClose.id,
            );

            const activateDeferredCloseHandoff = async () => {
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
            };

            let shouldPersistBeforeClose = true;
            if (tab.isDirty) {
                const confirmed = await requestDirtyTabCloseConfirmation(tabId);
                if (!confirmed) {
                    return;
                }
                shouldPersistBeforeClose = false;
            }

            if (!shouldDeferCrossGroupHandoff) {
                await handoffActiveTabBeforeClose(groupId, tabId);
            }

            const workspace = workspaceRefs.value.get(tabId);
            if (workspace && workspaceHasPdf(workspace)) {
                workspaceRestoreTracker.start(tabId);
                try {
                    await workspace.handleCloseFileFromUi({ persist: shouldPersistBeforeClose });
                } finally {
                    workspaceRestoreTracker.finish(tabId);
                }

                if (!workspaceHasPdf(workspace)) {
                    const resolvedGroup = getGroupByTabId(tabId) ?? getGroupById(groupId);
                    if (resolvedGroup) {
                        closeTabInState(resolvedGroup.id, tabId);
                    }
                }
                cleanupEmptyGroups();
                await activateDeferredCloseHandoff();
                return;
            }

            const resolvedGroup = getGroupByTabId(tabId) ?? getGroupById(groupId);
            if (resolvedGroup) {
                closeTabInState(resolvedGroup.id, tabId);
            }

            cleanupEmptyGroups();
            await activateDeferredCloseHandoff();
        });
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
}
