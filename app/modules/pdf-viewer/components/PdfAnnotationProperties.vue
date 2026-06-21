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
                    <UCheckbox
                        v-model="fillModel"
                        class="annotation-properties-checkbox"
                        color="neutral"
                        size="xs"
                        :label="t('annotationProperties.fill')"
                    />
                </div>
            </label>

            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.stroke') }}</span>
                <USlider
                    v-model="strokeWidthModel"
                    class="annotation-properties-range"
                    color="neutral"
                    size="xs"
                    :ui="propertiesSliderUi"
                    :aria-label="t('annotationProperties.stroke')"
                    :min="1"
                    :max="10"
                    :step="0.5"
                />
                <span class="annotation-properties-value">{{ shape.strokeWidth }}px</span>
            </label>

            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.opacity') }}</span>
                <USlider
                    v-model="opacityModel"
                    class="annotation-properties-range"
                    color="neutral"
                    size="xs"
                    :ui="propertiesSliderUi"
                    :aria-label="t('annotationProperties.opacity')"
                    :min="0.1"
                    :max="1"
                    :step="0.1"
                />
                <span class="annotation-properties-value">{{ Math.round(shape.opacity * 100) }}%</span>
            </label>

            <UButton
                type="button"
                class="annotation-properties-delete"
                icon="i-ph-trash"
                color="error"
                variant="ghost"
                size="sm"
                block
                :label="t('annotationProperties.delete')"
                @click="deleteAnnotation"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type { IShapeAnnotation } from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';

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

const propertiesSliderUi = {
    track: 'annotation-properties-range-track',
    range: 'annotation-properties-range-fill',
    thumb: 'annotation-properties-range-thumb',
};

const emit = defineEmits<{
    update: [updates: Partial<IShapeAnnotation>];
    close: [];
    delete: [];
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
    if (type === 'polygon') {
        return t('annotations.polygonLabel');
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
    if (!shape || shape[key] === value) {
        return;
    }
    emit('update', { [key]: value });
}

function inputValue(event: Event) {
    return event.target instanceof HTMLInputElement ? event.target.value : '';
}

function sliderNumericValue(value: number | number[] | undefined) {
    return Array.isArray(value) ? value[0] ?? 0 : value ?? 0;
}

function updateColor(event: Event) {
    updateProperty('color', inputValue(event));
}

function updateFillColor(event: Event) {
    updateProperty('fillColor', inputValue(event));
}

function close() {
    emit('close');
}

function deleteAnnotation() {
    emit('delete');
}

function toggleFill() {
    if (hasFill.value) {
        updateProperty('fillColor', 'transparent');
    } else {
        updateProperty('fillColor', shape?.color ?? DEFAULT_ANNOTATION_SETTINGS.shapeColor);
    }
}

const fillModel = computed({
    get() {
        return hasFill.value;
    },
    set(value: boolean | 'indeterminate') {
        if (value === hasFill.value || value === 'indeterminate') {
            return;
        }
        toggleFill();
    },
});

const strokeWidthModel = computed({
    get() {
        return shape?.strokeWidth ?? 1;
    },
    set(value: number | number[] | undefined) {
        updateProperty('strokeWidth', sliderNumericValue(value));
    },
});

const opacityModel = computed({
    get() {
        return shape?.opacity ?? 1;
    },
    set(value: number | number[] | undefined) {
        updateProperty('opacity', sliderNumericValue(value));
    },
});
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
    min-width: 0;
}

.annotation-properties-checkbox :deep([data-slot="wrapper"]) {
    min-width: 0;
}

.annotation-properties-checkbox :deep([data-slot="label"]) {
    color: var(--ui-text-muted);
    font-size: 11px;
    font-weight: 400;
    line-height: 1.25;
}

.annotation-properties-range {
    flex: 1;
    min-width: 0;
}

.annotation-properties-range :deep(.annotation-properties-range-track) {
    height: 4px;
    border-radius: 2px;
    background: var(--ui-border);
}

.annotation-properties-range :deep(.annotation-properties-range-fill) {
    background: var(--ui-text);
}

.annotation-properties-range :deep(.annotation-properties-range-thumb) {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--app-sidebar-bg);
    background: var(--ui-text);
    box-shadow: none;
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
