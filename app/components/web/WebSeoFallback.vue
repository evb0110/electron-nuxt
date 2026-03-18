<template>
    <main class="web-seo-fallback">
        <div class="web-seo-card">
            <p class="web-seo-eyebrow">
                {{ t('app.webTitle') }}
            </p>
            <h1 class="web-seo-title">
                {{ t('seo.heading') }}
            </h1>
            <p class="web-seo-lede">
                {{ t('seo.lede') }}
            </p>
            <ul class="web-seo-list">
                <li>{{ t('seo.featurePdf') }}</li>
                <li>{{ t('seo.featureAnnotate') }}</li>
                <li>{{ t('seo.featureDesktop') }}</li>
            </ul>
            <a
                v-if="browserInstallUrl"
                :href="browserInstallUrl"
                class="web-seo-link"
            >
                {{ t('webApp.installDesktop') }}
            </a>
        </div>
    </main>
</template>

<script setup lang="ts">
const { t } = useTypedI18n();
const runtimeConfig = useRuntimeConfig();

const browserInstallUrl = computed(() => {
    const url = typeof runtimeConfig.public.landingUrl === 'string'
        ? runtimeConfig.public.landingUrl.trim()
        : '';
    return url || null;
});
</script>

<style scoped>
.web-seo-fallback {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 2rem;
    background:
        radial-gradient(circle at top, color-mix(in oklab, var(--ui-primary) 10%, transparent), transparent 42%),
        var(--app-window-bg);
}

.web-seo-card {
    width: min(100%, 48rem);
    padding: 2rem;
    border: 1px solid var(--ui-border);
    border-radius: 1.5rem;
    background:
        linear-gradient(
            180deg,
            color-mix(in oklab, var(--ui-bg) 92%, var(--ui-primary) 8%),
            var(--ui-bg)
        );
    box-shadow: var(--shadow-popup);
}

.web-seo-eyebrow {
    margin: 0 0 0.75rem;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
}

.web-seo-title {
    margin: 0;
    font-size: clamp(2rem, 4vw, 3.5rem);
    line-height: 1.05;
    color: var(--ui-text-highlighted);
}

.web-seo-lede {
    margin: 1rem 0 0;
    max-width: 42rem;
    font-size: 1.02rem;
    line-height: 1.65;
    color: var(--ui-text);
}

.web-seo-list {
    margin: 1.5rem 0 0;
    padding-left: 1.25rem;
    display: grid;
    gap: 0.7rem;
    color: var(--ui-text-toned);
}

.web-seo-link {
    display: inline-flex;
    margin-top: 1.5rem;
    align-items: center;
    gap: 0.4rem;
    color: var(--ui-primary);
    font-weight: 600;
    text-decoration: none;
}

.web-seo-link:hover,
.web-seo-link:focus-visible {
    text-decoration: underline;
}
</style>
