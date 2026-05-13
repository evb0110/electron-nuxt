<template>
    <fieldset class="settings-group flex flex-col gap-2.5">
        <legend class="settings-legend">{{ t('settings.viewerDefaults') }}</legend>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.defaultZoom') }}</label>
            <USelectMenu
                :model-value="settings.defaultZoomPreset"
                :items="zoomPresetItems"
                value-key="value"
                :search-input="false"
                @update:model-value="updateZoomPreset"
            />
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.defaultViewMode') }}</label>
            <USelectMenu
                :model-value="settings.defaultViewMode"
                :items="viewModeItems"
                value-key="value"
                :search-input="false"
                @update:model-value="updateViewMode"
            />
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.defaultScrollMode') }}</label>
            <USelectMenu
                :model-value="settings.defaultContinuousScroll"
                :items="scrollModeItems"
                value-key="value"
                :search-input="false"
                @update:model-value="updateScrollMode"
            />
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.defaultAnnotationColor') }}</label>
            <div class="settings-swatch-track">
                <button
                    v-for="swatch in annotationColorSwatches"
                    :key="swatch"
                    type="button"
                    class="settings-swatch"
                    :class="{ 'is-active': settings.defaultAnnotationColor === swatch }"
                    :style="{ '--swatch-color': swatch }"
                    :aria-label="t('settings.annotationColorLabel', { color: swatch })"
                    @click="updateAnnotationColor(swatch)"
                />
            </div>
        </div>
    </fieldset>
</template>

<script setup lang="ts">
import type {
    ISettingsData,
    TDefaultZoomPreset,
    TPdfViewMode,
} from '@contracts/shared';

interface ISelectItem<T> {
    value: T;
    label: string;
}

defineProps<{
    settings: ISettingsData;
    zoomPresetItems: Array<ISelectItem<TDefaultZoomPreset>>;
    viewModeItems: Array<ISelectItem<TPdfViewMode>>;
    scrollModeItems: Array<ISelectItem<boolean>>;
    annotationColorSwatches: readonly string[];
}>();

const emit = defineEmits<{
    'update:zoom-preset': [value: string | { value: string }];
    'update:view-mode': [value: string | { value: string }];
    'update:scroll-mode': [value: boolean | { value: boolean }];
    'update:annotation-color': [value: string];
}>();

const { t } = useTypedI18n();

function updateZoomPreset(value: string | { value: string }) {
    emit('update:zoom-preset', value);
}

function updateViewMode(value: string | { value: string }) {
    emit('update:view-mode', value);
}

function updateScrollMode(value: boolean | { value: boolean }) {
    emit('update:scroll-mode', value);
}

function updateAnnotationColor(value: string) {
    emit('update:annotation-color', value);
}
</script>

<style lang="scss" scoped>
.settings-group {
    border: none;
    padding: 0;
    margin: 0;
}

.settings-legend {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--ui-text-dimmed);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0;
    margin-bottom: 0.125rem;
}

.settings-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--ui-text);
}

.settings-swatch {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    border: 1px solid transparent;
    background: var(--swatch-color);
    cursor: pointer;
    transition: transform $ease-quick, border-color $ease-quick;
}

.settings-swatch:hover {
    transform: scale(1.15);
}

.settings-swatch.is-active {
    border-color: var(--app-toolbar-control-active-border);
}

.settings-swatch.is-active:hover {
    border-color: var(--app-toolbar-control-active-hover-border);
}

.settings-swatch-track {
    display: inline-flex;
    align-self: flex-start;
    gap: 0.125rem;
    padding: 0.1875rem;
    border-radius: calc(var(--ui-radius) * 1.5);
    background: var(--ui-bg-muted);
}
</style>
