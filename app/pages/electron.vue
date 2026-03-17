<template>
    <AppShellRoot />
</template>

<script setup lang="ts">
import { hasElectronAPI } from '@app/utils/platform';
import AppShellRoot from '@app/modules/workspace-shell/components/AppShellRoot.vue';

if (import.meta.client && !hasElectronAPI()) {
    await navigateTo('/', { replace: true });
}
</script>
