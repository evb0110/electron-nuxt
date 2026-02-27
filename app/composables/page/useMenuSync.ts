import type { Ref } from 'vue';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';
import type { ITab } from '@app/types/tabs';
import { hasDocumentMountHint } from '@app/composables/page/workspace-host-mounting';

interface IWorkspaceMenuState {hasPdf: boolean | { value: boolean };}

interface IUseMenuSyncDeps {
    activeWorkspace: Readonly<Ref<IWorkspaceMenuState | null>>;
    activeTabId: Ref<string | null>;
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
        activeTabId,
        tabs,
    } = deps;
    let lastSyncedMenuDocumentState: boolean | null = null;
    let lastSyncedMenuTabCount: number | null = null;

    function activeTabHasDocumentHint() {
        const tabId = activeTabId.value;
        if (!tabId) {
            return false;
        }

        const tab = tabs.value.find(candidate => candidate.id === tabId) ?? null;
        if (!tab) {
            return false;
        }

        return hasDocumentMountHint(tab);
    }

    function syncMenuDocumentState() {
        if (!hasElectronAPI()) {
            return;
        }
        const hasDocument = workspaceHasPdf(activeWorkspace.value) || activeTabHasDocumentHint();
        if (lastSyncedMenuDocumentState === hasDocument) {
            return;
        }
        lastSyncedMenuDocumentState = hasDocument;
        void getElectronAPI().documents?.setMenuDocumentState(hasDocument);
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
        void getElectronAPI().documents?.setMenuTabCount(tabCount);
    }

    watchEffect(() => {
        syncMenuDocumentState();
        syncMenuTabCount();
    });

    return {workspaceHasPdf};
}
