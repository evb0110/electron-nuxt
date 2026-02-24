import {
    computed,
    ref,
    type ComputedRef,
    type Ref,
} from 'vue';
import type { ITab } from '@app/types/tabs';
import type { TTranslateFn } from '@app/i18n/locales';

interface IUseDirtyTabCloseDialogDeps {
    tabs: Ref<ITab[]>;
    t: TTranslateFn;
}

interface IUseDirtyTabCloseDialog {
    dirtyTabCloseDialogOpen: Ref<boolean>;
    dirtyTabCloseTargetId: Ref<string | null>;
    dirtyTabCloseTargetName: ComputedRef<string>;
    confirmDirtyTabClose: () => void;
    requestDirtyTabCloseConfirmation: (tabId: string) => Promise<boolean>;
    resolveDirtyTabCloseDialog: (confirmed: boolean) => void;
}

export function useDirtyTabCloseDialog(
    deps: IUseDirtyTabCloseDialogDeps,
): IUseDirtyTabCloseDialog {
    const {
        tabs,
        t,
    } = deps;
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

    return {
        dirtyTabCloseDialogOpen,
        dirtyTabCloseTargetId,
        dirtyTabCloseTargetName,
        confirmDirtyTabClose,
        requestDirtyTabCloseConfirmation,
        resolveDirtyTabCloseDialog,
    };
}
