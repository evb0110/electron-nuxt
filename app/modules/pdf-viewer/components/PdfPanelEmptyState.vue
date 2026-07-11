<template>
    <div class="pdf-panel-empty-state" :class="{ 'has-action': Boolean($slots.action) }">
        <UIcon :name="icon" class="pdf-panel-empty-state__icon" />
        <p class="pdf-panel-empty-state__title">
            {{ title }}
        </p>
        <p v-if="description" class="pdf-panel-empty-state__description">
            {{ description }}
        </p>
        <div v-if="$slots.action" class="pdf-panel-empty-state__action">
            <slot name="action" />
        </div>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    icon: string;
    title: string;
    description?: string;
}>();
</script>

<style scoped>
.pdf-panel-empty-state {
    display: flex;
    min-height: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: var(--app-panel-empty-padding);
    text-align: center;
    color: var(--ui-text-muted);
}

.pdf-panel-empty-state__icon {
    width: var(--app-panel-empty-icon-size);
    height: var(--app-panel-empty-icon-size);
    color: var(--ui-text-dimmed);
}

.pdf-panel-empty-state__title {
    margin: 0;
    font-size: var(--app-text-size-panel-title);
    font-weight: 600;
    color: var(--ui-text);
}

.pdf-panel-empty-state__description {
    margin: 0;
    max-width: var(--app-panel-empty-max-width);
    font-size: var(--app-text-size-body-sm);
    line-height: 1.45;
}

.pdf-panel-empty-state__action {
    margin-top: 0.25rem;
}
</style>
