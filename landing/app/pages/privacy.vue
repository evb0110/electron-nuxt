<template>
  <main aria-labelledby="privacy-title">
    <section class="page-intro">
      <h1
        id="privacy-title"
        class="page-title"
      >
        {{ t('privacy.hero.title') }}
      </h1>
      <p class="page-subtitle">
        {{ t('privacy.hero.subtitle') }}
      </p>
      <p class="privacy-effective-date">
        {{ t('privacy.hero.effectiveDate') }}
      </p>
    </section>

    <section class="content-section privacy-content">
      <div>
        <h2>{{ t('privacy.documents.heading') }}</h2>
        <p>{{ t('privacy.documents.body') }}</p>
      </div>

      <div>
        <h2>{{ t('privacy.assistant.heading') }}</h2>
        <p>{{ t('privacy.assistant.body') }}</p>
      </div>

      <div>
        <h2>{{ t('privacy.analytics.heading') }}</h2>
        <p>{{ t('privacy.analytics.body') }}</p>
      </div>

      <div>
        <h2>{{ t('privacy.settings.heading') }}</h2>
        <p>{{ t('privacy.settings.body') }}</p>
      </div>

      <div>
        <h2>{{ t('privacy.storage.heading') }}</h2>
        <p>{{ t('privacy.storage.body') }}</p>
      </div>

      <div>
        <h2>{{ t('privacy.retention.heading') }}</h2>
        <p>{{ t('privacy.retention.body') }}</p>
      </div>

      <div>
        <h2>{{ t('privacy.contact.heading') }}</h2>
        <p>
          {{ t('privacy.contact.intro') }}
          <a
            href="https://github.com/evb0110/evb-viewer/issues"
            target="_blank"
            rel="noreferrer"
          >{{ t('privacy.contact.linkLabel') }}</a>.
        </p>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
const { t } = useTypedI18n();

useLandingPageSeo({
    title: () => t('privacy.seo.title'),
    description: () => t('privacy.seo.description'),
});
</script>

<style scoped>
.privacy-effective-date {
  color: var(--landing-muted);
  font-family: var(--font-mono);
  font-size: 0.82rem;
}

.privacy-content {
  display: grid;
  gap: 2rem;
  max-width: 54rem;
}

.privacy-content h2 {
  margin-bottom: 0.6rem;
  color: var(--landing-ink);
  font-size: 1.15rem;
}

.privacy-content p {
  margin: 0;
  color: var(--landing-ink-soft);
  line-height: 1.75;
}

.privacy-content a {
  color: var(--landing-accent);
  text-decoration: underline;
  text-underline-offset: 0.18rem;
}
</style>
