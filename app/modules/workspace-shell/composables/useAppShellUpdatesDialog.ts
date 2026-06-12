import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { IUpdateDialogState } from '@app/composables/useAppUpdates';

interface IUseAppShellUpdatesDialogOptions {
    updatesDialog: Ref<IUpdateDialogState>;
    updatesDialogVersion: ComputedRef<string | null | undefined>;
    closeUpdatesDialog: () => void;
    deferUpdate: () => Promise<void>;
    skipUpdateVersion: () => Promise<void>;
    installUpdateNow: () => Promise<void>;
}

export const useAppShellUpdatesDialog = (options: IUseAppShellUpdatesDialogOptions) => {
    const { t } = useTypedI18n();

    const updatesDialogTitle = computed(() => {
        if (options.updatesDialog.value.kind === 'ready') {
            return t('updates.readyTitle');
        }

        switch (options.updatesDialog.value.phase) {
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
            default:
                return t('updates.checkingTitle');
        }
    });

    const updatesDialogDescription = computed(() => {
        const version = options.updatesDialogVersion.value ?? t('updates.unknownVersion');

        if (options.updatesDialog.value.kind === 'ready') {
            return t('updates.readyDescription', { version });
        }

        switch (options.updatesDialog.value.phase) {
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
                return t('updates.unsupportedDescription');
            default:
                return t('updates.checkingDescription');
        }
    });

    return {
        handleDeferUpdate() {
            options.closeUpdatesDialog();
            void options.deferUpdate();
        },
        handleInstallUpdate() {
            void options.installUpdateNow();
        },
        handleSkipUpdate() {
            options.closeUpdatesDialog();
            void options.skipUpdateVersion();
        },
        updatesDialogDescription,
        updatesDialogTitle,
    };
};
