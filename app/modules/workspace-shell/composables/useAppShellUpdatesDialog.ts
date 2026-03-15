import type {
    ComputedRef,
    Ref,
} from 'vue';

interface IUpdateDialogState {
    open: boolean;
    kind: 'status' | 'ready';
    phase: 'checking' | 'downloading' | 'no-update' | 'error' | 'unsupported';
    version: string | null;
    percent: number | null;
    message: string | null;
}

interface IUseAppShellUpdatesDialogOptions {
    updatesDialog: Ref<IUpdateDialogState>;
    updatesDialogVersion: ComputedRef<string | null | undefined>;
    closeUpdatesDialog: () => void;
    deferUpdate: () => Promise<void>;
    skipUpdateVersion: () => Promise<void>;
    installUpdateNow: () => Promise<void>;
    t: (key: string, params?: Record<string, unknown>) => string;
}

export function useAppShellUpdatesDialog(options: IUseAppShellUpdatesDialogOptions) {
    const updatesDialogTitle = computed(() => {
        if (options.updatesDialog.value.kind === 'ready') {
            return options.t('updates.readyTitle');
        }

        switch (options.updatesDialog.value.phase) {
            case 'checking':
                return options.t('updates.checkingTitle');
            case 'downloading':
                return options.t('updates.downloadingTitle');
            case 'no-update':
                return options.t('updates.upToDateTitle');
            case 'error':
                return options.t('updates.errorTitle');
            case 'unsupported':
                return options.t('updates.unsupportedTitle');
            default:
                return options.t('updates.checkingTitle');
        }
    });

    const updatesDialogDescription = computed(() => {
        const version = options.updatesDialogVersion.value ?? options.t('updates.unknownVersion');

        if (options.updatesDialog.value.kind === 'ready') {
            return options.t('updates.readyDescription', { version });
        }

        switch (options.updatesDialog.value.phase) {
            case 'checking':
                return options.t('updates.checkingDescription');
            case 'downloading': {
                const percent = Math.max(0, Math.round(options.updatesDialog.value.percent ?? 0));
                return options.t('updates.downloadingDescription', {
                    version,
                    percent,
                });
            }
            case 'no-update':
                return options.t('updates.upToDateDescription', { version });
            case 'error':
                return options.t('updates.errorDescription', { message: options.updatesDialog.value.message ?? options.t('updates.unknownError') });
            case 'unsupported':
                return options.t('updates.unsupportedDescription');
            default:
                return options.t('updates.checkingDescription');
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
}
