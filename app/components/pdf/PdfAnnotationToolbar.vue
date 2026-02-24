<template>
    <section class="notes-section notes-tools">
        <header class="notes-section-header">
            <h3 class="notes-section-title">{{ t('annotations.create') }}</h3>
            <p class="notes-section-description">{{ t('annotations.createDescription') }}</p>
        </header>

        <button
            type="button"
            class="tool-button tool-button--select"
            :class="{ 'is-active': tool === 'none' }"
            @click="emit('set-tool', 'none')"
        >
            <UIcon name="i-lucide-mouse-pointer" class="tool-button-icon" />
            <span class="tool-button-label">{{ t('annotations.cursor') }}</span>
        </button>

        <div class="grid grid-cols-2 gap-1.5">
            <button
                v-for="toolItem in toolItems"
                :key="toolItem.id"
                type="button"
                class="tool-button"
                :class="{ 'is-active': tool === toolItem.id }"
                @click="emit('set-tool', tool === toolItem.id ? 'none' : toolItem.id)"
            >
                <UIcon :name="toolItem.icon" class="tool-button-icon" />
                <span class="tool-button-label">{{ toolItem.label }}</span>
            </button>
        </div>

        <label class="keep-active-toggle">
            <input
                type="checkbox"
                :checked="keepActive"
                @change="emit('update:keep-active', ($event.target as HTMLInputElement).checked)"
            />
            {{ t('annotations.keepActive') }}
        </label>

        <p class="annotation-exit-hint">
            {{ t('annotations.exitModeHint') }}
        </p>
    </section>
</template>

<script setup lang="ts">
import type { TAnnotationTool } from '@app/types/annotations';

interface IToolItem {
    id: TAnnotationTool;
    label: string;
    icon: string;
}

interface IProps {
    tool: TAnnotationTool;
    keepActive: boolean;
}

const { t } = useTypedI18n();

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
    (e: 'update:keep-active', value: boolean): void;
}>();

const tool = computed(() => props.tool);
const keepActive = computed(() => props.keepActive);

const toolItems = computed<IToolItem[]>(() => [
    {
        id: 'draw',
        label: t('annotations.draw'),
        icon: 'i-lucide-pen-tool',
    },
    {
        id: 'text',
        label: t('annotations.text'),
        icon: 'i-lucide-type',
    },
    {
        id: 'highlight',
        label: t('annotations.highlight'),
        icon: 'i-lucide-highlighter',
    },
    {
        id: 'underline',
        label: t('annotations.underline'),
        icon: 'i-lucide-underline',
    },
    {
        id: 'strikethrough',
        label: t('annotations.strikethrough'),
        icon: 'i-lucide-strikethrough',
    },
    {
        id: 'rectangle',
        label: t('annotations.rectangle'),
        icon: 'i-lucide-square',
    },
    {
        id: 'circle',
        label: t('annotations.circle'),
        icon: 'i-lucide-circle',
    },
    {
        id: 'line',
        label: t('annotations.line'),
        icon: 'i-lucide-minus',
    },
    {
        id: 'arrow',
        label: t('annotations.arrow'),
        icon: 'i-lucide-arrow-up-right',
    },
]);
</script>

<style scoped>
.notes-section {
    border: 1px solid var(--app-notes-section-border);
    border-radius: var(--app-notes-section-radius);
    background: var(--app-notes-section-bg);
    padding: var(--app-notes-section-padding);
    display: flex;
    flex-direction: column;
    gap: var(--app-notes-section-gap);
    box-shadow: var(--app-notes-section-shadow);
}

.notes-section-header {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.notes-section-title {
    margin: 0;
    font-size: var(--app-notes-section-title-size);
    line-height: var(--app-notes-section-title-line-height);
    letter-spacing: var(--app-notes-section-title-letter-spacing);
    text-transform: uppercase;
    color: var(--app-notes-section-title-color);
}

.notes-section-description {
    margin: 0;
    font-size: var(--app-notes-section-description-size);
    line-height: var(--app-notes-section-description-line-height);
    color: var(--app-notes-section-description-color);
}

.tool-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 0.8rem;
    font-weight: 600;
    min-height: 2.1rem;
    cursor: pointer;
}

.tool-button--select {
    width: 100%;
}

.tool-button:hover {
    border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border) 60%);
    color: var(--ui-text-highlighted);
}

.tool-button.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 55%, var(--ui-border) 45%);
    background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg) 88%);
    color: var(--ui-text-highlighted);
}

.tool-button-icon {
    font-size: 0.95rem;
}

.tool-button-label {
    white-space: nowrap;
}

.keep-active-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.82rem;
    color: var(--ui-text-muted);
    cursor: pointer;
}

.keep-active-toggle input[type="checkbox"] {
    accent-color: var(--ui-primary);
}

.annotation-exit-hint {
    margin: 0;
    font-size: 0.76rem;
    line-height: 1.35;
    color: var(--ui-text-toned);
}
</style>
