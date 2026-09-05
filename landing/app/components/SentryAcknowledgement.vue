<template>
  <div class="sentry-acknowledgement">
    <img
      class="sentry-wordmark"
      :src="SENTRY_WORDMARK_PATH"
      alt="Sentry"
      width="200"
      height="44"
      loading="lazy"
      decoding="async"
    >

    <p class="sentry-acknowledgement-copy">
      {{ t('footer.sentryAcknowledgement.message') }}
      <a
        href="https://sentry.io/for/open-source/"
        target="_blank"
        rel="noopener noreferrer"
      >{{ t('footer.sentryAcknowledgement.linkLabel') }}</a>.
    </p>
  </div>
</template>

<script setup lang="ts">
import { useTypedI18n } from '../composables/useTypedI18n';

const SENTRY_WORDMARK_PATH = '/sentry-wordmark.svg';
const { t } = useTypedI18n();
</script>

<style scoped>
.sentry-acknowledgement {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
  max-width: 36rem;
  color: var(--landing-muted);
}

.sentry-wordmark {
  display: block;
  flex: 0 0 auto;
  width: 5.5rem;
  max-width: min(34vw, 5.5rem);
  height: auto;
}

/* The wordmark loads through <img>, so currentColor resolves to black inside
   its own document and the dark theme cannot tint it. The asset stays
   untouched; the dark theme puts it on its own light plate instead. */
html.dark .sentry-wordmark {
  box-sizing: content-box;
  padding: 0.3rem 0.4rem;
  border-radius: 0.4rem;
  background: #fff;
}

/* Balanced lines keep the trailing link from breaking into a one-word last
   line, which is what the single-column footer used to do. */
.sentry-acknowledgement-copy {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.45;
  text-wrap: balance;
}

.sentry-acknowledgement-copy a {
  color: var(--landing-accent);
  text-decoration: underline;
  text-underline-offset: 0.18rem;
}

.sentry-acknowledgement-copy a:focus-visible {
  outline: 0.15rem solid var(--landing-accent);
  outline-offset: 0.18rem;
  border-radius: 0.15rem;
}

@media (width <= 40rem) {
  .sentry-acknowledgement {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.5rem;
  }
}
</style>
