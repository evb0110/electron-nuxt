import { getPlatformAPI } from '@app/utils/platform';
import { guardAsync } from '@app/utils/asyncGuard';
import type {
    IUseWorkspaceShellStateOptions,
    IWorkspaceShellState,
} from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';

interface IUseMenuSyncDeps extends IUseWorkspaceShellStateOptions {shellState?: IWorkspaceShellState;}

export const useMenuSync = (deps: IUseMenuSyncDeps) => {
    const autoShellState = useWorkspaceShellState(deps);
    const shellState = deps.shellState ?? autoShellState;
    let lastSyncedMenuDocumentState: {
        hasDocument: boolean;
        canSave: boolean;
        canRepairSave: boolean;
    } | null = null;
    let lastSyncedMenuTabCount: number | null = null;

    function syncMenuDocumentState() {
        const hasDocument = shellState.hasDocument.value;
        const canSave = shellState.activeWorkspaceCanSave.value;
        const canRepairSave = shellState.activeWorkspaceCanRepairSave.value;
        if (
            lastSyncedMenuDocumentState?.hasDocument === hasDocument
            && lastSyncedMenuDocumentState.canSave === canSave
            && lastSyncedMenuDocumentState.canRepairSave === canRepairSave
        ) {
            return;
        }
        lastSyncedMenuDocumentState = {
            hasDocument,
            canSave,
            canRepairSave,
        };
        const setMenuDocumentState = getPlatformAPI().documents?.setMenuDocumentState;
        if (!setMenuDocumentState) {
            return;
        }
        guardAsync(setMenuDocumentState({
            hasDocument,
            canSave,
            canRepairSave,
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
