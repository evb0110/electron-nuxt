<template>
  <footer class="site-footer section-reveal section-delay-3">
    <div class="footer-copy">
      <p class="footer-title">{{ t('app.title') }}</p>
      <p class="footer-description">{{ t('app.description') }}</p>
      <p class="footer-meta">{{ t('footer.copyright') }}</p>
    </div>

    <div class="footer-links">
      <UButton
        v-if="webAppUrl"
        :label="t('home.hero.openInBrowser')"
        :to="webAppUrl"
        target="_blank"
        rel="noreferrer"
        color="primary"
        variant="soft"
        icon="i-lucide-globe"
      />
      <UButton
        :label="t('home.hero.browseInstallers')"
        :to="installersUrl"
        color="neutral"
        variant="outline"
        icon="i-lucide-download"
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
const runtimeConfig = useRuntimeConfig();
const webAppUrl = computed(() => runtimeConfig.public.webAppUrl?.trim() || '');
const installersUrl = computed(() => `${localePath('/')}#installers`);
</script>
