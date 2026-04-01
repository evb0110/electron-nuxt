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
    removeTabFromState: (tabId: string) => void;
    resolveTabForAction: (tabId: string | undefined) => IResolvedTabAction | null;
    handleCloseTab: (groupId: string, tabId: string) => Promise<void>;
    moveTabToNewWindow: (tabId: string) => Promise<void>;
    moveTabToWindow: (windowId: number, tabId: string) => Promise<void>;
    mergeWindowInto: (windowId: number) => Promise<void>;
}

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

function buildPendingTabDocumentHint(pathOrResult: TDocumentRef | TOpenFileResult): Partial<ITab> {
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

    async function resolveWorkspaceForTab(tabId: string | null) {
        if (!tabId) {
            return null;
        }
        return workspaceRefs.value.get(tabId) ?? waitForWorkspace(tabId);
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

    async function handleOpenInNewTab(pathOrResult: TDocumentRef | TOpenFileResult, groupId?: string) {
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

        if (typeof pathOrResult === 'string') {
            await workspace.handleOpenFileDirectWithPersist(pathOrResult);
            return;
        }

        await workspace.handleOpenFileWithResult(pathOrResult);
    }

    async function openResultInAppropriateTab(result: TOpenFileResult) {
        const workspace = activeWorkspace.value ?? await resolveWorkspaceForTab(activeTabId.value);
        if (workspace && !workspaceOccupiesTab(workspace)) {
            await workspace.handleOpenFileWithResult(result);
            return;
        }

        await handleOpenInNewTab(result, activeGroupId.value ?? undefined);
    }

    async function openPathInAppropriateTab(path: TDocumentRef) {
        const workspace = activeWorkspace.value ?? await resolveWorkspaceForTab(activeTabId.value);
        if (workspace && !workspaceOccupiesTab(workspace)) {
            await workspace.handleOpenFileDirectWithPersist(path);
            return;
        }
        await handleOpenInNewTab(path, activeGroupId.value ?? undefined);
    }

    async function openPathsInAppropriateTab(paths: TDocumentRef[]) {
        const normalizedPaths = uniq(paths
            .map(path => path.trim())
            .filter(path => path.length > 0));
        if (normalizedPaths.length === 0) {
            return;
        }

        const initialActiveWorkspace = activeWorkspace.value ?? await resolveWorkspaceForTab(activeTabId.value);
        const initialActiveTab = getTabById(activeTabId.value);
        let canReuseActiveTab = false;
        if (initialActiveTab && !hasDocumentMountHint(initialActiveTab)) {
            canReuseActiveTab = (
                !initialActiveWorkspace
                || !workspaceOccupiesTab(initialActiveWorkspace)
            );
        }

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
                canReuseActiveTab = false;
                if (activeTab && currentActiveWorkspace) {
                    canReuseActiveTab = (
                        !hasDocumentMountHint(activeTab)
                        && !workspaceOccupiesTab(currentActiveWorkspace)
                    );
                }
                BrowserLogger.warn('workspace-routing', 'Failed to open dropped/external path in its own tab', {
                    path,
                    pathIndex: index,
                    error,
                });
            }
        }
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
        handleWindowTabsAction,
    };
}
