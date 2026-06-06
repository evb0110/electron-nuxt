import type { Ref } from 'vue';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import type { IEditorPaneState } from '@app/types/editorPanes';
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
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    hasTeleportedToolbarContent: Ref<boolean>;
    workspaceSplitCache: IWorkspaceSplitCacheLike;
    workspaceRestoreTracker: IWorkspaceRestoreTrackerLike;
    getPaneById: (paneId: string | null | undefined) => IEditorPaneState | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    getPaneByTabId: (tabId: string | null | undefined) => IEditorPaneState | null;
    activatePane: (paneId: string) => void;
    activateTab: (paneId: string, tabId: string) => void;
    closeTab: (paneId: string, tabId: string) => void;
    closePane: (paneId: string) => void;
    requestDirtyTabCloseConfirmation: (tabId: string) => Promise<boolean>;
}

interface ICloseHandoffTarget {
    paneId: string;
    tabId: string;
}

export const useAppShellTabLifecycle = (options: IUseAppShellTabLifecycleOptions) => {
    const {
        panes,
        tabs,
        activePaneId,
        activeTabId,
        workspaceRefs,
        hasTeleportedToolbarContent,
        workspaceSplitCache,
        workspaceRestoreTracker,
        getPaneById,
        getTabById,
        getPaneByTabId,
        activatePane,
        activateTab,
        closeTab,
        closePane,
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
            activePaneId: activePaneId.value,
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
        const pane = getPaneByTabId(tabId);
        if (pane) {
            closeTab(pane.paneId, tabId);
        }
        workspaceSplitCache.clear(tabId);
    }

    function cleanupEmptyPanes() {
        for (const pane of [...panes.value]) {
            if (panes.value.length <= 1) {
                break;
            }
            if (pane.tabIds.length === 0) {
                closePane(pane.paneId);
            }
        }
    }

    function isPlaceholderTab(tab: ITab) {
        return tab.fileName === null
            && tab.originalPath === null
            && !tab.isDirty
            && !tab.isDjvu;
    }

    function isSingletonPlaceholderCloseBlocked(paneId: string, tabId: string) {
        if (tabs.value.length !== 1) {
            return false;
        }

        const pane = getPaneById(paneId);
        if (!pane || pane.tabIds.length !== 1 || !pane.tabIds.includes(tabId)) {
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

        const pane = getPaneByTabId(resolvedTabId);
        if (!pane) {
            return null;
        }

        return {
            tab,
            pane,
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

    function pickSamePaneCloseReplacement(sourcePane: IEditorPaneState, tabId: string) {
        const closingTabIndex = sourcePane.tabIds.indexOf(tabId);
        if (closingTabIndex === -1) {
            return null;
        }

        return pickBestTabCandidate([
            sourcePane.tabIds[closingTabIndex + 1],
            sourcePane.tabIds[closingTabIndex - 1],
            ...sourcePane.tabIds.filter(candidate => candidate !== tabId),
        ]);
    }

    function pickCrossPaneCloseReplacement(sourcePaneId: string) {
        let bestTarget: (ICloseHandoffTarget & { score: number }) | null = null;

        for (const candidatePane of panes.value) {
            if (candidatePane.paneId === sourcePaneId || candidatePane.tabIds.length === 0) {
                continue;
            }

            const candidateTabId = pickBestTabCandidate([
                candidatePane.activeTabId,
                ...candidatePane.tabIds,
            ]);
            if (!candidateTabId) {
                continue;
            }

            const score = scoreTabDocumentReadiness(candidateTabId);
            if (!bestTarget || score > bestTarget.score) {
                bestTarget = {
                    paneId: candidatePane.paneId,
                    tabId: candidateTabId,
                    score,
                };
            }
        }

        return bestTarget
            ? {
                paneId: bestTarget.paneId,
                tabId: bestTarget.tabId,
            }
            : null;
    }

    function resolveCloseHandoffTarget(paneId: string, tabId: string) {
        if (activePaneId.value !== paneId || activeTabId.value !== tabId) {
            return null;
        }

        const sourcePane = getPaneById(paneId);
        if (!sourcePane) {
            return null;
        }

        const samePaneReplacement = pickSamePaneCloseReplacement(sourcePane, tabId);
        if (samePaneReplacement) {
            return {
                paneId: sourcePane.paneId,
                tabId: samePaneReplacement,
            };
        }

        return pickCrossPaneCloseReplacement(sourcePane.paneId);
    }

    async function handoffActiveTabBeforeClose(paneId: string, tabId: string) {
        const target = resolveCloseHandoffTarget(paneId, tabId);
        if (!target) {
            return;
        }

        activatePane(target.paneId);
        activateTab(target.paneId, target.tabId);
        await nextTick();
    }

    function closeTabInState(paneId: string, tabId: string) {
        closeTab(paneId, tabId);
        workspaceSplitCache.clear(tabId);
    }

    function closeResolvedTabInState(paneId: string, tabId: string) {
        const resolvedPane = getPaneByTabId(tabId) ?? getPaneById(paneId);
        if (resolvedPane) {
            closeTabInState(resolvedPane.paneId, tabId);
        }
    }

    function shouldDeferCloseHandoff(
        sourcePane: IEditorPaneState | null,
        closeHandoffTarget: ICloseHandoffTarget | null,
    ) {
        return Boolean(
            sourcePane
            && closeHandoffTarget
            && sourcePane.tabIds.length === 1
            && closeHandoffTarget.paneId !== sourcePane.paneId,
        );
    }

    async function activateDeferredCloseHandoff(
        shouldDeferCrossPaneHandoff: boolean,
        closeHandoffTarget: ICloseHandoffTarget | null,
    ) {
        if (!shouldDeferCrossPaneHandoff || !closeHandoffTarget) {
            return;
        }

        const targetTab = getTabById(closeHandoffTarget.tabId);
        const targetPane = getPaneById(closeHandoffTarget.paneId)
            ?? getPaneByTabId(closeHandoffTarget.tabId);
        if (!targetTab || !targetPane || !targetPane.tabIds.includes(targetTab.id)) {
            return;
        }

        activatePane(targetPane.paneId);
        activateTab(targetPane.paneId, targetTab.id);
        await nextTick();
    }

    function resolveCloseHandoffContext(paneId: string, tabId: string) {
        const sourcePaneBeforeClose = getPaneById(paneId);
        const closeHandoffTarget = resolveCloseHandoffTarget(paneId, tabId);
        return {
            closeHandoffTarget,
            shouldDeferCrossPaneHandoff: shouldDeferCloseHandoff(sourcePaneBeforeClose, closeHandoffTarget),
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
        paneId: string,
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
            closeResolvedTabInState(paneId, tabId);
        }
    }

    async function closeTabDuringTransition(paneId: string, tabId: string) {
        const tab = getTabById(tabId);
        if (!tab) {
            return;
        }

        const {
            closeHandoffTarget,
            shouldDeferCrossPaneHandoff,
        } = resolveCloseHandoffContext(paneId, tabId);

        const shouldPersistBeforeClose = await resolveClosePersistence(tabId, tab);
        if (shouldPersistBeforeClose === null) {
            return;
        }

        if (!shouldDeferCrossPaneHandoff) {
            await handoffActiveTabBeforeClose(paneId, tabId);
        }

        const workspace = workspaceRefs.value.get(tabId);
        if (workspaceHasCloseableDocument(workspace)) {
            await closeWorkspaceDocument(paneId, tabId, workspace, shouldPersistBeforeClose);
        } else {
            closeResolvedTabInState(paneId, tabId);
        }

        cleanupEmptyPanes();
        await activateDeferredCloseHandoff(shouldDeferCrossPaneHandoff, closeHandoffTarget);
    }

    async function handleCloseTab(paneId: string, tabId: string) {
        if (isSingletonPlaceholderCloseBlocked(paneId, tabId)) {
            return;
        }

        await enqueueTabTransition(() => closeTabDuringTransition(paneId, tabId));
    }

    return {
        isTabTransitionBusy,
        enqueueTabTransition,
        setAfterTransitionHook: (callback: (() => void) | null) => {
            afterTransitionHook = callback;
        },
        updateTab,
        removeTabFromState,
        cleanupEmptyPanes,
        isSingletonPlaceholderCloseBlocked,
        resolveTabForAction,
        closeTabInState,
        handoffActiveTabBeforeClose,
        handleCloseTab,
    };
};
