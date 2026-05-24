import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { ITab } from '@app/types/tabs';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/composables/workspaceTabDocumentHint';

interface IWorkspaceHasPdfState {
    hasPdf: boolean | { value: boolean };
    getToolbarSnapshot?: () => { canSave: boolean };
}

export interface IWorkspaceShellState {
    activeTab: ComputedRef<ITab | null>;
    activeWorkspaceHasDocument: ComputedRef<boolean>;
    activeWorkspaceCanSave: ComputedRef<boolean>;
    activeTabHasDocumentHint: ComputedRef<boolean>;
    hasDocument: ComputedRef<boolean>;
    tabCount: ComputedRef<number>;
}

export interface IUseWorkspaceShellStateOptions {
    activeWorkspace: Readonly<Ref<IWorkspaceHasPdfState | null | undefined>>;
    activeTabId: Ref<string | null>;
    tabs: Ref<ITab[]>;
}

export function workspaceHasPdf(workspace: IWorkspaceHasPdfState | null | undefined) {
    if (!workspace) {
        return false;
    }
    return typeof workspace.hasPdf === 'boolean' ? workspace.hasPdf : workspace.hasPdf.value;
}

export const useWorkspaceShellState = (options: IUseWorkspaceShellStateOptions): IWorkspaceShellState => {
    const activeTab = computed(() => {
        const tabId = options.activeTabId.value;
        if (!tabId) {
            return null;
        }

        return options.tabs.value.find(candidate => candidate.id === tabId) ?? null;
    });
    const activeWorkspaceHasDocument = computed(() => workspaceHasPdf(options.activeWorkspace.value));
    const activeWorkspaceCanSave = computed(() => (
        options.activeWorkspace.value?.getToolbarSnapshot?.().canSave === true
    ));
    const activeTabHasDocumentHint = computed(() => {
        const tab = activeTab.value;
        if (!tab) {
            return false;
        }

        return tabHasDocumentHint(tab);
    });
    const hasDocument = computed(() => activeWorkspaceHasDocument.value || activeTabHasDocumentHint.value);
    const tabCount = computed(() => options.tabs.value.length);

    return {
        activeTab,
        activeWorkspaceHasDocument,
        activeWorkspaceCanSave,
        activeTabHasDocumentHint,
        hasDocument,
        tabCount,
    };
};
