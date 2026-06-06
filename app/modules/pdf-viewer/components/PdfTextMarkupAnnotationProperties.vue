<template>
    <div
        v-if="markup"
        class="annotation-properties"
        :style="positionStyle"
        @pointerdown.stop
        @click.stop
    >
        <div class="annotation-properties-header">
            <span class="annotation-properties-title">{{ markupLabel }}</span>
            <UButton
                icon="i-ph-x"
                variant="ghost"
                color="neutral"
                size="xs"
                :aria-label="t('annotationProperties.close')"
                @click="close"
            />
        </div>

        <div class="annotation-properties-body flex flex-col gap-2">
            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.color') }}</span>
                <input
                    type="color"
                    :value="markup.color"
                    class="annotation-properties-color"
                    @input="updateColor"
                >
            </label>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ITextMarkupAnnotationProperties } from '@app/types/annotations';

const { t } = useTypedI18n();

const {
    markup,
    x,
    y,
} = defineProps<{
    markup: ITextMarkupAnnotationProperties | null;
    x: number;
    y: number;
}>();

const emit = defineEmits<{
    (e: 'update-color', color: string): void;
    (e: 'close'): void;
}>();

const markupLabel = computed(() => {
    if (markup?.subtype === 'Underline') {
        return t('annotations.underline');
    }
    if (markup?.subtype === 'StrikeOut') {
        return t('annotations.strikethrough');
    }
    if (markup?.subtype === 'Squiggly') {
        return t('annotations.squiggly');
    }
    return t('annotations.highlight');
});

const positionStyle = computed(() => ({
    left: `${x}px`,
    top: `${y}px`,
}));

function updateColor(event: Event) {
    if (event.target instanceof HTMLInputElement) {
        emit('update-color', event.target.value);
    }
}

function close() {
    emit('close');
}
</script>

<style scoped>
.annotation-properties {
    position: fixed;
    z-index: 200;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--app-pdf-popover-shadow);
    min-width: 240px;
    max-width: 320px;
    font-size: 12px;
}

.annotation-properties-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 6px 6px 10px;
    border-bottom: 1px solid var(--ui-border);
}

.annotation-properties-title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--ui-text-muted);
}

.annotation-properties-body {
    padding: 8px 10px;
}

.annotation-properties-field {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.5rem;
}

.annotation-properties-label {
    color: var(--ui-text-muted);
}

.annotation-properties-color {
    width: 2rem;
    height: 1.5rem;
    padding: 0;
    border: 1px solid var(--ui-border);
    border-radius: 0.35rem;
    background: transparent;
}
</style>
