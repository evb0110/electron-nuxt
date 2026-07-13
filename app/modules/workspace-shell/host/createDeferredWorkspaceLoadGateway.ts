import { delay } from 'es-toolkit/promise';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { DEFERRED_WORKSPACE_HOST_POLICY } from '@app/modules/workspace-shell/host/deferredWorkspaceHostPolicy';

interface ICreateDeferredWorkspaceLoadGatewayOptions {
    readonly tabId: string;
    readonly mountedWorkspace: Readonly<ShallowRef<IWorkspaceExpose | null>>;
    readonly workspaceChunkLoadError: Ref<unknown>;
    readonly loadDocumentWorkspace: () => Promise<unknown>;
    readonly requestWorkspaceMount: (reason: string) => void;
    readonly isHostUnmounted: () => boolean;
}

export function createDeferredWorkspaceLoadGateway(options: ICreateDeferredWorkspaceLoadGatewayOptions) {
    let workspaceLoadPromise: Promise<IWorkspaceExpose | null> | null = null;
    let workspacePreloadPromise: Promise<boolean> | null = null;

    async function preloadWorkspaceComponent(reason: string) {
        if (workspacePreloadPromise) {
            return workspacePreloadPromise;
        }
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Preloading DocumentWorkspace chunk', {
            tabId: options.tabId,
            reason,
        });
        workspacePreloadPromise = options.loadDocumentWorkspace()
            .then(() => {
                BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'DocumentWorkspace chunk preloaded', {
                    tabId: options.tabId,
                    reason,
                });
                return true;
            })
            .catch((error) => {
                BrowserLogger.error(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Failed to preload DocumentWorkspace chunk', {
                    tabId: options.tabId,
                    reason,
                    error: error instanceof Error ? error.message : String(error),
                });
                return false;
            })
            .finally(() => { workspacePreloadPromise = null; });
        return workspacePreloadPromise;
    }

    async function waitForWorkspaceMount(
        timeoutMs: number = DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_TIMEOUT_MS,
    ) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (options.isHostUnmounted() || options.workspaceChunkLoadError.value) {
                return null;
            }
            if (options.mountedWorkspace.value) {
                return options.mountedWorkspace.value;
            }
            await delay(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_POLL_INTERVAL_MS);
        }
        return null;
    }

    async function ensureWorkspaceLoaded(reason: string) {
        if (options.mountedWorkspace.value) {
            return options.mountedWorkspace.value;
        }
        if (options.workspaceChunkLoadError.value) {
            return null;
        }
        options.requestWorkspaceMount(`ensureWorkspaceLoaded:${reason}`);
        const preloaded = await preloadWorkspaceComponent(`ensureWorkspaceLoaded:${reason}`);
        if (!preloaded) {
            BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Proceeding with workspace mount after preload failure', {
                tabId: options.tabId,
                reason,
            });
        }
        workspaceLoadPromise ??= waitForWorkspaceMount().finally(() => { workspaceLoadPromise = null; });
        const workspace = await workspaceLoadPromise;
        if (workspace) {
            BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Workspace mount ready', {
                tabId: options.tabId,
                reason,
            });
        } else {
            BrowserLogger.error('workspace-host', options.workspaceChunkLoadError.value
                ? 'Workspace load failed due to async chunk error'
                : 'Workspace load timed out', {
                tabId: options.tabId,
                reason,
                ...(options.workspaceChunkLoadError.value ? {error: options.workspaceChunkLoadError.value} : {}),
            });
        }
        return workspace;
    }

    async function acquireWorkspace(action: string) {
        let workspace = options.mountedWorkspace.value ?? await ensureWorkspaceLoaded(action);
        if (!workspace && !options.workspaceChunkLoadError.value) {
            workspace = await waitForWorkspaceMount(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_RETRY_TIMEOUT_MS);
        }
        return workspace;
    }

    function logUnavailable(action: string) {
        BrowserLogger.error('workspace-host', 'Workspace unavailable for loaded action', {
            tabId: options.tabId,
            action,
            hasWorkspaceChunkLoadError: Boolean(options.workspaceChunkLoadError.value),
            error: options.workspaceChunkLoadError.value,
        });
    }

    async function withLoadedWorkspace<T = void>(
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<T> | T,
    ) {
        const workspace = await acquireWorkspace(action);
        if (!workspace) {
            logUnavailable(action);
            return undefined;
        }
        try {
            return await run(workspace);
        } catch (error) {
            BrowserLogger.error('workspace-host', `Action failed (${action})`, {
                tabId: options.tabId,
                error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
        }
    }

    async function withLoadedWorkspaceRequired<T = void>(
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<T> | T,
    ) {
        const workspace = await acquireWorkspace(action);
        if (!workspace) {
            logUnavailable(action);
            throw new Error('Workspace is not available.');
        }
        try {
            return await run(workspace);
        } catch (error) {
            BrowserLogger.error('workspace-host', `Action failed (${action})`, {
                tabId: options.tabId,
                error,
            });
            throw error;
        }
    }

    async function withWorkspace(
        action: string,
        run: (workspace: IWorkspaceExpose) => Promise<boolean | undefined> | boolean | undefined,
    ) {
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'withWorkspace start', {
            tabId: options.tabId,
            action,
            hasMountedWorkspace: Boolean(options.mountedWorkspace.value),
        });
        const workspace = await acquireWorkspace(action);
        if (!workspace) {
            BrowserLogger.error('workspace-host', 'Workspace unavailable for action', {
                tabId: options.tabId,
                action,
                error: options.workspaceChunkLoadError.value,
            });
            return false;
        }
        try {
            const result = await run(workspace);
            BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'withWorkspace completed', {
                tabId: options.tabId,
                action,
                hasPdf: workspaceHasPdf(workspace),
                handled: result !== false,
            });
            return result !== false;
        } catch (error) {
            BrowserLogger.error('workspace-host', `Action failed (${action})`, {
                tabId: options.tabId,
                error,
            });
            return false;
        }
    }

    return {
        ensureWorkspaceLoaded,
        preloadWorkspaceComponent,
        resetWorkspaceLoad: () => { workspaceLoadPromise = null; },
        dispose: () => {
            workspaceLoadPromise = null;
            workspacePreloadPromise = null;
        },
        withLoadedWorkspace,
        withLoadedWorkspaceRequired,
        withWorkspace,
    };
}
