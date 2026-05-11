import {
    isDesktopPlatformActive,
    resolveInitialDesktopRuntime,
    shouldPreferDesktopPlatform,
} from '@app/utils/platform';

export const useRuntimeEnvironment = () => {
    const route = useRoute();
    const routePath = route.path;
    const initialDesktopRuntime = resolveInitialDesktopRuntime(routePath);
    const isDesktopRuntime = typeof useState === 'function'
        ? useState('runtime:is-desktop', () => initialDesktopRuntime)
        : ref(initialDesktopRuntime);

    onMounted(() => {
        if (!import.meta.client) {
            return;
        }
        isDesktopRuntime.value = shouldPreferDesktopPlatform(
            routePath,
            isDesktopRuntime.value,
            isDesktopPlatformActive(),
        );
    });

    return {
        isDesktopRuntime: computed(() => isDesktopRuntime.value),
        isBrowserRuntime: computed(() => !isDesktopRuntime.value),
    };
};
