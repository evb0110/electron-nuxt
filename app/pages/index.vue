<template>
    <ClientOnly>
        <component :is="AppShellRoot" v-if="AppShellRoot" />
        <template #fallback>
            <WebSeoFallback />
        </template>
    </ClientOnly>
</template>

<script setup lang="ts">
import { hasElectronAPI } from '@app/utils/platform';
import WebSeoFallback from '@app/components/web/WebSeoFallback.vue';
import { useWebSeo } from '@app/composables/useWebSeo';

const AppShellRoot = import.meta.client
    ? defineAsyncComponent(() => import('@app/modules/workspace-shell/components/AppShellRoot.vue'))
    : null;

useWebSeo();

if (import.meta.client && hasElectronAPI()) {
    await navigateTo('/electron', { replace: true });
}
</script>
