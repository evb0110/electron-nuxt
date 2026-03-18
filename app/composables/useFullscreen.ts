export const useFullscreen = () => {
    const isFullscreen = ref(false);
    const isSupported = ref(true);

    function updateState() {
        isFullscreen.value = Boolean(document.fullscreenElement);
    }

    function toggleFullscreen() {
        if (!isSupported.value) {
            return;
        }

        if (document.fullscreenElement) {
            void document.exitFullscreen();
        } else {
            void document.documentElement.requestFullscreen();
        }
    }

    onMounted(() => {
        isSupported.value = Boolean(document.fullscreenEnabled);
        document.addEventListener('fullscreenchange', updateState);
        updateState();
    });

    onUnmounted(() => {
        document.removeEventListener('fullscreenchange', updateState);
    });

    return {
        isFullscreen,
        isSupported,
        toggleFullscreen,
    };
};
