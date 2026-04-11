import {
    isDesktopPlatformActive,
    resolveInitialDesktopRuntime,
} from '@app/utils/platform';

function getRuntimeRoutePath() {
    if (typeof useRoute !== 'function') {
        return null;
    }

    return useRoute().path;
}

export function useRuntimeEnvironment() {
    const routePath = getRuntimeRoutePath();
    const initialDesktopRuntime = resolveInitialDesktopRuntime(routePath);
    const isDesktopRuntime = typeof useState === 'function'
        ? useState('runtime:is-desktop', () => initialDesktopRuntime)
        : ref(initialDesktopRuntime);

    if (import.meta.client) {
        onMounted(() => {
            isDesktopRuntime.value = isDesktopPlatformActive();
        });
    }

    return {
        isDesktopRuntime: computed(() => isDesktopRuntime.value),
        isBrowserRuntime: computed(() => !isDesktopRuntime.value),
    };
}
