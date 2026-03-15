import type { Ref } from 'vue';
import { withTimeout } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browser-logger';
import { isWorkspaceExpose } from '@app/modules/workspace-shell/composables/workspace-expose-contract';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';

interface IUseWorkspaceRefRegistryOptions { activeTabId: Ref<string | null>; }

export function useWorkspaceRefRegistry(options: IUseWorkspaceRefRegistryOptions) {
    const workspaceRefs = shallowRef<Map<string, IWorkspaceExpose>>(new Map());
    const pendingWorkspaceWaiters = new Map<string, Set<(workspace: IWorkspaceExpose) => void>>();
    const WORKSPACE_REF_WAIT_TIMEOUT_MS = 4000;

    function setWorkspaceRef(tabId: string, el: unknown) {
        if (isWorkspaceExpose(el)) {
            if (workspaceRefs.value.get(tabId) === el) {
                return;
            }
            workspaceRefs.value.set(tabId, el);
            const waiters = pendingWorkspaceWaiters.get(tabId);
            if (waiters && waiters.size > 0) {
                pendingWorkspaceWaiters.delete(tabId);
                for (const waiter of waiters) {
                    waiter(el);
                }
            }
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
            return;
        }
        workspaceRefs.value.delete(tabId);
        triggerRef(workspaceRefs);
    }

    async function waitForWorkspace(tabId: string, timeoutMs = WORKSPACE_REF_WAIT_TIMEOUT_MS) {
        const existingWorkspace = workspaceRefs.value.get(tabId) ?? null;
        if (existingWorkspace) {
            return existingWorkspace;
        }
        let waiter: ((workspace: IWorkspaceExpose) => void) | null = null;

        const cleanupWaiter = () => {
            if (!waiter) {
                return;
            }
            const activeWaiters = pendingWorkspaceWaiters.get(tabId);
            activeWaiters?.delete(waiter);
            if (activeWaiters && activeWaiters.size === 0) {
                pendingWorkspaceWaiters.delete(tabId);
            }
            waiter = null;
        };

        const waiterPromise = new Promise<IWorkspaceExpose>((resolve) => {
            waiter = (workspace: IWorkspaceExpose) => {
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
                const currentWaiters = pendingWorkspaceWaiters.get(tabId);
                currentWaiters?.delete(waiter);
                if (currentWaiters && currentWaiters.size === 0) {
                    pendingWorkspaceWaiters.delete(tabId);
                }
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
}
