import type { Ref } from 'vue';
import type {
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
} from '@contracts/agent';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IRecentFile } from '@contracts/shared';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import {
    getPlatformAPI,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import { guardAsync } from '@app/utils/asyncGuard';
import { buildAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/agent/buildAgentWorkspaceSnapshot';

interface IUseAgentWorkspaceSnapshotOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    recentFiles?: Ref<IRecentFile[]>;
    recentFilesResolved?: Ref<boolean>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    shouldWaitForDesktopBridge: () => boolean;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
    activateTab(paneId: string, tabId: string): void;
    waitForWorkspace(tabId: string): Promise<IWorkspaceExpose | null>;
}

export const useAgentWorkspaceSnapshot = (options: IUseAgentWorkspaceSnapshotOptions) => {
    let unsubscribeWorkspaceSnapshotRequest: (() => void) | null = null;
    let unsubscribeCommandRequest: (() => void) | null = null;
    let isDisposed = false;

    function createSnapshotResponse(request: IAgentWorkspaceSnapshotRequest): IAgentWorkspaceSnapshotResponse {
        return {
            requestId: request.requestId,
            ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
            ok: true,
            snapshot: buildAgentWorkspaceSnapshot(options),
        };
    }

    function createCommandErrorResponse(
        request: IAgentCommandRequest,
        error: unknown,
    ): IAgentCommandResponse {
        return {
            requestId: request.requestId,
            ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    async function activateTabForAgent(tabId: string) {
        const pane = options.getPaneByTabId(tabId);
        if (!pane) {
            throw new Error(`Tab ${tabId} is not open.`);
        }

        options.activateTab(pane.paneId, tabId);
        await nextTick();
        return pane.paneId;
    }

    async function runCommand(request: IAgentCommandRequest) {
        if (request.command.name === 'activate_tab') {
            const paneId = await activateTabForAgent(request.command.arguments.tabId);
            return {
                activePaneId: paneId,
                activeTabId: request.command.arguments.tabId,
            };
        }

        if (request.command.name === 'read_resource') {
            const tabId = request.command.arguments.tabId ?? options.activeTabId.value;
            if (!tabId) {
                throw new Error('No active tab is available for resource reads.');
            }

            const workspace = await options.waitForWorkspace(tabId);
            if (!workspace) {
                throw new Error(`Workspace for tab ${tabId} is not available.`);
            }

            const result = await workspace.readAgentResource(request.command.arguments.uri);
            return {
                activePaneId: options.activePaneId.value,
                activeTabId: options.activeTabId.value,
                targetTabId: tabId,
                ...result,
            };
        }

        if (request.command.name === 'run_action') {
            const tabId = request.command.arguments.tabId ?? options.activeTabId.value;
            if (!tabId) {
                throw new Error('No active tab is available for agent actions.');
            }

            const paneId = await activateTabForAgent(tabId);
            const workspace = await options.waitForWorkspace(tabId);
            if (!workspace) {
                throw new Error(`Workspace for tab ${tabId} is not available.`);
            }

            const result = await workspace.runAgentAction(
                request.command.arguments.id,
                request.command.arguments.input,
                request.command.arguments.dryRun === undefined
                    ? {}
                    : {dryRun: request.command.arguments.dryRun},
            );
            await nextTick();
            return {
                activePaneId: paneId,
                activeTabId: tabId,
                ...result,
            };
        }

        const tabId = request.command.arguments.tabId ?? options.activeTabId.value;
        if (!tabId) {
            throw new Error('No active tab is available for page navigation.');
        }

        const paneId = await activateTabForAgent(tabId);
        const workspace = await options.waitForWorkspace(tabId);
        if (!workspace) {
            throw new Error(`Workspace for tab ${tabId} is not available.`);
        }

        workspace.handleGoToPage(request.command.arguments.page);
        await nextTick();
        const snapshot = workspace.getToolbarSnapshot();
        return {
            activePaneId: paneId,
            activeTabId: tabId,
            currentPage: snapshot.currentPage,
            totalPages: snapshot.totalPages,
        };
    }

    function submitSnapshot(request: IAgentWorkspaceSnapshotRequest) {
        guardAsync(getPlatformAPI().agent.submitWorkspaceSnapshot(createSnapshotResponse(request)), {
            scope: 'agent',
            message: 'Failed to submit agent workspace snapshot',
        });
    }

    function submitCommandResult(request: IAgentCommandRequest) {
        guardAsync(
            runCommand(request)
                .then(result => getPlatformAPI().agent.submitCommandResponse({
                    requestId: request.requestId,
                    ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
                    ok: true,
                    result,
                }))
                .catch(error => getPlatformAPI().agent.submitCommandResponse(
                    createCommandErrorResponse(request, error),
                )),
            {
                scope: 'agent',
                message: 'Failed to submit agent command response',
            },
        );
    }

    onMounted(() => {
        isDisposed = false;
        guardAsync(
            (async () => {
                await waitForDesktopPlatformBridge({ shouldWait: options.shouldWaitForDesktopBridge() });
                if (isDisposed) {
                    return;
                }
                const platform = getPlatformAPI();
                const unsubscribeSnapshot = platform.agent.onWorkspaceSnapshotRequest(submitSnapshot);
                const unsubscribeCommand = platform.agent.onCommandRequest(submitCommandResult);
                if (isDisposed) {
                    unsubscribeSnapshot();
                    unsubscribeCommand();
                    return;
                }
                unsubscribeWorkspaceSnapshotRequest = unsubscribeSnapshot;
                unsubscribeCommandRequest = unsubscribeCommand;
            })(),
            {
                scope: 'agent',
                message: 'Failed to attach agent workspace bridge',
            },
        );
    });

    onUnmounted(() => {
        isDisposed = true;
        unsubscribeWorkspaceSnapshotRequest?.();
        unsubscribeWorkspaceSnapshotRequest = null;
        unsubscribeCommandRequest?.();
        unsubscribeCommandRequest = null;
    });

    return { buildSnapshot: () => buildAgentWorkspaceSnapshot(options) };
};
