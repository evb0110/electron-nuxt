<template>
    <div class="annotation-toolbar">
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
                    :aria-pressed="tool === toolItem.id"
                    @click="emit('set-tool', tool === toolItem.id ? 'none' : toolItem.id)"
                >
                    <UIcon :name="toolItem.icon" class="tool-button-icon" />
                    <span v-if="tool === toolItem.id" class="tool-button-active-indicator" aria-hidden="true" />
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
        id: 'select',
        label: t('annotations.select'),
        icon: 'i-lucide-scan',
    },
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
.annotation-toolbar {
    display: block;
}

.tool-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 0.3rem;
}

.tool-button {
    position: relative;
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
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-primary) 24%, transparent);
}

.tool-button-icon {
    font-size: 0.95rem;
}

.tool-button-active-indicator {
    position: absolute;
    top: 0.32rem;
    right: 0.32rem;
    width: 0.36rem;
    height: 0.36rem;
    border-radius: 999px;
    background: var(--ui-primary);
    box-shadow: 0 0 0 1px var(--ui-bg);
}
</style>
