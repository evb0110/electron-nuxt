import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import type { IUpdateDialogState } from '@app/composables/useAppUpdates';

interface IUseAppShellUpdatesDialogOptions {
    updatesDialog: Ref<IUpdateDialogState>;
    updatesDialogVersion: ComputedRef<string | null | undefined>;
    closeUpdatesDialog: () => void;
    deferUpdate: () => Promise<void>;
    downloadUpdate: () => Promise<void>;
    skipUpdateVersion: () => Promise<void>;
    installUpdateNow: () => Promise<void>;
}

export const useAppShellUpdatesDialog = (options: IUseAppShellUpdatesDialogOptions) => {
    const { t } = useTypedI18n();

    const updatesDialogTitle = computed(() => {
        if (options.updatesDialog.value.kind === 'ready') {
            return t('updates.readyTitle');
        }
        if (options.updatesDialog.value.kind === 'available') {
            return t('updates.availableTitle');
        }

        switch (options.updatesDialog.value.phase) {
            case 'available':
                return t('updates.availableTitle');
            case 'checking':
                return t('updates.checkingTitle');
            case 'downloading':
                return t('updates.downloadingTitle');
            case 'no-update':
                return t('updates.upToDateTitle');
            case 'error':
                return t('updates.errorTitle');
            case 'unsupported':
                return t('updates.unsupportedTitle');
        }
    });

    const updatesDialogDescription = computed(() => {
        const version = options.updatesDialogVersion.value ?? t('updates.unknownVersion');

        if (options.updatesDialog.value.kind === 'ready') {
            return t('updates.readyDescription', { version });
        }
        if (options.updatesDialog.value.kind === 'available') {
            return t('updates.availableDescription', { version });
        }

        switch (options.updatesDialog.value.phase) {
            case 'available':
                return t('updates.availableDescription', { version });
            case 'checking':
                return t('updates.checkingDescription');
            case 'downloading': {
                const percent = Math.max(0, Math.round(options.updatesDialog.value.percent ?? 0));
                return t('updates.downloadingDescription', {
                    version,
                    percent,
                });
            }
            case 'no-update':
                return t('updates.upToDateDescription', { version });
            case 'error':
                return t('updates.errorDescription', { message: options.updatesDialog.value.message ?? t('updates.unknownError') });
            case 'unsupported':
                return options.updatesDialog.value.message ?? t('updates.unsupportedDescription');
        }
    });

    const updatesDialogFailurePresentation = computed<FailurePresentation | null>(() => {
        const failure = options.updatesDialog.value.failure;
        if (!failure) {
            return null;
        }
        return {
            ...failure,
            title: updatesDialogTitle.value,
            description: updatesDialogDescription.value,
        };
    });

    return {
        handleDeferUpdate() {
            options.closeUpdatesDialog();
            void options.deferUpdate();
        },
        handleDownloadUpdate() {
            void options.downloadUpdate();
        },
        handleInstallUpdate() {
            void options.installUpdateNow();
        },
        handleSkipUpdate() {
            options.closeUpdatesDialog();
            void options.skipUpdateVersion();
        },
        updatesDialogDescription,
        updatesDialogFailurePresentation,
        updatesDialogTitle,
    };
};
