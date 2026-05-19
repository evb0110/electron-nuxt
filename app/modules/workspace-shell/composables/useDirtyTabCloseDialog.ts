import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { ITab } from '@app/types/tabs';

interface IUseDirtyTabCloseDialogDeps {tabs: Ref<ITab[]>;}

interface IUseDirtyTabCloseDialog {
    dirtyTabCloseDialogOpen: Ref<boolean>;
    dirtyTabCloseTargetId: Ref<string | null>;
    dirtyTabCloseTargetName: ComputedRef<string>;
    confirmDirtyTabClose: () => void;
    requestDirtyTabCloseConfirmation: (tabId: string) => Promise<boolean>;
    resolveDirtyTabCloseDialog: (confirmed: boolean) => void;
}

export const useDirtyTabCloseDialog = (
    deps: IUseDirtyTabCloseDialogDeps,
): IUseDirtyTabCloseDialog => {
    const { tabs } = deps;
    const { t } = useTypedI18n();
    const dirtyTabCloseDialogOpen = ref(false);
    const dirtyTabCloseTargetId = ref<string | null>(null);
    let dirtyTabCloseDialogResolver: ((confirmed: boolean) => void) | null = null;

    const dirtyTabCloseTargetName = computed(() => {
        const tab = dirtyTabCloseTargetId.value
            ? tabs.value.find(candidate => candidate.id === dirtyTabCloseTargetId.value)
            : null;
        return tab?.fileName ?? t('tabs.newTab');
    });

    function resolveDirtyTabCloseDialog(confirmed: boolean) {
        const resolver = dirtyTabCloseDialogResolver;
        dirtyTabCloseDialogResolver = null;
        dirtyTabCloseTargetId.value = null;
        dirtyTabCloseDialogOpen.value = false;
        if (resolver) {
            resolver(confirmed);
        }
    }

    function confirmDirtyTabClose() {
        resolveDirtyTabCloseDialog(true);
    }

    function requestDirtyTabCloseConfirmation(tabId: string) {
        if (dirtyTabCloseDialogResolver) {
            resolveDirtyTabCloseDialog(false);
        }
        dirtyTabCloseTargetId.value = tabId;
        dirtyTabCloseDialogOpen.value = true;
        return new Promise<boolean>((resolve) => {
            dirtyTabCloseDialogResolver = resolve;
        });
    }

    if (getCurrentScope()) {
        onScopeDispose(() => {
            resolveDirtyTabCloseDialog(false);
        });
    }

    return {
        dirtyTabCloseDialogOpen,
        dirtyTabCloseTargetId,
        dirtyTabCloseTargetName,
        confirmDirtyTabClose,
        requestDirtyTabCloseConfirmation,
        resolveDirtyTabCloseDialog,
    };
};
