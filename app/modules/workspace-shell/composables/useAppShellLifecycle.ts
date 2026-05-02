import type { Ref } from 'vue';
import type { IWindowTabIncomingTransfer } from '@contracts/window-tabs';
import { traceRendererStartup } from '@app/utils/startup-trace';
import { getWindowTabsCapability } from '@app/utils/platform-window-tabs';

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

export const useAppShellLifecycle = (options: IUseAppShellLifecycleOptions) => {
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
        void ensureUpdatesInitialized();

        incomingTabTransferCleanup = getWindowTabsCapability().onIncomingTransfer((transfer) => {
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
};
