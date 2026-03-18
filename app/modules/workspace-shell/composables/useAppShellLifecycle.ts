import type { Ref } from 'vue';
import type { IWindowTabIncomingTransfer } from '@contracts/window-tabs';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/platform';
import { traceRendererStartup } from '@app/utils/startup-trace';

interface IUseAppShellLifecycleOptions {
    dirtyTabCloseDialogOpen: Ref<boolean>;
    updatesDialogOpen: Ref<boolean>;
    observeToolbarHost: () => void;
    cleanupEmptyGroups: () => void;
    ensureUpdatesInitialized: () => Promise<void>;
    handleIncomingTabTransfer: (transfer: IWindowTabIncomingTransfer) => Promise<void>;
    cleanupDirectionalTabs: () => void;
    disposeToolbarTeleportBridge: () => void;
    cleanupExternalFileDrop: () => void;
    resolveDirtyTabCloseDialog: (confirmed: boolean) => void;
    closeUpdatesDialog: () => void;
}

export function useAppShellLifecycle(options: IUseAppShellLifecycleOptions) {
    const {
        dirtyTabCloseDialogOpen,
        updatesDialogOpen,
        observeToolbarHost,
        cleanupEmptyGroups,
        ensureUpdatesInitialized,
        handleIncomingTabTransfer,
        cleanupDirectionalTabs,
        disposeToolbarTeleportBridge,
        cleanupExternalFileDrop,
        resolveDirtyTabCloseDialog,
        closeUpdatesDialog,
    } = options;

    let incomingTabTransferCleanup: (() => void) | null = null;

    onMounted(() => {
        const start = performance.now();
        traceRendererStartup('index.vue onMounted start');

        observeToolbarHost();
        cleanupEmptyGroups();
        if (hasElectronAPI()) {
            void ensureUpdatesInitialized();
        }

        incomingTabTransferCleanup = getElectronAPI().windowTabs.onIncomingTransfer((transfer) => {
            void handleIncomingTabTransfer(transfer);
        });
        traceRendererStartup('index.vue onMounted finished', {durationMs: Math.round(performance.now() - start)});
    });

    onUnmounted(() => {
        cleanupDirectionalTabs();
        disposeToolbarTeleportBridge();
        incomingTabTransferCleanup?.();
        incomingTabTransferCleanup = null;
        cleanupExternalFileDrop();
    });

    watch(dirtyTabCloseDialogOpen, (isOpen) => {
        if (!isOpen) {
            resolveDirtyTabCloseDialog(false);
        }
    });

    watch(updatesDialogOpen, (isOpen) => {
        if (!isOpen) {
            closeUpdatesDialog();
        }
    });
}
