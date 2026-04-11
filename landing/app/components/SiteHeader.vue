<template>
  <header class="site-header section-reveal">
    <NuxtLink
      class="brand-link"
      to="/"
    >
      <span class="brand-mark">EVB</span>
      <span class="brand-name">Viewer</span>
    </NuxtLink>

    <nav class="header-nav">
      <UButton
        v-for="item in navItems"
        :key="item.to"
        :label="item.label"
        :to="item.to"
        color="neutral"
        :variant="isActive(item.to) ? 'soft' : 'ghost'"
      />
    </nav>

    <div class="header-actions">
      <UButton
        v-if="webAppUrl"
        :label="t('home.hero.openInBrowser')"
        :to="webAppUrl"
        target="_blank"
        rel="noreferrer"
        icon="i-lucide-globe"
        color="primary"
        variant="soft"
        class="header-download"
      />

      <UButton
        :label="t('home.hero.browseInstallers')"
        :to="installersUrl"
        color="neutral"
        variant="outline"
      />

    </div>
  </header>
</template>

<script setup lang="ts">
const { t } = useTypedI18n();
const localePath = useLocalePath();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();
const webAppUrl = computed(() => runtimeConfig.public.webAppUrl?.trim() || '');
const installersUrl = computed(() => `${localePath('/')}#installers`);

const navItems = computed(() => [
    {
        label: t('header.nav.home'),
        to: localePath('/'),
    },
    {
        label: t('header.nav.features'),
        to: localePath('/features'),
    },
    {
        label: t('header.nav.docs'),
        to: localePath('/docs'),
    },
]);

function isActive(to: string) {
    return route.path === to;
}
</script>
