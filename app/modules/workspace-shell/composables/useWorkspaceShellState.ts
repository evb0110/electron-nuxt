import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { ITab } from '@app/types/tabs';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

export interface IWorkspaceShellState {
    activeTab: ComputedRef<ITab | null>;
    activeWorkspaceHasDocument: ComputedRef<boolean>;
    activeWorkspaceCanPrint: ComputedRef<boolean>;
    activeWorkspaceCanSave: ComputedRef<boolean>;
    activeWorkspaceCanRepairSave: ComputedRef<boolean>;
    activeWorkspaceCanOptimizePdf: ComputedRef<boolean>;
    activeTabHasDocumentHint: ComputedRef<boolean>;
    hasDocument: ComputedRef<boolean>;
    tabCount: ComputedRef<number>;
}

export interface IUseWorkspaceShellStateOptions {
    activeDocumentRecord: Readonly<Ref<IWorkspaceDocumentRecord | null | undefined>>;
    activeTabId: Ref<string | null>;
    tabs: Ref<ITab[]>;
}

export const useWorkspaceShellState = (options: IUseWorkspaceShellStateOptions): IWorkspaceShellState => {
    const activeTab = computed(() => {
        const tabId = options.activeTabId.value;
        if (!tabId) {
            return null;
        }

        return options.tabs.value.find(candidate => candidate.id === tabId) ?? null;
    });
    const activeToolbarSnapshot = computed(() => options.activeDocumentRecord.value?.toolbarSnapshot ?? null);
    const activeWorkspaceHasDocument = computed(() => (
        activeToolbarSnapshot.value?.hasPdf === true
        || activeToolbarSnapshot.value?.isDjvuMode === true
    ));
    const activeWorkspaceCanPrint = computed(() => (
        activeWorkspaceHasDocument.value
        && activeToolbarSnapshot.value?.viewerCapabilities.print === true
    ));
    const activeWorkspaceCanSave = computed(() => activeToolbarSnapshot.value?.canSave === true);
    const activeWorkspaceCanRepairSave = computed(() => activeToolbarSnapshot.value?.canRepairSave === true);
    const activeWorkspaceCanOptimizePdf = computed(() => activeToolbarSnapshot.value?.canOptimizePdf === true);
    const activeTabHasDocumentHint = computed(() => {
        const tab = options.activeDocumentRecord.value?.tab ?? activeTab.value;
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
        activeWorkspaceCanPrint,
        activeWorkspaceCanSave,
        activeWorkspaceCanRepairSave,
        activeWorkspaceCanOptimizePdf,
        activeTabHasDocumentHint,
        hasDocument,
        tabCount,
    };
};
