<template>
    <section class="tool-page" :aria-labelledby="titleId">
        <header class="tool-page-header">
            <UButton
                v-if="showBack"
                color="neutral"
                variant="ghost"
                icon="i-ph-arrow-left"
                :aria-label="t('common.back')"
                @click="close"
            />
            <div class="tool-page-heading">
                <div v-if="showEyebrow" class="tool-page-kicker">
                    <UIcon :name="icon" class="tool-page-kicker-icon" />
                    <span>{{ eyebrow }}</span>
                </div>
                <h1 :id="titleId" class="tool-page-title">
                    {{ title }}
                </h1>
                <p v-if="description" class="tool-page-description">
                    {{ description }}
                </p>
            </div>
        </header>

        <main class="tool-page-body">
            <slot />
        </main>
    </section>
</template>

<script setup lang="ts">
const {
    title,
    eyebrow,
    description = undefined,
    icon,
    showBack = true,
    showEyebrow = true,
} = defineProps<{
    title: string;
    eyebrow: string;
    description?: string;
    icon: string;
    showBack?: boolean;
    showEyebrow?: boolean;
}>();

const emit = defineEmits<{ 'close': [] }>();

const { t } = useTypedI18n();
const titleId = useId();

function close() {
    emit('close');
}
</script>

<style scoped>
.tool-page {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--app-start-bg);
    color: var(--ui-text);
}

.tool-page-header {
    display: flex;
    align-items: flex-start;
    gap: 0.85rem;
    border-bottom: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg) 86%, var(--app-start-bg) 14%);
    padding: 1rem clamp(1rem, 2.4vw, 2rem);
}

.tool-page-heading {
    min-width: 0;
}

.tool-page-kicker {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--ui-text-muted);
    font-size: 0.75rem;
    font-weight: 600;
}

.tool-page-kicker-icon {
    width: 0.95rem;
    height: 0.95rem;
}

.tool-page-title {
    margin: 0.2rem 0 0;
    color: var(--ui-text-highlighted);
    font-size: 1.35rem;
    font-weight: 650;
    letter-spacing: 0;
    line-height: 1.18;
}

.tool-page-description {
    max-width: 44rem;
    margin: 0.35rem 0 0;
    color: var(--ui-text-muted);
    font-size: 0.9rem;
    line-height: 1.45;
}

.tool-page-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: clamp(1rem, 2.4vw, 2rem);
}
</style>
