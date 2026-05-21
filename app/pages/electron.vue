<template>
    <AppShellRoot />
</template>

<script setup lang="ts">
import AppShellRoot from '@app/modules/workspace-shell/components/AppShellRoot.vue';
import { waitForDesktopPlatformBridge } from '@app/utils/platform';

const { t } = useTypedI18n();

definePageMeta({ preloadWorkspaceShell: false });
useServerSeoMeta({ robots: 'noindex, nofollow' });
useHead(() => ({ title: t('app.title') }));

onMounted(async () => {
    const hasDesktopBridge = await waitForDesktopPlatformBridge({ shouldWait: true });

    if (!hasDesktopBridge) {
        await navigateTo('/', { replace: true });
    }
});
</script>
