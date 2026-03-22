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
        :label="t('home.hero.openLatestRelease')"
        :to="latestReleaseUrl"
        target="_blank"
        icon="i-lucide-download"
        color="primary"
        variant="soft"
        class="header-download"
      />

      <UButton
        :to="repositoryUrl"
        target="_blank"
        icon="i-simple-icons-github"
        color="neutral"
        variant="ghost"
      />

      <ClientOnly>
        <LanguageSwitcher />
      </ClientOnly>
    </div>
  </header>
</template>

<script setup lang="ts">
import LanguageSwitcher from '~/components/LanguageSwitcher.vue';

const { t } = useTypedI18n();
const route = useRoute();
const localePath = useLocalePath();
const repositoryUrl = 'https://github.com/evb0110/evb-viewer';
const latestReleaseUrl = 'https://github.com/evb0110/evb-viewer/releases/latest';

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
