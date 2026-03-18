<template>
    <ClientOnly>
        <component :is="AppShellRoot" v-if="AppShellRoot" />
    </ClientOnly>
</template>

<script setup lang="ts">
import { hasElectronAPI } from '@app/utils/platform';
import { useWebSeo } from '@app/composables/useWebSeo';

const AppShellRoot = import.meta.client
    ? defineAsyncComponent(() => import('@app/modules/workspace-shell/components/AppShellRoot.vue'))
    : null;

useWebSeo({ noindex: true });

if (import.meta.client && !hasElectronAPI()) {
    await navigateTo('/', { replace: true });
}
</script>
