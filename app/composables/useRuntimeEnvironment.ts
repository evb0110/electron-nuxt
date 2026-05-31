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

    if (getCurrentInstance()) {
        const updateRuntimeState = (path: string | null | undefined) => {
            if (!import.meta.client) {
                return;
            }
            isDesktopRuntime.value = shouldPreferDesktopPlatform(
                path,
                false,
                isDesktopPlatformActive(),
            );
        };
        onMounted(() => {
            updateRuntimeState(route.path);
        });
        watch(() => route.path, updateRuntimeState);
    }

    return {
        isDesktopRuntime: computed(() => isDesktopRuntime.value),
        isBrowserRuntime: computed(() => !isDesktopRuntime.value),
    };
};
