import type { Ref } from 'vue';
import { getElectronAPI } from '@app/utils/platform';
import { guardAsync } from '@app/utils/async-guard';
import type { ITab } from '@app/types/tabs';
import { hasDocumentMountHint } from '@app/modules/workspace-shell/composables/workspace-host-mounting';

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
        const hasDocument = workspaceHasPdf(activeWorkspace.value) || activeTabHasDocumentHint();
        if (lastSyncedMenuDocumentState === hasDocument) {
            return;
        }
        lastSyncedMenuDocumentState = hasDocument;
        const setMenuDocumentState = getElectronAPI().documents?.setMenuDocumentState;
        if (!setMenuDocumentState) {
            return;
        }
        guardAsync(setMenuDocumentState(hasDocument), {
            scope: 'menu-sync',
            message: 'Failed to sync menu document state',
        });
    }

    function syncMenuTabCount() {
        const tabCount = tabs.value.length;
        if (lastSyncedMenuTabCount === tabCount) {
            return;
        }

        lastSyncedMenuTabCount = tabCount;
        const setMenuTabCount = getElectronAPI().documents?.setMenuTabCount;
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

    return {workspaceHasPdf};
}
