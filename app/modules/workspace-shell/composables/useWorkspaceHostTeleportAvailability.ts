interface IWorkspaceHostTeleportAvailability {
    toolbarHostId: string;
    statusHostId: string;
}

export const useWorkspaceHostTeleportAvailability = (options: IWorkspaceHostTeleportAvailability) => {
    const canTeleportToolbar = ref(false);
    const canTeleportStatus = ref(false);

    function refreshTeleportHosts() {
        if (!import.meta.client) {
            return;
        }
        canTeleportToolbar.value = Boolean(document.getElementById(options.toolbarHostId));
        canTeleportStatus.value = Boolean(document.getElementById(options.statusHostId));
    }

    onMounted(() => {
        refreshTeleportHosts();
        void nextTick(refreshTeleportHosts);
    });

    return {
        canTeleportStatus,
        canTeleportToolbar,
    };
};
