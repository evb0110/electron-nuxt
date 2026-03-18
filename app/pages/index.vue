<template>
    <AppShellRoot />
</template>

<script setup lang="ts">
import AppShellRoot from '@app/modules/workspace-shell/components/AppShellRoot.vue';
import { createWebSsrBootstrapScript } from '@app/utils/browser-runtime-persistence';
import { hasElectronAPI } from '@app/utils/platform';
import { useWebSeo } from '@app/composables/useWebSeo';

useWebSeo();
useHead({ script: [{
    key: 'web-ssr-bootstrap',
    innerHTML: createWebSsrBootstrapScript(),
    tagPosition: 'head',
}] });

if (import.meta.client && hasElectronAPI()) {
    await navigateTo('/electron', { replace: true });
}
</script>
