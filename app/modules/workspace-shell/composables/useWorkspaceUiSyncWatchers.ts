import type { Ref } from 'vue';

interface IWorkspaceUiSyncDeps {
    showSettings: Ref<boolean>;
    emitOpenSettings: () => void;
}

export const useWorkspaceUiSyncWatchers = (deps: IWorkspaceUiSyncDeps): void => {
    watch(deps.showSettings, (value: boolean) => {
        if (!value) {
            return;
        }

        deps.emitOpenSettings();
        deps.showSettings.value = false;
    });
};
