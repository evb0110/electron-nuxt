<template>
  <footer class="site-footer">
    <div class="footer-copy">
      <p class="footer-title">{{ t('app.title') }}</p>
      <p class="footer-meta">{{ t('footer.copyright') }}</p>
    </div>

    <div class="footer-links">
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
const repositoryUrl = 'https://github.com/evb0110/evb-viewer';
</script>
