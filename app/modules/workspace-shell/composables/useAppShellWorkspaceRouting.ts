import type {
    ComputedRef,
    Ref,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browser-logger';
import { hasDocumentMountHint } from '@app/modules/workspace-shell/composables/workspace-host-mounting';
import { workspaceHasPdf } from '@app/modules/workspace-shell/composables/useMenuSync';
import type { IEditorGroupState } from '@app/types/editor-groups';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import type { TWindowTabsAction } from '@contracts/window-tabs';

interface IResolvedTabAction {
    tab: ITab;
    group: IEditorGroupState;
}

interface IUseAppShellWorkspaceRoutingOptions {
    activeGroupId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    waitForWorkspace: (tabId: string, timeoutMs?: number) => Promise<IWorkspaceExpose | null>;
    createTab: (options: {
        groupId?: string | null;
        activate?: boolean;
        initial?: Partial<ITab>;
    }) => ITab;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    updateTab: (tabId: string, updates: Partial<ITab>) => void;
    removeTabFromState: (tabId: string) => void;
    resolveTabForAction: (tabId: string | undefined) => IResolvedTabAction | null;
    handleCloseTab: (groupId: string, tabId: string) => Promise<void>;
    moveTabToNewWindow: (tabId: string) => Promise<void>;
    moveTabToWindow: (windowId: number, tabId: string) => Promise<void>;
    mergeWindowInto: (windowId: number) => Promise<void>;
}

type TOpenDocumentTarget = TDocumentRef | TOpenFileResult;

function decodeDocumentFileName(segment: string) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function getDocumentRefFileName(ref: TDocumentRef) {
    const lastSegment = ref.split(/[\\/]/u).at(-1) ?? '';
    if (!lastSegment) {
        return null;
    }

    return decodeDocumentFileName(lastSegment);
}

function buildPendingTabDocumentHint(pathOrResult: TOpenDocumentTarget): Partial<ITab> {
    if (typeof pathOrResult === 'string') {
        const fileName = getDocumentRefFileName(pathOrResult);
        return {
            fileName,
            originalPath: pathOrResult,
            isDjvu: /\.djvu?$/iu.test(fileName ?? pathOrResult),
        };
    }

    const fileName = getDocumentRefFileName(
        pathOrResult.originalPath || (pathOrResult.kind === 'pdf' ? pathOrResult.workingPath : ''),
    );

    return {
        fileName,
        originalPath: pathOrResult.originalPath,
        isDjvu: pathOrResult.kind === 'djvu',
    };
}

function readWorkspaceToolbarSnapshot(workspace: IWorkspaceExpose) {
    try {
        return workspace.getToolbarSnapshot();
    } catch (error) {
        BrowserLogger.warn('workspace-routing', 'Failed to read workspace toolbar snapshot', { error });
        return null;
    }
}

export function useAppShellWorkspaceRouting(options: IUseAppShellWorkspaceRoutingOptions) {
    const {
        activeGroupId,
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

    function createTabInGroup(groupId: string) {
        createTab({
            groupId,
            activate: true,
        });
    }

    function workspaceOccupiesTab(workspace: IWorkspaceExpose) {
        if (workspaceHasPdf(workspace)) {
            return true;
        }

        const snapshot = readWorkspaceToolbarSnapshot(workspace);
        return Boolean(snapshot?.isDjvuMode || snapshot?.isOpeningDocument);
    }

    function canReuseTabForDocument(tab: ITab | null, workspace: IWorkspaceExpose | null) {
        return Boolean(
            tab
            && !hasDocumentMountHint(tab)
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

    function seedTabDocumentHint(tabId: string | null | undefined, pathOrResult: TOpenDocumentTarget) {
        if (!tabId) {
            return;
        }

        const tab = getTabById(tabId);
        if (!tab || hasDocumentMountHint(tab)) {
            return;
        }

        updateTab(tab.id, buildPendingTabDocumentHint(pathOrResult));
    }

    async function openDocumentInWorkspace(
        workspace: IWorkspaceExpose,
        pathOrResult: TOpenDocumentTarget,
    ) {
        if (typeof pathOrResult === 'string') {
            await workspace.handleOpenFileDirectWithPersist(pathOrResult);
            return;
        }

        await workspace.handleOpenFileWithResult(pathOrResult);
    }

    async function openInExistingTab(tabId: string, pathOrResult: TOpenDocumentTarget) {
        seedTabDocumentHint(tabId, pathOrResult);
        const workspace = activeTabId.value === tabId
            ? activeWorkspace.value ?? await resolveWorkspaceForTab(tabId)
            : await resolveWorkspaceForTab(tabId);
        if (!workspace) {
            return false;
        }

        if (workspaceOccupiesTab(workspace)) {
            return false;
        }

        await openDocumentInWorkspace(workspace, pathOrResult);
        return true;
    }

    async function handleFallbackToolbarOpenFile() {
        const workspace = activeWorkspace.value ?? await resolveWorkspaceForTab(activeTabId.value);
        if (workspace) {
            await workspace.handleOpenFileFromUi();
            return;
        }

        const fallbackTab = createTab({
            groupId: activeGroupId.value,
            activate: true,
        });
        const fallbackWorkspace = await waitForWorkspace(fallbackTab.id);
        if (!fallbackWorkspace) {
            removeTabFromState(fallbackTab.id);
            return;
        }
        await fallbackWorkspace.handleOpenFileFromUi();
    }

    async function handleOpenInNewTab(pathOrResult: TOpenDocumentTarget, groupId?: string) {
        const targetGroupId = groupId ?? activeGroupId.value ?? undefined;
        const tab = createTab({
            groupId: targetGroupId,
            activate: true,
            initial: buildPendingTabDocumentHint(pathOrResult),
        });
        const workspace = await waitForWorkspace(tab.id);
        if (!workspace) {
            removeTabFromState(tab.id);
            return;
        }

        await openDocumentInWorkspace(workspace, pathOrResult);
    }

    async function openDocumentInAppropriateTab(pathOrResult: TOpenDocumentTarget) {
        const tabId = activeTabId.value;
        const tab = getTabById(tabId);
        const workspace = activeWorkspace.value;
        if (tab && canReuseTabForDocument(tab, workspace)) {
            const opened = await openInExistingTab(tab.id, pathOrResult);
            if (opened) {
                return;
            }
        }

        const resolvedWorkspace = workspace ?? await resolveWorkspaceForTab(tabId);
        if (resolvedWorkspace && !workspaceOccupiesTab(resolvedWorkspace)) {
            seedTabDocumentHint(tabId, pathOrResult);
            await openDocumentInWorkspace(resolvedWorkspace, pathOrResult);
            return;
        }

        await handleOpenInNewTab(pathOrResult, activeGroupId.value ?? undefined);
    }

    async function openResultInAppropriateTab(result: TOpenFileResult) {
        await openDocumentInAppropriateTab(result);
    }

    async function openPathInAppropriateTab(path: TDocumentRef) {
        await openDocumentInAppropriateTab(path);
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
                    await openPathInAppropriateTab(path);
                    canReuseActiveTab = false;
                    continue;
                }

                await handleOpenInNewTab(path, activeGroupId.value ?? undefined);
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
            return;
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
                startupOpenTasks.push(openInExistingTab(initialActiveTab.id, path).then(() => undefined));
                continue;
            }

            const tab = createTab({
                groupId: activeGroupId.value,
                activate: index === normalizedPaths.length - 1,
                initial: buildPendingTabDocumentHint(path),
            });
            startupOpenTasks.push((async () => {
                const workspace = await waitForWorkspace(tab.id);
                if (!workspace) {
                    removeTabFromState(tab.id);
                    return;
                }
                await workspace.handleOpenFileDirectWithPersist(path);
            })());
        }

        for (const [
            index,
            task,
        ] of startupOpenTasks.entries()) {
            void task.catch((error: unknown) => {
                BrowserLogger.warn('workspace-routing', 'Failed to begin startup external path open', {
                    path: normalizedPaths[index],
                    pathIndex: index,
                    error,
                });
            });
        }

        await nextTick();
    }

    async function handleWindowTabsAction(action: TWindowTabsAction) {
        if (action.kind === 'close-tab') {
            const resolved = resolveTabForAction(action.tabId);
            if (!resolved) {
                return;
            }
            await handleCloseTab(resolved.group.id, resolved.tab.id);
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
        createTabInGroup,
        handleFallbackToolbarOpenFile,
        handleOpenInNewTab,
        openResultInAppropriateTab,
        openPathInAppropriateTab,
        openPathsInAppropriateTab,
        beginOpenPathsInAppropriateTab,
        handleWindowTabsAction,
    };
}
