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
                @update:model-value="emit('update:zoom-preset', $event as string | { value: string })"
            />
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.defaultViewMode') }}</label>
            <USelectMenu
                :model-value="settings.defaultViewMode"
                :items="viewModeItems"
                value-key="value"
                :search-input="false"
                @update:model-value="emit('update:view-mode', $event as string | { value: string })"
            />
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.defaultScrollMode') }}</label>
            <USelectMenu
                :model-value="settings.defaultContinuousScroll"
                :items="scrollModeItems"
                value-key="value"
                :search-input="false"
                @update:model-value="emit('update:scroll-mode', $event as boolean | { value: boolean })"
            />
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.defaultAnnotationColor') }}</label>
            <div class="flex gap-2">
                <button
                    v-for="swatch in annotationColorSwatches"
                    :key="swatch"
                    type="button"
                    class="settings-swatch"
                    :class="{ 'is-active': settings.defaultAnnotationColor === swatch }"
                    :style="{ '--swatch-color': swatch }"
                    :aria-label="t('settings.annotationColorLabel', { color: swatch })"
                    @click="emit('update:annotation-color', swatch)"
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
    border: 2px solid transparent;
    background: var(--swatch-color);
    cursor: pointer;
    transition: transform $ease-quick, box-shadow $ease-quick;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-bg-inverted) 12%, transparent);
}

.settings-swatch:hover {
    transform: scale(1.15);
}

.settings-swatch.is-active {
    box-shadow:
        0 0 0 2px var(--ui-bg),
        0 0 0 3.5px var(--ui-primary),
        inset 0 0 0 1px color-mix(in srgb, var(--ui-bg-inverted) 12%, transparent);
}
</style>
