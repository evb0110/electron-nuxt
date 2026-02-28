<template>
    <div class="annotation-toolbar">
        <div v-if="activeToolItem" class="active-tool-banner">
            <UIcon :name="activeToolItem.icon" class="active-tool-banner-icon" />
            <span class="active-tool-banner-label">{{ activeToolItem.label }}</span>
            <button
                type="button"
                class="active-tool-banner-close"
                :aria-label="t('annotations.closeTool')"
                @click="emit('set-tool', 'none')"
            >
                <UIcon name="i-lucide-x" />
            </button>
        </div>

        <div class="tool-grid">
            <UTooltip
                v-for="toolItem in toolItems"
                :key="toolItem.id"
                :text="toolItem.label"
                :delay-duration="400"
            >
                <button
                    type="button"
                    class="tool-button"
                    :class="{ 'is-active': tool === toolItem.id }"
                    :data-tool="toolItem.id"
                    @click="emit('set-tool', tool === toolItem.id ? 'none' : toolItem.id)"
                >
                    <UIcon :name="toolItem.icon" class="tool-button-icon" />
                </button>
            </UTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TAnnotationTool } from '@app/types/annotations';

interface IToolItem {
    id: TAnnotationTool;
    label: string;
    icon: string;
}

interface IProps { tool: TAnnotationTool }

const { t } = useTypedI18n();

const props = defineProps<IProps>();

const emit = defineEmits<{ (e: 'set-tool', tool: TAnnotationTool): void }>();

const tool = computed(() => props.tool);

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

const activeToolItem = computed(() => {
    if (tool.value === 'none') {
        return null;
    }
    return toolItems.value.find(item => item.id === tool.value) ?? null;
});
</script>

<style scoped>
.annotation-toolbar {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.active-tool-banner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.55rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg) 88%);
    border: 1px solid color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border) 60%);
    color: var(--ui-text-highlighted);
}

.active-tool-banner-icon {
    font-size: 0.9rem;
    color: var(--ui-primary);
}

.active-tool-banner-label {
    flex: 1 1 auto;
    font-size: 0.82rem;
    font-weight: 600;
}

.active-tool-banner-close {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    border: none;
    border-radius: 0.3rem;
    background: transparent;
    color: var(--ui-text-muted);
    font-size: 0.85rem;
    cursor: pointer;
}

.active-tool-banner-close:hover {
    background: color-mix(in srgb, var(--ui-primary) 18%, transparent);
    color: var(--ui-text-highlighted);
}

.tool-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 0.3rem;
}

.tool-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    min-height: 2.1rem;
    cursor: pointer;
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
</style>
