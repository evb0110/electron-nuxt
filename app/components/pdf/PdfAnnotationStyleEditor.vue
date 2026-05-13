<template>
    <div class="annotation-style-editor flex flex-col gap-2" :class="{ 'is-idle': !hasStyleControls }">
        <template v-if="hasStyleControls">
            <div class="swatch-row">
                <AppTooltip
                    v-for="swatch in displayColorSwatches"
                    :key="swatch"
                    :text="swatch"
                    :delay-duration="600"
                >
                    <button
                        type="button"
                        class="swatch"
                        :class="{ 'is-active': swatch === activeColorSwatch }"
                        :style="{ backgroundColor: swatch }"
                        :aria-label="swatch"
                        :aria-pressed="swatch === activeColorSwatch"
                        @click="handleColorInput(swatch)"
                    />
                </AppTooltip>
            </div>

            <div v-if="activeWidthControl" class="style-row style-row-width flex flex-col">
                <label class="style-label" for="annotation-width-input">
                    {{ activeWidthControl.label }} {{ activeWidthValue }}
                </label>
                <div class="style-width-control">
                    <button
                        type="button"
                        class="style-step-button"
                        :aria-label="t('annotations.decreaseWidth')"
                        @click="nudgeWidth(-activeWidthControl.step)"
                    >
                        <UIcon name="i-ph-minus" class="style-step-icon" />
                    </button>
                    <input
                        id="annotation-width-input"
                        class="style-range"
                        type="range"
                        :min="activeWidthControl.min"
                        :max="activeWidthControl.max"
                        :step="activeWidthControl.step"
                        :value="activeWidthValue"
                        @input="handleWidthInputEvent"
                    />
                    <button
                        type="button"
                        class="style-step-button"
                        :aria-label="t('annotations.increaseWidth')"
                        @click="nudgeWidth(activeWidthControl.step)"
                    >
                        <UIcon name="i-ph-plus" class="style-step-icon" />
                    </button>
                </div>
            </div>

            <div v-if="tool === 'draw'" class="draw-style-row flex flex-col">
                <span class="style-label">{{ t('annotations.penType') }}</span>
                <div class="draw-style-list">
                    <button
                        v-for="preset in drawStylePresets"
                        :key="preset.id"
                        type="button"
                        class="draw-style-button"
                        :class="{ 'is-active': activeDrawStyle === preset.id }"
                        @click="applyDrawStyle(preset.id)"
                    >
                        {{ preset.label }}
                    </button>
                </div>
            </div>
        </template>

        <div v-else class="annotation-style-editor-idle" role="status" aria-live="polite">
            <UIcon name="i-ph-sliders-horizontal" class="annotation-style-editor-idle-icon" />
            <span class="annotation-style-editor-idle-label">{{ t('annotations.styleDescription') }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdf-colors';
import { ANNOTATION_PROPERTY_RANGES } from '@app/constants/annotation-defaults';
import {
    isAuthoringAnnotationTool,
    isShapeTool,
} from '@app/composables/pdf/annotations/annotationRules';

type TDrawStyle = 'pen' | 'pencil' | 'marker';

interface IWidthControl {
    key: 'inkThickness' | 'highlightThickness' | 'shapeStrokeWidth' | 'textSize';
    min: number;
    max: number;
    step: number;
    label: string;
}

interface IDrawStylePreset {
    id: TDrawStyle;
    label: string;
    thickness: number;
    opacity: number;
}

interface IProps {
    tool: TAnnotationTool;
    settings: IAnnotationSettings;
}

const { t } = useTypedI18n();

const {
    settings,
    tool,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
    (e: 'update-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }): void;
}>();

const colorSwatches = ANNOTATION_COLOR_SWATCHES;
const hasStyleControls = computed(() => isAuthoringAnnotationTool(tool));

const drawStylePresets = computed<IDrawStylePreset[]>(() => [
    {
        id: 'pen',
        label: t('annotations.pen'),
        thickness: 2,
        opacity: 0.95,
    },
    {
        id: 'pencil',
        label: t('annotations.pencil'),
        thickness: 1,
        opacity: 0.55,
    },
    {
        id: 'marker',
        label: t('annotations.marker'),
        thickness: 6,
        opacity: 0.42,
    },
]);

function updateSetting<K extends keyof IAnnotationSettings>(key: K, value: IAnnotationSettings[K]) {
    emit('update-setting', {
        key,
        value,
    });
}

const activeWidthControl = computed<IWidthControl | null>(() => {
    if (tool === 'draw') {
        return {
            key: 'inkThickness',
            ...ANNOTATION_PROPERTY_RANGES.inkThickness,
            label: t('annotations.drawThickness'),
        };
    }

    if (tool === 'highlight') {
        return {
            key: 'highlightThickness',
            ...ANNOTATION_PROPERTY_RANGES.highlightThickness,
            label: t('annotations.thickness'),
        };
    }

    if (isShapeTool(tool)) {
        return {
            key: 'shapeStrokeWidth',
            ...ANNOTATION_PROPERTY_RANGES.shapeStrokeWidth,
            label: t('annotations.stroke'),
        };
    }

    if (tool === 'text') {
        return {
            key: 'textSize',
            ...ANNOTATION_PROPERTY_RANGES.textSize,
            label: t('annotations.textSize'),
        };
    }

    return null;
});

const activeWidthValue = computed(() => {
    if (!activeWidthControl.value) {
        return 0;
    }
    return settings[activeWidthControl.value.key];
});

const activeColorSwatch = computed(() => {
    if (tool === 'draw') {
        return settings.inkColor;
    }

    if (tool === 'underline') {
        return settings.underlineColor;
    }

    if (tool === 'text') {
        return settings.textColor;
    }

    if (tool === 'strikethrough') {
        return settings.strikethroughColor;
    }

    if (isShapeTool(tool)) {
        return settings.shapeColor;
    }

    return settings.highlightColor;
});

function normalizeColorValue(color: string | null | undefined) {
    return color?.trim().toLowerCase() ?? '';
}

const displayColorSwatches = computed(() => {
    const active = activeColorSwatch.value;
    if (!active) {
        return colorSwatches;
    }

    const normalizedActive = normalizeColorValue(active);
    const hasMatchingPreset = colorSwatches.some(swatch => normalizeColorValue(swatch) === normalizedActive);
    return hasMatchingPreset ? colorSwatches : [
        active,
        ...colorSwatches,
    ];
});

const activeDrawStyle = computed<TDrawStyle>(() => {
    const thickness = settings.inkThickness;
    const opacity = settings.inkOpacity;

    if (thickness >= 5 || opacity <= 0.45) {
        return 'marker';
    }

    if (thickness <= 1.5 || opacity < 0.75) {
        return 'pencil';
    }

    return 'pen';
});

function handleColorInput(color: string) {
    if (tool === 'draw') {
        updateSetting('inkColor', color);
        return;
    }

    if (tool === 'underline') {
        updateSetting('underlineColor', color);
        return;
    }

    if (tool === 'text') {
        updateSetting('textColor', color);
        return;
    }

    if (tool === 'strikethrough') {
        updateSetting('strikethroughColor', color);
        return;
    }

    if (isShapeTool(tool)) {
        updateSetting('shapeColor', color);
        return;
    }

    updateSetting('highlightColor', color);
}

function handleWidthInput(width: number) {
    const control = activeWidthControl.value;
    if (!control) {
        return;
    }

    updateSetting(control.key, width);
}

function handleWidthInputEvent(event: Event) {
    if (!(event.target instanceof HTMLInputElement)) {
        return;
    }
    handleWidthInput(Number(event.target.value));
}

function nudgeWidth(delta: number) {
    const control = activeWidthControl.value;
    if (!control) {
        return;
    }

    const next = Math.max(
        control.min,
        Math.min(control.max, activeWidthValue.value + delta),
    );
    updateSetting(control.key, next);
}

function applyDrawStyle(style: TDrawStyle) {
    const preset = drawStylePresets.value.find(item => item.id === style);
    if (!preset) {
        return;
    }

    emit('set-tool', 'draw');
    updateSetting('inkThickness', preset.thickness);
    updateSetting('inkOpacity', preset.opacity);
}
</script>

<style scoped>
.annotation-style-editor {
    min-height: 9rem;
}

.annotation-style-editor.is-idle {
    justify-content: center;
}

.annotation-style-editor-idle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--ui-text-muted);
}

.annotation-style-editor-idle-icon {
    font-size: 0.9rem;
}

.annotation-style-editor-idle-label {
    font-size: 0.78rem;
    line-height: 1.25;
}

.style-row {
    gap: 0.35rem;
}

.style-label {
    font-size: 0.8rem;
    color: var(--ui-text-muted);
}

.swatch-row {
    display: grid;
    grid-template-columns: repeat(9, minmax(0, 1fr));
    gap: 0.25rem;
}

.swatch {
    border: 1px solid var(--app-pdf-color-swatch-border);
    border-radius: 0.3rem;
    height: 1.1rem;
    cursor: pointer;
}

.swatch.is-active {
    border-color: var(--app-sidebar-bg);
    box-shadow:
        0 0 0 1px var(--app-sidebar-bg),
        0 0 0 3px var(--ui-text);
}

.style-range {
    width: 100%;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: var(--ui-border);
    outline: none;
    cursor: pointer;
}

.style-range::-webkit-slider-thumb {
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--ui-text);
    border: 2px solid var(--app-sidebar-bg);
    cursor: pointer;
}

.style-width-control {
    display: flex;
    align-items: center;
    gap: 0.45rem;
}

.style-step-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--ui-border);
    border-radius: 0.4rem;
    background: var(--ui-bg);
    color: var(--ui-text);
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    cursor: pointer;
}

.style-step-icon {
    width: 0.95rem;
    height: 0.95rem;
}

.style-step-button:hover {
    background: var(--app-sidebar-control-hover-bg);
    border-color: var(--app-control-active-hover-border);
}

.draw-style-row {
    gap: 0.35rem;
}

.draw-style-list {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.35rem;
}

.draw-style-button {
    border: 1px solid transparent;
    border-radius: 0.45rem;
    background: transparent;
    color: var(--ui-text-muted);
    min-height: 1.9rem;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
}

.draw-style-button.is-active {
    border-color: var(--app-control-active-border);
    color: var(--ui-text);
    background: var(--app-control-active-bg);
}

.draw-style-button:hover {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

@media (width <= 860px) {
    .swatch-row {
        grid-template-columns: repeat(6, minmax(0, 1fr));
    }
}
</style>
