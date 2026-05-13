<template>
    <div
        v-if="shape"
        class="annotation-properties"
        :style="positionStyle"
        @pointerdown.stop
        @click.stop
    >
        <div class="annotation-properties-header">
            <span class="annotation-properties-title">{{ shapeLabel }}</span>
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
                    :value="shape.color"
                    class="annotation-properties-color"
                    @input="updateColor"
                >
            </label>

            <label v-if="shape.type === 'rectangle' || shape.type === 'circle' || shape.type === 'polygon'" class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.fill') }}</span>
                <div class="annotation-properties-fill-row">
                    <input
                        type="color"
                        :value="effectiveFillColor"
                        class="annotation-properties-color"
                        :disabled="!hasFill"
                        @input="updateFillColor"
                    >
                    <label class="annotation-properties-checkbox">
                        <input
                            type="checkbox"
                            :checked="hasFill"
                            @change="toggleFill"
                        >
                        {{ t('annotationProperties.fill') }}
                    </label>
                </div>
            </label>

            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.stroke') }}</span>
                <input
                    type="range"
                    :value="shape.strokeWidth"
                    min="1"
                    max="10"
                    step="0.5"
                    class="annotation-properties-range"
                    @input="updateStrokeWidth"
                >
                <span class="annotation-properties-value">{{ shape.strokeWidth }}px</span>
            </label>

            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.opacity') }}</span>
                <input
                    type="range"
                    :value="shape.opacity"
                    min="0.1"
                    max="1"
                    step="0.1"
                    class="annotation-properties-range"
                    @input="updateOpacity"
                >
                <span class="annotation-properties-value">{{ Math.round(shape.opacity * 100) }}%</span>
            </label>

            <button
                type="button"
                class="annotation-properties-delete"
                @click="deleteAnnotation"
            >
                <UIcon name="i-ph-trash" class="annotation-properties-delete-icon" />
                <span>{{ t('annotationProperties.delete') }}</span>
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { IShapeAnnotation } from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';

const { t } = useTypedI18n();

interface IProps {
    shape: IShapeAnnotation | null;
    x: number;
    y: number;
}

const {
    shape,
    x,
    y,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update', updates: Partial<IShapeAnnotation>): void;
    (e: 'close'): void;
    (e: 'delete'): void;
}>();

function getShapeLabel(type: IShapeAnnotation['type'] | undefined) {
    if (type === 'rectangle') {
        return t('annotationProperties.rectangle');
    }
    if (type === 'circle') {
        return t('annotationProperties.ellipse');
    }
    if (type === 'line' || type === 'polyline') {
        return t('annotationProperties.line');
    }
    if (type === 'arrow') {
        return t('annotationProperties.arrow');
    }
    return t('annotationProperties.shape');
}

const shapeLabel = computed(() => {
    return getShapeLabel(shape?.type);
});

const hasFill = computed(() => {
    const fill = shape?.fillColor;
    return !!fill && fill !== 'transparent' && fill !== 'none';
});

const effectiveFillColor = computed(() => {
    if (hasFill.value) {
        return shape?.fillColor ?? DEFAULT_ANNOTATION_SETTINGS.shapeColor;
    }
    return DEFAULT_ANNOTATION_SETTINGS.shapeColor;
});

const positionStyle = computed(() => ({
    left: `${x}px`,
    top: `${y}px`,
}));

function updateProperty<K extends keyof IShapeAnnotation>(key: K, value: IShapeAnnotation[K]) {
    emit('update', { [key]: value });
}

function inputValue(event: Event) {
    return event.target instanceof HTMLInputElement ? event.target.value : '';
}

function numericInputValue(event: Event) {
    return Number(inputValue(event));
}

function updateColor(event: Event) {
    updateProperty('color', inputValue(event));
}

function updateFillColor(event: Event) {
    updateProperty('fillColor', inputValue(event));
}

function updateStrokeWidth(event: Event) {
    updateProperty('strokeWidth', numericInputValue(event));
}

function updateOpacity(event: Event) {
    updateProperty('opacity', numericInputValue(event));
}

function close() {
    emit('close');
}

function deleteAnnotation() {
    emit('delete');
}

function toggleFill() {
    if (hasFill.value) {
        emit('update', { fillColor: 'transparent' });
    } else {
        emit('update', { fillColor: shape?.color ?? DEFAULT_ANNOTATION_SETTINGS.shapeColor });
    }
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

.annotation-properties-delete {
    margin-top: 0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 2rem;
    padding: 0.45rem 0.75rem;
    border: 1px solid color-mix(in oklab, var(--ui-error) 24%, var(--ui-border) 76%);
    border-radius: 0.5rem;
    background:
        linear-gradient(
            180deg,
            color-mix(in oklab, var(--ui-bg-elevated) 92%, var(--ui-error) 8%),
            color-mix(in oklab, var(--ui-bg-elevated) 84%, var(--ui-error) 16%)
        );
    color: var(--app-pdf-context-menu-danger-fg);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    cursor: pointer;
    transition:
        border-color 0.15s ease,
        background 0.15s ease,
        color 0.15s ease,
        transform 0.15s ease;
}

.annotation-properties-delete:hover {
    border-color: color-mix(in oklab, var(--ui-error) 38%, var(--ui-border) 62%);
    background:
        linear-gradient(
            180deg,
            color-mix(in oklab, var(--ui-bg-elevated) 86%, var(--ui-error) 14%),
            color-mix(in oklab, var(--ui-bg-elevated) 74%, var(--ui-error) 26%)
        );
    color: var(--ui-error);
}

.annotation-properties-delete:active {
    transform: translateY(1px);
}

.annotation-properties-delete:focus-visible {
    outline: 2px solid color-mix(in oklab, var(--ui-error) 55%, white 45%);
    outline-offset: 2px;
}

.annotation-properties-delete-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
}

.annotation-properties-field {
    display: grid;
    grid-template-columns: minmax(88px, auto) minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px 10px;
}

.annotation-properties-label {
    font-size: 11px;
    color: var(--ui-text-muted);
    line-height: 1.25;
    overflow-wrap: anywhere;
}

.annotation-properties-color {
    justify-self: start;
    width: 28px;
    height: 28px;
    padding: 1px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    cursor: pointer;
    background: transparent;
}

.annotation-properties-color:disabled {
    opacity: 0.4;
    cursor: default;
}

.annotation-properties-fill-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
}

.annotation-properties-checkbox {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    font-size: 11px;
    color: var(--ui-text-muted);
    cursor: pointer;
}

.annotation-properties-range {
    flex: 1;
    min-width: 0;
    width: 100%;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: var(--ui-border);
    outline: none;
    cursor: pointer;
}

.annotation-properties-range::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--ui-text);
    border: 2px solid var(--app-sidebar-bg);
    cursor: pointer;
}

.annotation-properties-value {
    flex-shrink: 0;
    min-width: 44px;
    text-align: right;
    font-size: 11px;
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}
</style>
