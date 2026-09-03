<template>
  <div class="sentry-acknowledgement">
    <div class="sentry-wordmark-frame">
      <img
        class="sentry-wordmark"
        :src="SENTRY_WORDMARK_PATH"
        alt="Sentry"
        width="200"
        height="44"
        loading="lazy"
        decoding="async"
      >
    </div>

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
  align-items: center;
  gap: 1rem;
  min-width: 0;
  color: var(--landing-muted);
}

.sentry-wordmark-frame {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--landing-border);
  border-radius: 0.45rem;
  background: #fff;
}

.sentry-wordmark {
  display: block;
  width: 10rem;
  max-width: min(40vw, 10rem);
  height: auto;
}

.sentry-acknowledgement-copy {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.5;
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
  }

  .sentry-wordmark {
    max-width: min(100%, 10rem);
  }
}
</style>
