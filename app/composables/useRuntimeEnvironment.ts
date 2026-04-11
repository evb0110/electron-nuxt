import {
    isDesktopPlatformActive,
    resolveInitialDesktopRuntime,
} from '@app/utils/platform';

export function useRuntimeEnvironment() {
    const route = useRoute();
    const isDesktopRuntime = useState(
        'runtime:is-desktop',
        () => resolveInitialDesktopRuntime(route.path),
    );

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
