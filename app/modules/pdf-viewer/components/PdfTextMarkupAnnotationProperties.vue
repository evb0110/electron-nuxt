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
    z-index: var(--app-pdf-annotation-properties-z-index);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-pdf-annotation-properties-radius);
    box-shadow: var(--app-pdf-popover-shadow);
    width: min(var(--app-pdf-annotation-properties-width), var(--app-pdf-annotation-properties-max-inline-size));
    min-width: min(var(--app-pdf-annotation-properties-min-width), var(--app-pdf-annotation-properties-max-inline-size));
    max-width: var(--app-pdf-annotation-properties-max-inline-size);
    font-size: var(--app-pdf-annotation-properties-font-size);
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
    font-size: var(--app-pdf-annotation-properties-title-font-size);
    text-transform: uppercase;
    letter-spacing: var(--app-pdf-annotation-properties-title-letter-spacing);
    color: var(--ui-text-muted);
    overflow-wrap: anywhere;
}

.annotation-properties-body {
    padding: var(--app-pdf-annotation-properties-body-padding);
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
