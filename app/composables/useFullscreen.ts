import { useFullscreen as useVueUseFullscreen } from '@vueuse/core';

export const useFullscreen = () => {
    const {
        isFullscreen,
        isSupported,
        toggle,
    } = useVueUseFullscreen(
        typeof document !== 'undefined'
            ? document.documentElement
            : undefined,
    );

    function toggleFullscreen() {
        void toggle();
    }

    return {
        isFullscreen,
        isSupported,
        toggleFullscreen,
    };
};
