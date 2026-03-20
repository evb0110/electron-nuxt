<template>
    <AppShellRoot />
</template>

<script setup lang="ts">
import AppShellRoot from '@app/modules/workspace-shell/components/AppShellRoot.vue';
import { hasElectronAPI } from '@app/utils/platform';
import { useWebSeo } from '@app/composables/useWebSeo';

useWebSeo();

if (import.meta.client && hasElectronAPI()) {
    await navigateTo('/electron', { replace: true });
}
</script>
