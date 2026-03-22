<template>
  <footer class="site-footer section-reveal section-delay-3">
    <div class="footer-copy">
      <p class="footer-title">{{ t('app.title') }}</p>
      <p class="footer-description">{{ t('app.description') }}</p>
      <p class="footer-meta">{{ t('footer.copyright') }}</p>
    </div>

    <div class="footer-links">
      <UButton
        :label="t('home.hero.openLatestRelease')"
        :to="latestReleaseUrl"
        target="_blank"
        color="primary"
        variant="soft"
        icon="i-lucide-download"
      />
      <UButton
        v-if="webAppUrl"
        :label="t('home.hero.openInBrowser')"
        :to="webAppUrl"
        target="_blank"
        rel="noreferrer"
        color="neutral"
        variant="outline"
        icon="i-lucide-globe"
      />
      <UButton
        :label="t('footer.docs')"
        :to="localePath('/docs')"
        color="neutral"
        variant="ghost"
      />
      <UButton
        :label="t('footer.features')"
        :to="localePath('/features')"
        color="neutral"
        variant="ghost"
      />
      <UButton
        :label="t('footer.viewSource')"
        :to="repositoryUrl"
        target="_blank"
        color="neutral"
        variant="ghost"
        icon="i-simple-icons-github"
      />
    </div>
  </footer>
</template>

<script setup lang="ts">
const { t } = useTypedI18n();
const localePath = useLocalePath();
const repositoryUrl = 'https://github.com/evb0110/evb-viewer';
const latestReleaseUrl = 'https://github.com/evb0110/evb-viewer/releases/latest';
const runtimeConfig = useRuntimeConfig();
const webAppUrl = computed(() => runtimeConfig.public.webAppUrl?.trim() || '');
</script>
