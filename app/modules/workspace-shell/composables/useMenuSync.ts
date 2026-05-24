import { getPlatformAPI } from '@app/utils/platform';
import { guardAsync } from '@app/utils/asyncGuard';
import type {
    IUseWorkspaceShellStateOptions,
    IWorkspaceShellState,
} from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import {
    useWorkspaceShellState,
    workspaceHasPdf,
} from '@app/modules/workspace-shell/composables/useWorkspaceShellState';

interface IUseMenuSyncDeps extends IUseWorkspaceShellStateOptions {shellState?: IWorkspaceShellState;}

export { workspaceHasPdf } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';

export const useMenuSync = (deps: IUseMenuSyncDeps) => {
    const autoShellState = useWorkspaceShellState(deps);
    const shellState = deps.shellState ?? autoShellState;
    let lastSyncedMenuDocumentState: {
        hasDocument: boolean;
        canSave: boolean 
    } | null = null;
    let lastSyncedMenuTabCount: number | null = null;

    function syncMenuDocumentState() {
        const hasDocument = shellState.hasDocument.value;
        const canSave = shellState.activeWorkspaceCanSave.value;
        if (
            lastSyncedMenuDocumentState?.hasDocument === hasDocument
            && lastSyncedMenuDocumentState.canSave === canSave
        ) {
            return;
        }
        lastSyncedMenuDocumentState = {
            hasDocument,
            canSave, 
        };
        const setMenuDocumentState = getPlatformAPI().documents?.setMenuDocumentState;
        if (!setMenuDocumentState) {
            return;
        }
        guardAsync(setMenuDocumentState({
            hasDocument,
            canSave, 
        }), {
            scope: 'menu-sync',
            message: 'Failed to sync menu document state',
        });
    }

    function syncMenuTabCount() {
        const tabCount = shellState.tabCount.value;
        if (lastSyncedMenuTabCount === tabCount) {
            return;
        }

        lastSyncedMenuTabCount = tabCount;
        const setMenuTabCount = getPlatformAPI().documents?.setMenuTabCount;
        if (!setMenuTabCount) {
            return;
        }
        guardAsync(setMenuTabCount(tabCount), {
            scope: 'menu-sync',
            message: 'Failed to sync menu tab count',
        });
    }

    watchEffect(() => {
        syncMenuDocumentState();
        syncMenuTabCount();
    });

    return {
        shellState,
        workspaceHasPdf,
    };
};
