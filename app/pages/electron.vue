<template>
    <AppShellRoot v-if="hasDesktopBridge" />
</template>

<script setup lang="ts">
import { AppShellRoot } from '@app/modules/workspace-shell/public/component-exports/appShellRoot';
import { validateElectronPlatformApi } from '@app/platform/validatePlatformApi';
import {
    isElectronUserAgent,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';

const { t } = useTypedI18n();
const { setFatalRuntimeError } = useFatalRuntimeError();
const hasDesktopBridge = ref(false);
const isDesktopRuntime = useState('runtime:is-desktop', () => true);

definePageMeta({ preloadWorkspaceShell: false });
useServerSeoMeta({ robots: 'noindex, nofollow' });
useHead(() => ({ title: t('app.title') }));

onMounted(async () => {
    isDesktopRuntime.value = true;
    const bridgeAvailable = await waitForDesktopPlatformBridge({ shouldWait: true });

    if (!bridgeAvailable) {
        if (isElectronUserAgent()) {
            setFatalRuntimeError(
                'startup',
                new Error('Electron preload bridge is unavailable on the Electron renderer route.'),
                'electron-preload-bridge',
            );
            return;
        }

        isDesktopRuntime.value = false;
        await navigateTo('/', { replace: true });
        return;
    }

    const validation = validateElectronPlatformApi((window as Window & {electronAPI?: unknown}).electronAPI);
    if (!validation.ok) {
        setFatalRuntimeError(
            'startup',
            new Error(t('errors.runtime.electronPlatformContract')),
            'electron-platform-contract',
        );
        return;
    }

    hasDesktopBridge.value = true;
});
</script>
