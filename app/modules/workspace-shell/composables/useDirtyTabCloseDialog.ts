import type { Ref } from 'vue';
import type { ITab } from '@app/types/tabs';

interface IUseDirtyTabCloseDialogDeps {tabs: Ref<ITab[]>;}

interface IDirtyTabCloseTarget {
    id: string;
    documentInstanceId: ITab['documentInstanceId'] | null;
    name: string | null;
}

export const useDirtyTabCloseDialog = (
    deps: IUseDirtyTabCloseDialogDeps,
) => {
    const { tabs } = deps;
    const { t } = useTypedI18n();
    const dirtyTabCloseDialogOpen = ref(false);
    const dirtyTabCloseTargetId = ref<string | null>(null);
    const dirtyTabCloseTarget = ref<IDirtyTabCloseTarget | null>(null);
    let dirtyTabCloseDialogResolver: ((confirmed: boolean) => void) | null = null;

    const dirtyTabCloseTargetName = computed(() => dirtyTabCloseTarget.value?.name ?? t('tabs.newTab'));

    function isCurrentTarget(tab: ITab | undefined) {
        const target = dirtyTabCloseTarget.value;
        return target !== null
            && tab?.id === target.id
            && (tab.documentInstanceId ?? null) === target.documentInstanceId;
    }

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
        const target = dirtyTabCloseTarget.value;
        const tab = target ? tabs.value.find(candidate => candidate.id === target.id) : undefined;
        resolveDirtyTabCloseDialog(isCurrentTarget(tab));
    }

    function requestDirtyTabCloseConfirmation(tabId: string) {
        if (dirtyTabCloseDialogResolver) {
            resolveDirtyTabCloseDialog(false);
        }
        const tab = tabs.value.find(candidate => candidate.id === tabId);
        if (!tab) {
            return Promise.resolve(false);
        }
        dirtyTabCloseTarget.value = {
            id: tab.id,
            documentInstanceId: tab.documentInstanceId ?? null,
            name: tab.fileName,
        };
        dirtyTabCloseTargetId.value = tabId;
        dirtyTabCloseDialogOpen.value = true;
        return new Promise<boolean>((resolve) => {
            dirtyTabCloseDialogResolver = resolve;
        });
    }

    watch(() => {
        const target = dirtyTabCloseTarget.value;
        const tab = target ? tabs.value.find(candidate => candidate.id === target.id) : undefined;
        return tab ? [
            tab.id,
            tab.documentInstanceId ?? null,
        ] : [
            null,
            null,
        ];
    }, () => {
        if (dirtyTabCloseDialogResolver && !isCurrentTarget(
            dirtyTabCloseTarget.value
                ? tabs.value.find(candidate => candidate.id === dirtyTabCloseTarget.value?.id)
                : undefined,
        )) {
            resolveDirtyTabCloseDialog(false);
        }
    });

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
