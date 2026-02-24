import {
    watchEffect,
    type Ref,
} from 'vue';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';
import type { ITab } from '@app/types/tabs';

interface IWorkspaceMenuState {hasPdf: boolean | { value: boolean };}

interface IUseMenuSyncDeps {
    activeWorkspace: Readonly<Ref<IWorkspaceMenuState | null>>;
    tabs: Ref<ITab[]>;
}

export function workspaceHasPdf(workspace: IWorkspaceMenuState | null | undefined) {
    if (!workspace) {
        return false;
    }
    return typeof workspace.hasPdf === 'boolean' ? workspace.hasPdf : workspace.hasPdf.value;
}

export function useMenuSync(deps: IUseMenuSyncDeps) {
    const {
        activeWorkspace,
        tabs,
    } = deps;
    let lastSyncedMenuDocumentState: boolean | null = null;
    let lastSyncedMenuTabCount: number | null = null;

    function syncMenuDocumentState() {
        if (!hasElectronAPI()) {
            return;
        }
        const hasDocument = workspaceHasPdf(activeWorkspace.value);
        if (lastSyncedMenuDocumentState === hasDocument) {
            return;
        }
        lastSyncedMenuDocumentState = hasDocument;
        void getElectronAPI().setMenuDocumentState(hasDocument);
    }

    function syncMenuTabCount() {
        if (!hasElectronAPI()) {
            return;
        }

        const tabCount = tabs.value.length;
        if (lastSyncedMenuTabCount === tabCount) {
            return;
        }

        lastSyncedMenuTabCount = tabCount;
        void getElectronAPI().setMenuTabCount(tabCount);
    }

    watchEffect(() => {
        syncMenuDocumentState();
        syncMenuTabCount();
    });

    return {workspaceHasPdf};
}
