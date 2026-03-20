<template>
    <AppShellRoot />
</template>

<script setup lang="ts">
import AppShellRoot from '@app/modules/workspace-shell/components/AppShellRoot.vue';
import { hasElectronAPI } from '@app/utils/platform';

const { t } = useTypedI18n();

useServerSeoMeta({ robots: 'noindex, nofollow' });
useHead(() => ({ title: t('app.title') }));

if (import.meta.client && !hasElectronAPI()) {
    await navigateTo('/', { replace: true });
}
</script>
