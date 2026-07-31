interface IWorkspaceHostTeleportAvailability {
    toolbarHostId: string;
    statusHostId: string;
}

export const useWorkspaceHostTeleportAvailability = (options: IWorkspaceHostTeleportAvailability) => {
    const canTeleportToolbar = ref(false);
    const canTeleportStatus = ref(false);
    let hostObserver: MutationObserver | null = null;
    let observerTimeout: number | null = null;

    function refreshTeleportHosts() {
        if (!import.meta.client) {
            return;
        }
        canTeleportToolbar.value = Boolean(document.getElementById(options.toolbarHostId));
        canTeleportStatus.value = Boolean(document.getElementById(options.statusHostId));
        if (canTeleportToolbar.value && canTeleportStatus.value) {
            hostObserver?.disconnect();
            hostObserver = null;
            if (observerTimeout !== null) {
                window.clearTimeout(observerTimeout);
                observerTimeout = null;
            }
        }
    }

    onMounted(() => {
        refreshTeleportHosts();
        if (!canTeleportToolbar.value || !canTeleportStatus.value) {
            hostObserver = new MutationObserver(refreshTeleportHosts);
            hostObserver.observe(document.documentElement, {
                childList: true,
                subtree: true,
            });
            observerTimeout = window.setTimeout(() => {
                hostObserver?.disconnect();
                hostObserver = null;
                observerTimeout = null;
            }, 5_000);
        }
        void nextTick(refreshTeleportHosts);
    });

    onBeforeUnmount(() => {
        hostObserver?.disconnect();
        hostObserver = null;
        if (observerTimeout !== null) {
            window.clearTimeout(observerTimeout);
            observerTimeout = null;
        }
    });

    return {
        canTeleportStatus,
        canTeleportToolbar,
    };
};
