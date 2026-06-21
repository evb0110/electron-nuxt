import type { Ref } from 'vue';
import { withTimeout } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browserLogger';
import { isWorkspaceExpose } from '@app/modules/workspace-shell/expose/isWorkspaceExpose';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';

interface IUseWorkspaceRefRegistryOptions { activeTabId: Ref<string | null>; }

export const useWorkspaceRefRegistry = (options: IUseWorkspaceRefRegistryOptions) => {
    const workspaceRefs = shallowRef<Map<string, IWorkspaceExpose>>(new Map());
    type TWorkspaceWaiter = (workspace: IWorkspaceExpose | null) => void;
    const pendingWorkspaceWaiters = new Map<string, Set<TWorkspaceWaiter>>();
    const WORKSPACE_REF_WAIT_TIMEOUT_MS = 4000;

    function removePendingWaiter(tabId: string, waiter: TWorkspaceWaiter) {
        const waiters = pendingWorkspaceWaiters.get(tabId);
        waiters?.delete(waiter);
        if (waiters && waiters.size === 0) {
            pendingWorkspaceWaiters.delete(tabId);
        }
    }

    function resolvePendingWaiters(tabId: string, workspace: IWorkspaceExpose | null) {
        const waiters = pendingWorkspaceWaiters.get(tabId);
        if (!waiters || waiters.size === 0) {
            return;
        }

        pendingWorkspaceWaiters.delete(tabId);
        for (const waiter of waiters) {
            waiter(workspace);
        }
    }

    function setWorkspaceRef(tabId: string, el: unknown) {
        if (isWorkspaceExpose(el)) {
            if (workspaceRefs.value.get(tabId) === el) {
                return;
            }
            workspaceRefs.value.set(tabId, el);
            resolvePendingWaiters(tabId, el);
            triggerRef(workspaceRefs);
            return;
        }

        if (el) {
            BrowserLogger.warn('tabs', 'Ignoring workspace ref with unexpected shape', {
                tabId,
                receivedType: typeof el,
            });
        }
        if (!workspaceRefs.value.has(tabId)) {
            resolvePendingWaiters(tabId, null);
            return;
        }
        workspaceRefs.value.delete(tabId);
        resolvePendingWaiters(tabId, null);
        triggerRef(workspaceRefs);
    }

    async function waitForWorkspace(tabId: string, timeoutMs = WORKSPACE_REF_WAIT_TIMEOUT_MS) {
        const existingWorkspace = workspaceRefs.value.get(tabId) ?? null;
        if (existingWorkspace) {
            return existingWorkspace;
        }
        let waiter: TWorkspaceWaiter | null = null;

        const cleanupWaiter = () => {
            if (!waiter) {
                return;
            }
            removePendingWaiter(tabId, waiter);
            waiter = null;
        };

        const waiterPromise = new Promise<IWorkspaceExpose | null>((resolve) => {
            waiter = (workspace: IWorkspaceExpose | null) => {
                resolve(workspace);
            };

            const waiters = pendingWorkspaceWaiters.get(tabId);
            if (waiters) {
                waiters.add(waiter);
            } else {
                pendingWorkspaceWaiters.set(tabId, new Set([waiter]));
            }

            const currentWorkspace = workspaceRefs.value.get(tabId) ?? null;
            if (currentWorkspace && waiter) {
                removePendingWaiter(tabId, waiter);
                waiter = null;
                resolve(currentWorkspace);
            }
        });

        try {
            return await withTimeout(() => waiterPromise, timeoutMs);
        } catch {
            BrowserLogger.warn('tabs', 'Workspace did not mount in time', {
                tabId,
                timeoutMs,
            });
            return null;
        } finally {
            cleanupWaiter();
        }
    }

    const activeWorkspace = computed(() => {
        if (!options.activeTabId.value) {
            return null;
        }
        return workspaceRefs.value.get(options.activeTabId.value) ?? null;
    });

    return {
        activeWorkspace,
        setWorkspaceRef,
        waitForWorkspace,
        workspaceRefs,
    };
};
