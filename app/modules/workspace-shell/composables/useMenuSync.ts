import { guardAsync } from '@app/utils/asyncGuard';
import type {
    IUseWorkspaceShellStateOptions,
    IWorkspaceShellState,
} from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { getDocumentMenuCapability } from '@app/utils/platformDocuments';

interface IUseMenuSyncDeps extends IUseWorkspaceShellStateOptions {shellState?: IWorkspaceShellState;}

export const useMenuSync = (deps: IUseMenuSyncDeps) => {
    const shellState = deps.shellState ?? useWorkspaceShellState(deps);
    let lastSyncedMenuDocumentState: {
        hasDocument: boolean;
        canSave: boolean;
        canRepairSave: boolean;
        canOptimizePdf: boolean;
    } | null = null;
    let lastSyncedMenuTabCount: number | null = null;

    function syncMenuDocumentState() {
        const hasDocument = shellState.hasDocument.value;
        const canSave = shellState.activeWorkspaceCanSave.value;
        const canRepairSave = shellState.activeWorkspaceCanRepairSave.value;
        const canOptimizePdf = shellState.activeWorkspaceCanOptimizePdf.value;
        if (
            lastSyncedMenuDocumentState?.hasDocument === hasDocument
            && lastSyncedMenuDocumentState.canSave === canSave
            && lastSyncedMenuDocumentState.canRepairSave === canRepairSave
            && lastSyncedMenuDocumentState.canOptimizePdf === canOptimizePdf
        ) {
            return;
        }
        lastSyncedMenuDocumentState = {
            hasDocument,
            canSave,
            canRepairSave,
            canOptimizePdf,
        };
        const setMenuDocumentState = getDocumentMenuCapability().setMenuDocumentState;
        if (!setMenuDocumentState) {
            return;
        }
        guardAsync(setMenuDocumentState({
            hasDocument,
            canSave,
            canRepairSave,
            canOptimizePdf,
        }), {
            category: 'background-diagnostic',
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
        const setMenuTabCount = getDocumentMenuCapability().setMenuTabCount;
        if (!setMenuTabCount) {
            return;
        }
        guardAsync(setMenuTabCount(tabCount), {
            category: 'background-diagnostic',
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
