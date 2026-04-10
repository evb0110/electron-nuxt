import {
    isDesktopPlatformActive,
    resolveInitialDesktopRuntime,
} from '@app/utils/platform';

function getCurrentRoutePath() {
    try {
        return useRoute()?.path ?? null;
    } catch {
        return null;
    }
}

function getDesktopRuntimeState(routePath: string | null) {
    try {
        return useState(
            'runtime:is-desktop',
            () => resolveInitialDesktopRuntime(routePath),
        );
    } catch {
        return ref(resolveInitialDesktopRuntime(routePath));
    }
}

export function useRuntimeEnvironment() {
    const routePath = getCurrentRoutePath();
    const isDesktopRuntime = getDesktopRuntimeState(routePath);

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
