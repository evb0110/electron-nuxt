import type {
    ComputedRef,
    Ref,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { buildPendingTabDocumentHint } from '@app/modules/workspace-shell/tabs/buildPendingTabDocumentHint';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TWindowTabsAction } from '@contracts/windowTabs';

interface IResolvedTabAction {
    tab: ITab;
    pane: IEditorPaneState;
}

interface IUseAppShellWorkspaceRoutingOptions {
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    waitForWorkspace: (tabId: string, timeoutMs?: number) => Promise<IWorkspaceExpose | null>;
    createTab: (options: {
        paneId?: string | null;
        activate?: boolean;
        initial?: Partial<ITab>;
    }) => ITab;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    updateTab: (tabId: string, updates: Partial<ITab>) => void;
    removeTabFromState: (tabId: string) => void;
    resolveTabForAction: (tabId: string | undefined) => IResolvedTabAction | null;
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
    moveTabToNewWindow: (tabId: string) => Promise<void>;
    moveTabToWindow: (windowId: number, tabId: string) => Promise<void>;
    mergeWindowInto: (windowId: number) => Promise<void>;
}

type TWorkspaceOpenDocumentTarget = TDocumentRef | TOpenFileResult;

interface IOpenInExistingTabOptions {
    documentHintAlreadySeeded?: boolean;
    reuseAlreadyReserved?: boolean;
}

function readWorkspaceToolbarSnapshot(workspace: IWorkspaceExpose) {
    try {
        return workspace.getToolbarSnapshot();
    } catch (error) {
        BrowserLogger.warn('workspace-routing', 'Failed to read workspace toolbar snapshot', { error });
        return null;
    }
}

export const useAppShellWorkspaceRouting = (options: IUseAppShellWorkspaceRoutingOptions) => {
    const {
        activePaneId,
        activeTabId,
        activeWorkspace,
        workspaceRefs,
        waitForWorkspace,
        createTab,
        getTabById,
        updateTab,
        removeTabFromState,
        resolveTabForAction,
        handleCloseTab,
        moveTabToNewWindow,
        moveTabToWindow,
        mergeWindowInto,
    } = options;

    function createTabInPane(paneId: string) {
        createTab({
            paneId,
            activate: true,
        });
    }

    function workspaceOccupiesTab(workspace: IWorkspaceExpose) {
        if (workspaceHasPdf(workspace)) {
            return true;
        }

        const snapshot = readWorkspaceToolbarSnapshot(workspace);
        return snapshot?.isDjvuMode === true
            || snapshot?.isOpeningDocument === true
            || snapshot?.hasOpenError === true;
    }

    function canReuseTabForDocument(tab: ITab | null, workspace: IWorkspaceExpose | null) {
        return Boolean(
            tab
            && !tabHasDocumentHint(tab)
            && (!workspace || !workspaceOccupiesTab(workspace)),
        );
    }

    function normalizeOpenPaths(paths: TDocumentRef[]) {
        return uniq(paths
            .map(path => path.trim())
            .filter(path => path.length > 0));
    }

    async function resolveWorkspaceForTab(tabId: string | null) {
        if (!tabId) {
            return null;
        }
        return workspaceRefs.value.get(tabId) ?? waitForWorkspace(tabId);
    }

    function seedTabDocumentHint(tabId: string | null | undefined, pathOrResult: TWorkspaceOpenDocumentTarget) {
        if (!tabId) {
            return;
        }

        const tab = getTabById(tabId);
        if (!tab || tabHasDocumentHint(tab)) {
            return;
        }

        updateTab(tab.id, buildPendingTabDocumentHint(pathOrResult));
    }

    async function openDocumentInWorkspace(
        workspace: IWorkspaceExpose,
        pathOrResult: TWorkspaceOpenDocumentTarget,
    ) {
        if (typeof pathOrResult === 'string') {
            return workspace.handleOpenFileDirectWithPersist(pathOrResult);
        }

        return workspace.handleOpenFileWithResult(pathOrResult);
    }

    async function openInExistingTab(
        tabId: string,
        pathOrResult: TWorkspaceOpenDocumentTarget,
        openOptions: IOpenInExistingTabOptions = {},
    ) {
        const workspace = activeTabId.value === tabId
            ? activeWorkspace.value ?? await resolveWorkspaceForTab(tabId)
            : await resolveWorkspaceForTab(tabId);
        if (!workspace) {
            return false;
        }

        if (!openOptions.reuseAlreadyReserved && workspaceOccupiesTab(workspace)) {
            return false;
        }

        if (!openOptions.documentHintAlreadySeeded) {
            seedTabDocumentHint(tabId, pathOrResult);
        }
        return openDocumentInWorkspace(workspace, pathOrResult);
    }

    async function handleFallbackToolbarOpenFile() {
        const workspace = activeWorkspace.value ?? await resolveWorkspaceForTab(activeTabId.value);
        if (workspace) {
            await workspace.handleOpenFileFromUi();
            return;
        }

        const fallbackTab = createTab({
            paneId: activePaneId.value,
            activate: true,
        });
        const fallbackWorkspace = await waitForWorkspace(fallbackTab.id);
        if (!fallbackWorkspace) {
            removeTabFromState(fallbackTab.id);
            return;
        }
        await fallbackWorkspace.handleOpenFileFromUi();
    }

    async function handleOpenInNewTab(pathOrResult: TWorkspaceOpenDocumentTarget, paneId?: string) {
        const targetPaneId = paneId ?? activePaneId.value ?? undefined;
        const tab = createTab({
            ...(targetPaneId !== undefined ? { paneId: targetPaneId } : {}),
            activate: true,
            initial: buildPendingTabDocumentHint(pathOrResult),
        });
        const workspace = await waitForWorkspace(tab.id);
        if (!workspace) {
            removeTabFromState(tab.id);
            return false;
        }

        const opened = await openDocumentInWorkspace(workspace, pathOrResult);
        if (!opened) {
            removeTabFromState(tab.id);
        }
        return opened;
    }

    async function openDocumentInAppropriateTab(pathOrResult: TWorkspaceOpenDocumentTarget) {
        const tabId = activeTabId.value;
        const tab = getTabById(tabId);
        const workspace = activeWorkspace.value;
        let attemptedExistingTabId: string | null = null;
        if (tab && canReuseTabForDocument(tab, workspace)) {
            attemptedExistingTabId = tab.id;
            const opened = await openInExistingTab(tab.id, pathOrResult);
            if (opened) {
                return true;
            }
        }

        const resolvedWorkspace = workspace ?? await resolveWorkspaceForTab(tabId);
        if (resolvedWorkspace && tabId !== attemptedExistingTabId && !workspaceOccupiesTab(resolvedWorkspace)) {
            seedTabDocumentHint(tabId, pathOrResult);
            const opened = await openDocumentInWorkspace(resolvedWorkspace, pathOrResult);
            if (opened) {
                return true;
            }
        }

        return handleOpenInNewTab(pathOrResult, activePaneId.value ?? undefined);
    }

    async function openResultInAppropriateTab(result: TOpenFileResult) {
        await openDocumentInAppropriateTab(result);
    }

    async function openPathInAppropriateTab(path: TDocumentRef) {
        return openDocumentInAppropriateTab(path);
    }

    async function openPathsInAppropriateTab(paths: TDocumentRef[]) {
        const normalizedPaths = normalizeOpenPaths(paths);
        if (normalizedPaths.length === 0) {
            return;
        }

        const initialActiveWorkspace = activeWorkspace.value;
        const initialActiveTab = getTabById(activeTabId.value);
        let canReuseActiveTab = canReuseTabForDocument(initialActiveTab, initialActiveWorkspace);

        for (const [
            index,
            path,
        ] of normalizedPaths.entries()) {
            try {
                if (canReuseActiveTab) {
                    const opened = await openDocumentInAppropriateTab(path);
                    canReuseActiveTab = !opened;
                    continue;
                }

                await handleOpenInNewTab(path, activePaneId.value ?? undefined);
            } catch (error) {
                const activeTab = getTabById(activeTabId.value);
                const currentActiveWorkspace = activeWorkspace.value ?? await resolveWorkspaceForTab(activeTabId.value);
                canReuseActiveTab = activeTab && currentActiveWorkspace
                    ? canReuseTabForDocument(activeTab, currentActiveWorkspace)
                    : false;
                BrowserLogger.warn('workspace-routing', 'Failed to open dropped/external path in its own tab', {
                    path,
                    pathIndex: index,
                    error,
                });
            }
        }
    }

    async function beginOpenPathsInAppropriateTab(paths: TDocumentRef[]) {
        const normalizedPaths = normalizeOpenPaths(paths);
        if (normalizedPaths.length === 0) {
            return [];
        }

        const startupOpenTasks: Array<Promise<void>> = [];
        const initialActiveWorkspace = activeWorkspace.value;
        const initialActiveTab = getTabById(activeTabId.value);
        let canReuseActiveTab = canReuseTabForDocument(initialActiveTab, initialActiveWorkspace);

        for (const [
            index,
            path,
        ] of normalizedPaths.entries()) {
            if (canReuseActiveTab && initialActiveTab) {
                seedTabDocumentHint(initialActiveTab.id, path);
                canReuseActiveTab = false;
                startupOpenTasks.push((async () => {
                    const opened = await openInExistingTab(initialActiveTab.id, path, {
                        documentHintAlreadySeeded: true,
                        reuseAlreadyReserved: true,
                    });
                    if (!opened) {
                        throw new Error('Startup active tab was not available for external open');
                    }
                })());
                continue;
            }

            const tab = createTab({
                paneId: activePaneId.value,
                activate: index === normalizedPaths.length - 1,
                initial: buildPendingTabDocumentHint(path),
            });
            startupOpenTasks.push((async () => {
                const workspace = await waitForWorkspace(tab.id);
                if (!workspace) {
                    removeTabFromState(tab.id);
                    return;
                }
                const opened = await workspace.handleOpenFileDirectWithPersist(path);
                if (!opened) {
                    removeTabFromState(tab.id);
                    throw new Error('Startup tab document open did not complete');
                }
            })());
        }

        const startupOpenResults = await Promise.allSettled(startupOpenTasks);
        const failedPaths: TDocumentRef[] = [];
        for (const [
            index,
            result,
        ] of startupOpenResults.entries()) {
            if (result.status === 'rejected') {
                const reason: unknown = result.reason;
                const failedPath = normalizedPaths[index];
                if (failedPath) {
                    failedPaths.push(failedPath);
                }
                BrowserLogger.warn('workspace-routing', 'Failed to begin startup external path open', {
                    path: failedPath,
                    pathIndex: index,
                    error: reason,
                });
            }
        }

        await nextTick();
        return failedPaths;
    }

    async function handleWindowTabsAction(action: TWindowTabsAction) {
        if (action.kind === 'close-tab') {
            const resolved = resolveTabForAction(action.tabId);
            if (!resolved) {
                return;
            }
            await handleCloseTab(resolved.pane.paneId, resolved.tab.id);
            return;
        }

        if (action.kind === 'move-tab-to-new-window') {
            const resolved = resolveTabForAction(action.tabId);
            if (!resolved) {
                return;
            }
            await moveTabToNewWindow(resolved.tab.id);
            return;
        }

        if (action.kind === 'move-tab-to-window') {
            const resolved = resolveTabForAction(action.tabId);
            if (!resolved) {
                return;
            }
            await moveTabToWindow(action.targetWindowId, resolved.tab.id);
            return;
        }

        await mergeWindowInto(action.targetWindowId);
    }

    return {
        createTabInPane,
        handleFallbackToolbarOpenFile,
        handleOpenInNewTab,
        openResultInAppropriateTab,
        openPathInAppropriateTab,
        openPathsInAppropriateTab,
        beginOpenPathsInAppropriateTab,
        handleWindowTabsAction,
    };
};
