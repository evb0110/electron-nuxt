import type { Ref } from 'vue';
import type {
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentRendererAck,
    IAgentWorkspaceSnapshot,
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
import { BrowserLogger } from '@app/utils/browserLogger';
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
    let cachedSnapshotRevision = 0;
    let cachedSnapshotSignature = '';
    let cachedSnapshot: IAgentWorkspaceSnapshot | null = null;

    function createToolbarSnapshotSignature(tabId: string) {
        const workspace = options.workspaceRefs.value.get(tabId);
        if (!workspace) {
            return null;
        }

        try {
            const snapshot = workspace.getToolbarSnapshot();
            return {
                hasPdf: snapshot.hasPdf,
                isDjvuMode: snapshot.isDjvuMode,
                isOpeningDocument: snapshot.isOpeningDocument,
                hasOpenError: snapshot.hasOpenError,
                currentPage: snapshot.currentPage,
                totalPages: snapshot.totalPages,
            };
        } catch {
            return { readError: true };
        }
    }

    function createSnapshotSignature() {
        return JSON.stringify({
            activePaneId: options.activePaneId.value,
            activeTabId: options.activeTabId.value,
            layout: options.layout.value,
            panes: options.panes.value.map(pane => ({
                paneId: pane.paneId,
                activeTabId: pane.activeTabId,
                tabIds: pane.tabIds,
            })),
            tabs: options.tabs.value.map(tab => ({
                id: tab.id,
                fileName: tab.fileName,
                originalPath: tab.originalPath,
                isDirty: tab.isDirty,
                isDjvu: tab.isDjvu,
                toolbar: createToolbarSnapshotSignature(tab.id),
            })),
            recentFiles: (options.recentFiles?.value ?? []).map(file => ({
                originalPath: file.originalPath,
                fileName: file.fileName,
                timestamp: file.timestamp,
                fileSize: file.fileSize,
            })),
            recentFilesResolved: options.recentFilesResolved?.value ?? false,
        });
    }

    function getCachedSnapshot() {
        const signature = createSnapshotSignature();
        if (cachedSnapshot && signature === cachedSnapshotSignature) {
            return {
                revision: cachedSnapshotRevision,
                snapshot: cachedSnapshot,
            };
        }

        cachedSnapshotSignature = signature;
        cachedSnapshotRevision += 1;
        cachedSnapshot = buildAgentWorkspaceSnapshot(options);
        return {
            revision: cachedSnapshotRevision,
            snapshot: cachedSnapshot,
        };
    }

    function createSnapshotResponse(request: IAgentWorkspaceSnapshotRequest): IAgentWorkspaceSnapshotResponse {
        const cached = getCachedSnapshot();
        if (
            request.lastSeenRevision !== undefined
            && request.lastSeenRevision === cached.revision
        ) {
            return {
                requestId: request.requestId,
                ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
                ok: true,
                revision: cached.revision,
                unchanged: true,
            };
        }

        return {
            requestId: request.requestId,
            ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
            ok: true,
            revision: cached.revision,
            snapshot: cached.snapshot,
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

    function logRejectedAck(kind: 'snapshot' | 'command', requestId: string, ack: IAgentRendererAck) {
        if (ack.accepted) {
            return;
        }
        BrowserLogger.warn('agent', `Agent ${kind} response was not accepted`, {
            requestId,
            reason: ack.reason ?? 'unknown-request',
        });
    }

    async function submitWorkspaceSnapshotWithAck(response: IAgentWorkspaceSnapshotResponse) {
        const ack = await getPlatformAPI().agent.submitWorkspaceSnapshot(response);
        logRejectedAck('snapshot', response.requestId, ack);
    }

    async function submitCommandResponseWithAck(response: IAgentCommandResponse) {
        const ack = await getPlatformAPI().agent.submitCommandResponse(response);
        logRejectedAck('command', response.requestId, ack);
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
        guardAsync(submitWorkspaceSnapshotWithAck(createSnapshotResponse(request)), {
            scope: 'agent',
            message: 'Failed to submit agent workspace snapshot',
        });
    }

    function submitCommandResult(request: IAgentCommandRequest) {
        guardAsync(
            runCommand(request)
                .then(result => submitCommandResponseWithAck({
                    requestId: request.requestId,
                    ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
                    ok: true,
                    result,
                }))
                .catch(error => submitCommandResponseWithAck(
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
