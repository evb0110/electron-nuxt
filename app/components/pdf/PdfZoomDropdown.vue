<template>
    <div :class="['zoom-controls', `zoom-controls--compact-${effectiveCompactLevel}`]">
        <div v-if="showStepButtons" class="zoom-controls-item">
            <ToolbarButton
                icon="lucide:minus"
                :tooltip="t('zoom.zoomOut')"
                :shortcut="shortcutLabels.zoomOut"
                :disabled="disabled || normalizedEffectiveZoom <= ZOOM.MIN"
                grouped
                icon-class="size-[1.1rem]"
                @click="handleZoomOut"
            />
        </div>

        <div class="zoom-controls-item zoom-controls-item--display">
            <UPopover v-model:open="isOpen" mode="click" :disabled="disabled">
                <button
                    class="zoom-controls-display"
                    :disabled="disabled"
                >
                    <span class="zoom-controls-display-value">{{ zoomDisplay }}</span>
                </button>

                <template #content>
                    <div class="zoom-dropdown">
                        <div class="zoom-chip-grid">
                            <button
                                v-for="preset in zoomPresets"
                                :key="preset.value"
                                :class="['zoom-chip', { 'is-active': isPresetActive(preset.value) }]"
                                @click="handleSetZoom(preset.value)"
                            >
                                {{ preset.label }}
                            </button>
                            <div class="zoom-chip zoom-chip-custom">
                                <input
                                    ref="customInputRef"
                                    v-model="customZoomValue"
                                    class="zoom-chip-custom-input"
                                    type="text"
                                    inputmode="decimal"
                                    :aria-label="t('zoom.custom')"
                                    @keydown.enter.prevent="applyCustomZoom"
                                    @focus="($event.target as HTMLInputElement).select()"
                                />
                                <span class="zoom-chip-custom-suffix">%</span>
                            </div>
                        </div>

                        <div class="zoom-divider" />

                        <div class="zoom-toggle-group">
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isFitModeActive('width') }]"
                                @click="handleSetFitMode('width')"
                            >
                                <UIcon name="i-lucide-move-horizontal" class="zoom-toggle-icon" />
                                <span class="zoom-toggle-label">{{ t('zoom.fitWidth') }}</span>
                            </button>
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isFitModeActive('height') }]"
                                @click="handleSetFitMode('height')"
                            >
                                <UIcon name="i-lucide-move-vertical" class="zoom-toggle-icon" />
                                <span class="zoom-toggle-label">{{ t('zoom.fitHeight') }}</span>
                            </button>
                        </div>

                        <div class="zoom-divider" />

                        <div class="zoom-toggle-group">
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isViewModeActive('single') }]"
                                :title="t('zoom.singlePage')"
                                @click="handleSetViewMode('single')"
                            >
                                <UIcon name="i-lucide-file" class="zoom-toggle-icon" />
                                <span class="zoom-toggle-label">{{ t('zoom.singleShort') }}</span>
                            </button>
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isViewModeActive('facing') }]"
                                :title="t('zoom.facingPages')"
                                @click="handleSetViewMode('facing')"
                            >
                                <UIcon name="i-lucide-book-open" class="zoom-toggle-icon" />
                                <span class="zoom-toggle-label">{{ t('zoom.facingShort') }}</span>
                            </button>
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isViewModeActive('facing-first-single') }]"
                                :title="t('zoom.facingWithFirstSingle')"
                                @click="handleSetViewMode('facing-first-single')"
                            >
                                <span class="zoom-toggle-icon-badge">
                                    <UIcon name="i-lucide-book-open" class="size-4" />
                                    <span class="zoom-badge">1</span>
                                </span>
                                <span class="zoom-toggle-label">{{ t('zoom.facingFirstShort') }}</span>
                            </button>
                        </div>
                    </div>
                </template>
            </UPopover>
        </div>

        <div v-if="showStepButtons" class="zoom-controls-item">
            <ToolbarButton
                icon="lucide:plus"
                :tooltip="t('zoom.zoomIn')"
                :shortcut="shortcutLabels.zoomIn"
                :disabled="disabled || normalizedEffectiveZoom >= ZOOM.MAX"
                grouped
                icon-class="size-[1.1rem]"
                @click="handleZoomIn"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from '@contracts/shared';
import { ZOOM } from '@app/constants/pdf-layout';
import ToolbarButton from '@app/components/ToolbarButton.vue';

const { t } = useTypedI18n();

interface IProps {
    zoom: number;
    effectiveZoom: number;
    zoomMode: TZoomMode;
    fitMode: TFitMode;
    viewMode: TPdfViewMode;
    open: boolean;
    disabled?: boolean;
    compactLevel?: number;
}

const {
    zoom,
    effectiveZoom,
    zoomMode,
    viewMode,
    open,
    disabled = false,
    compactLevel = 0,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:zoom', level: number): void;
    (e: 'update:effectiveZoom', level: number): void;
    (e: 'update:zoomMode', mode: TZoomMode): void;
    (e: 'update:fitMode', mode: TFitMode): void;
    (e: 'update:viewMode', mode: TPdfViewMode): void;
    (e: 'update:open', value: boolean): void;
}>();

const isOpen = computed({
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const customZoomValue = ref(formatZoomValue(zoom));
const customInputRef = ref<HTMLInputElement | null>(null);

const effectiveCompactLevel = computed(() => {
    return Math.max(0, Math.min(compactLevel, 2));
});

const showStepButtons = computed(() => effectiveCompactLevel.value < 1);
const shortcutModifier = computed(() => (
    typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
        ? 'Cmd'
        : 'Ctrl'
));
const shortcutLabels = computed(() => ({
    zoomIn: `${shortcutModifier.value}+=`,
    zoomOut: `${shortcutModifier.value}+-`,
}));

function normalizeZoomLevel(value: number) {
    if (!Number.isFinite(value)) {
        return 1;
    }
    return Math.min(ZOOM.MAX, Math.max(ZOOM.MIN, value));
}

const normalizedZoom = computed(() => normalizeZoomLevel(zoom));
const normalizedEffectiveZoom = computed(() => {
    if (typeof effectiveZoom === 'number' && Number.isFinite(effectiveZoom)) {
        return normalizeZoomLevel(effectiveZoom);
    }
    return normalizedZoom.value;
});

function close() {
    isOpen.value = false;
}

watch(isOpen, (open) => {
    if (open) {
        void nextTick(() => {
            customInputRef.value?.focus();
            customInputRef.value?.select();
        });
    }
});

watch(
    () => normalizedEffectiveZoom.value,
    (value) => {
        customZoomValue.value = formatZoomValue(normalizeZoomLevel(value));
    },
    { immediate: true },
);

function formatZoomValue(value: number) {
    return Math.round(value * 100).toString();
}

const zoomDisplay = computed(() => `${Math.round(normalizedEffectiveZoom.value * 100)}%`);

const zoomPresets = ZOOM.PRESETS;

function handleZoomIn() {
    setCustomZoomFromDisplay(Math.min(normalizedEffectiveZoom.value + ZOOM.STEP, ZOOM.MAX));
}

function handleZoomOut() {
    setCustomZoomFromDisplay(Math.max(normalizedEffectiveZoom.value - ZOOM.STEP, ZOOM.MIN));
}

function isPresetActive(presetValue: number) {
    return Math.abs(normalizedEffectiveZoom.value - presetValue) < 0.01;
}

function isFitModeActive(mode: TFitMode) {
    const expectedZoomMode: TZoomMode = mode === 'height'
        ? 'fit-height'
        : 'fit-width';
    return zoomMode === expectedZoomMode;
}

function resolveBaselineScale() {
    if (!Number.isFinite(zoom) || Math.abs(zoom) < 0.0001) {
        return 1;
    }
    const baseline = normalizedEffectiveZoom.value / zoom;
    if (!Number.isFinite(baseline) || baseline <= 0) {
        return 1;
    }
    return baseline;
}

function setCustomZoomFromDisplay(displayZoom: number) {
    const nextDisplayZoom = normalizeZoomLevel(displayZoom);
    const baselineScale = resolveBaselineScale();
    const nextZoom = normalizeZoomLevel(nextDisplayZoom / baselineScale);
    emit('update:zoom', nextZoom);
    emit('update:effectiveZoom', nextDisplayZoom);
    emit('update:zoomMode', 'custom');
}

function handleSetZoom(level: number) {
    setCustomZoomFromDisplay(normalizeZoomLevel(level));
    close();
}

function handleSetFitMode(mode: TFitMode) {
    emit('update:fitMode', mode);
    emit('update:zoom', 1);
    emit('update:zoomMode', mode === 'height' ? 'fit-height' : 'fit-width');
    close();
}

function isViewModeActive(mode: TPdfViewMode) {
    return viewMode === mode;
}

function handleSetViewMode(mode: TPdfViewMode) {
    emit('update:viewMode', mode);
    close();
}

function applyCustomZoom() {
    const parsed = Number.parseFloat(customZoomValue.value);

    const minPercent = ZOOM.MIN * 100;
    const maxPercent = ZOOM.MAX * 100;
    if (Number.isFinite(parsed) && parsed >= minPercent && parsed <= maxPercent) {
        setCustomZoomFromDisplay(parsed / 100);
        customZoomValue.value = '';
        close();
    }
}
</script>

<style scoped>
.zoom-controls {
    --zoom-control-side-width: var(--toolbar-control-height, 2.25rem);
    --zoom-control-display-width: 6.5rem;

    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: 0.375rem;
    overflow: hidden;
}

.zoom-controls-item {
    display: flex;
    align-items: stretch;
    border-radius: 0;
}

.zoom-controls-item + .zoom-controls-item {
    border-left: 1px solid var(--app-toolbar-group-border);
}

.zoom-controls-item :deep(.toolbar-btn) {
    width: var(--zoom-control-side-width);
    min-width: var(--zoom-control-side-width);
    max-width: var(--zoom-control-side-width);
}

.zoom-controls-item--display {
    flex: 0 0 var(--zoom-control-display-width);
}

.zoom-controls-display {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    width: 100%;
    min-width: 100%;
    max-width: 100%;
    height: var(--toolbar-control-height, 2.25rem);
    background: transparent;
    border: none;
    border-radius: 0;
    cursor: pointer;
    color: var(--ui-text);
    transition: background-color 0.1s ease, box-shadow 0.1s ease;
}

.zoom-controls--compact-2 .zoom-controls-display {
    width: 100%;
    min-width: 100%;
    max-width: 100%;
}

.zoom-controls--compact-2 {
    --zoom-control-display-width: 5.5rem;
}

.zoom-controls-display:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.zoom-controls-display:focus {
    outline: none;
}

.zoom-controls-display:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.zoom-controls-display:hover:not(:disabled) {
    background-color: var(--app-toolbar-control-hover-bg);
}

.zoom-controls-display-value {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.875rem;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--ui-text);
}

.zoom-dropdown {
    padding: 0.375rem;
    width: 15rem;
}

.zoom-divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.375rem 0;
}

.zoom-chip-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.25rem;
}

.zoom-chip {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 1.75rem;
    padding: 0;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    background: transparent;
    color: var(--ui-text);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
}

.zoom-chip:hover {
    background-color: var(--ui-bg-elevated);
}

.zoom-chip.is-active {
    border-color: var(--ui-text);
    font-weight: 600;
}

.zoom-chip-custom {
    position: relative;
    cursor: text;
    background-color: var(--ui-bg-muted);
}

.zoom-chip-custom:hover {
    background-color: var(--ui-bg-muted);
}

.zoom-chip-custom:focus-within {
    border-color: var(--ui-primary);
    background-color: var(--ui-bg);
}

.zoom-chip-custom-input {
    width: 100%;
    height: 100%;
    background: transparent;
    border: none;
    text-align: center;
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    color: inherit;
    padding: 0 0.875rem 0 0;
    outline: none;
}

.zoom-chip-custom-suffix {
    position: absolute;
    right: 0.25rem;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.6875rem;
    color: var(--ui-text-dimmed);
    pointer-events: none;
}

.zoom-toggle-group {
    display: flex;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    overflow: hidden;
}

.zoom-toggle-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.375rem 0.25rem;
    border: none;
    background: transparent;
    color: var(--ui-text-muted);
    font-size: 0.8125rem;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
}

.zoom-toggle-btn + .zoom-toggle-btn {
    border-left: 1px solid var(--ui-border);
}

.zoom-toggle-btn:hover {
    background-color: var(--ui-bg-elevated);
    color: var(--ui-text);
}

.zoom-toggle-btn.is-active {
    background-color: var(--ui-bg-elevated);
    color: var(--ui-text);
    font-weight: 600;
}

.zoom-toggle-icon {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
}

.zoom-toggle-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.zoom-toggle-icon-badge {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
}

.zoom-badge {
    position: absolute;
    top: -0.125rem;
    right: -0.3125rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0.75rem;
    height: 0.75rem;
    padding: 0 0.125rem;
    border-radius: 999px;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 0.5625rem;
    line-height: 1;
    font-weight: 700;
}

.zoom-toggle-btn.is-active .zoom-badge {
    color: var(--ui-text);
}

</style>
