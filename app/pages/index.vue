<template>
    <WebHomePage />
</template>

<script setup lang="ts">
import { hasElectronAPI } from '@app/utils/platform';
import WebHomePage from '@app/components/web/WebHomePage.vue';

if (import.meta.client && hasElectronAPI()) {
    await navigateTo('/electron', { replace: true });
}
</script>
