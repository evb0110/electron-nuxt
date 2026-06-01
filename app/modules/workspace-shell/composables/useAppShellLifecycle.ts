import type { Ref } from 'vue';
import type { IWindowTabIncomingTransfer } from '@contracts/windowTabs';
import { traceRendererStartup } from '@app/utils/startupTrace';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';

interface IUseAppShellLifecycleOptions {
    dirtyTabCloseDialogOpen: Ref<boolean>;
    updatesDialogOpen: Ref<boolean>;
    observeToolbarHost: () => void;
    cleanupEmptyPanes: () => void;
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
        cleanupEmptyPanes,
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
        cleanupEmptyPanes();
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
