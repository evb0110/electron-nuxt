<template>
    <div ref="pageControlsRef" :class="['page-controls', `page-controls--compact-${effectiveCompactLevel}`]">
        <div v-if="showEdgeButtons" class="page-controls-item">
            <ToolbarButton
                icon="lucide:chevrons-left"
                :tooltip="t('pageDropdown.firstPage')"
                :disabled="disabled || totalPages === 0 || currentPage <= 1"
                grouped
                icon-class="size-[1.1rem]"
                @click="goToFirst"
            />
        </div>
        <div v-if="showStepButtons" class="page-controls-item">
            <ToolbarButton
                icon="lucide:chevron-left"
                :tooltip="t('pageDropdown.previousPage')"
                :disabled="disabled || totalPages === 0 || currentPage <= 1"
                grouped
                icon-class="size-[1.1rem]"
                @click="goToPrevious"
            />
        </div>

        <div class="page-controls-item">
            <button
                v-if="!isEditing"
                class="page-controls-display"
                :disabled="disabled || totalPages === 0"
                :style="pageDisplayStyle"
                @click="startEditing"
            >
                <span class="page-controls-current">
                    <span class="page-controls-current-primary">{{ pageIndicatorParts.primary }}</span>
                    <span
                        v-if="pageIndicatorParts.secondary"
                        class="page-controls-current-secondary"
                    >{{ pageIndicatorParts.secondary }}</span>
                </span>
                <span
                    v-if="showTotalInDisplay"
                    :class="['page-controls-slash', { 'is-hidden': !hasPages }]"
                >/</span>
                <span
                    v-if="showTotalInDisplay"
                    :class="['page-controls-total', { 'is-hidden': !hasPages }]"
                >{{ totalPages }}</span>
            </button>
            <div v-else class="page-controls-display is-editing" :style="pageDisplayStyle">
                <span class="page-controls-current">
                    <input
                        ref="pageInputRef"
                        v-model="pageInputValue"
                        class="page-controls-inline-input"
                        @keydown.enter.prevent="commitPageInput"
                        @keydown.escape.prevent="cancelEditing"
                        @blur="commitPageInput"
                    />
                    <span
                        v-if="pageIndicatorParts.secondary"
                        class="page-controls-current-secondary"
                    >{{ pageIndicatorParts.secondary }}</span>
                </span>
                <span
                    v-if="showTotalInDisplay"
                    :class="['page-controls-slash', { 'is-hidden': !hasPages }]"
                >/</span>
                <span
                    v-if="showTotalInDisplay"
                    :class="['page-controls-total', { 'is-hidden': !hasPages }]"
                >{{ totalPages }}</span>
            </div>
        </div>

        <div v-if="showStepButtons" class="page-controls-item">
            <ToolbarButton
                icon="lucide:chevron-right"
                :tooltip="t('pageDropdown.nextPage')"
                :disabled="disabled || totalPages === 0 || currentPage >= totalPages"
                grouped
                icon-class="size-[1.1rem]"
                @click="goToNext"
            />
        </div>
        <div v-if="showEdgeButtons" class="page-controls-item">
            <ToolbarButton
                icon="lucide:chevrons-right"
                :tooltip="t('pageDropdown.lastPage')"
                :disabled="disabled || totalPages === 0 || currentPage >= totalPages"
                grouped
                icon-class="size-[1.1rem]"
                @click="goToLast"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { onClickOutside } from '@vueuse/core';
import type { TPdfViewMode } from '@contracts/shared';
import ToolbarButton from '@app/components/ToolbarButton.vue';
import {
    findPageByPageLabelInput,
    getPageIndicatorLayoutMetrics,
} from '@app/utils/pdf-page-labels';
import { stepBySpread } from '@app/utils/pdf-view-mode';

const { t } = useTypedI18n();

interface IProps {
    modelValue: number;
    totalPages: number;
    open: boolean;
    pageLabels?: string[] | null;
    disabled?: boolean;
    compactLevel?: number;
    viewMode?: TPdfViewMode;
}

const {
    modelValue: currentPage,
    totalPages,
    open,
    pageLabels = null,
    disabled = false,
    compactLevel = 0,
    viewMode = 'single',
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:modelValue', page: number): void;
    (e: 'update:open', value: boolean): void;
    (e: 'goToPage', page: number): void;
}>();

const isEditing = computed({
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const pageInputValue = ref(currentPage.toString());
const pageInputRef = ref<HTMLInputElement | null>(null);
const pageControlsRef = ref<HTMLElement | null>(null);

const effectiveCompactLevel = computed(() => {
    return Math.max(0, Math.min(compactLevel, 2));
});

const showEdgeButtons = computed(() => effectiveCompactLevel.value < 1);
const showStepButtons = computed(() => effectiveCompactLevel.value < 3);
const showTotalInDisplay = computed(() => effectiveCompactLevel.value < 2);
const hasPages = computed(() => totalPages > 0);

const effectivePageLabels = computed(() => {
    if (pageLabels && pageLabels.length === totalPages) {
        return pageLabels;
    }

    return Array.from({ length: totalPages }, (_, index) => String(index + 1));
});

function getCurrentInputLabel() {
    const label = effectivePageLabels.value[currentPage - 1] ?? '';
    return label.trim() || currentPage.toString();
}

watch(
    () => currentPage,
    () => {
        pageInputValue.value = getCurrentInputLabel();
    },
);

const pageIndicatorParts = computed(() => {
    if (!hasPages.value) {
        return {
            primary: '-',
            secondary: '',
        };
    }

    const logical = effectivePageLabels.value[currentPage - 1]?.trim() ?? '';
    if (!logical || logical === String(currentPage)) {
        return {
            primary: String(currentPage),
            secondary: '',
        };
    }

    return {
        primary: logical,
        secondary: `(${currentPage})`,
    };
});

const pageLayoutMetrics = computed(() => getPageIndicatorLayoutMetrics(
    totalPages,
    effectivePageLabels.value,
    showTotalInDisplay.value,
    { compactPhysicalPage: true },
));

const pageDisplayStyle = computed(() => ({
    '--page-current-width-ch': `${pageLayoutMetrics.value.currentWidthCh}ch`,
    '--page-total-width-ch': `${pageLayoutMetrics.value.totalWidthCh}ch`,
    '--page-separator-width-ch': `${pageLayoutMetrics.value.separatorWidthCh}ch`,
    '--page-display-width-ch': `${pageLayoutMetrics.value.displayWidthCh}ch`,
}));

function startEditing() {
    if (disabled || totalPages === 0) {
        return;
    }
    isEditing.value = true;
    pageInputValue.value = getCurrentInputLabel();
    void nextTick(() => {
        pageInputRef.value?.focus();
        pageInputRef.value?.select();
    });
}

function cancelEditing() {
    isEditing.value = false;
    pageInputValue.value = getCurrentInputLabel();
}

function goToFirst() {
    emit('update:modelValue', 1);
    emit('goToPage', 1);
    isEditing.value = false;
}

function goToPrevious() {
    if (currentPage > 1) {
        const newPage = stepBySpread(currentPage, viewMode, totalPages, -1);
        if (newPage === currentPage) {
            return;
        }
        emit('update:modelValue', newPage);
        emit('goToPage', newPage);
    }
}

function goToNext() {
    if (currentPage < totalPages) {
        const newPage = stepBySpread(currentPage, viewMode, totalPages, 1);
        if (newPage === currentPage) {
            return;
        }
        emit('update:modelValue', newPage);
        emit('goToPage', newPage);
    }
}

function goToLast() {
    emit('update:modelValue', totalPages);
    emit('goToPage', totalPages);
    isEditing.value = false;
}

function commitPageInput() {
    if (!isEditing.value) {
        return;
    }
    const page = findPageByPageLabelInput(pageInputValue.value, totalPages, effectivePageLabels.value);
    if (page !== null) {
        emit('update:modelValue', page);
        emit('goToPage', page);
    }
    isEditing.value = false;
}

onClickOutside(pageControlsRef, () => {
    const activeElement = document.activeElement as HTMLElement | null;
    if (activeElement?.closest('.page-controls')) {
        activeElement.blur();
    }
}, { capture: true });
</script>

<style scoped>
.page-controls {
    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: 0.375rem;
    overflow: hidden;
}

.page-controls-item {
    display: flex;
    border-radius: 0;
}

.page-controls-item + .page-controls-item {
    border-left: 1px solid var(--app-toolbar-group-border);
}

.page-controls-display {
    display: grid;
    grid-template-columns:
        var(--page-current-width-ch)
        var(--page-separator-width-ch)
        var(--page-total-width-ch);
    align-items: center;
    padding: 0 0.5rem;
    width: var(--page-display-width-ch);
    min-width: var(--page-display-width-ch);
    height: var(--toolbar-control-height, 2.25rem);
    font-family: var(--app-font-mono);
    background: transparent;
    border: none;
    border-radius: 0;
    cursor: pointer;
    box-sizing: border-box;
    transition: background-color 0.1s ease, box-shadow 0.1s ease;
}

.page-controls-display:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.page-controls-display:focus {
    outline: none;
}

.page-controls-display:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.page-controls-display:not(.is-editing):hover:not(:disabled) {
    background-color: var(--app-toolbar-control-hover-bg);
}

.page-controls-current,
.page-controls-total,
.page-controls-slash,
.page-controls-inline-input {
    font-size: 0.875rem;
    font-family: var(--app-font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--ui-text);
    white-space: nowrap;
}

.page-controls-current {
    display: inline-flex;
    align-items: baseline;
    justify-content: flex-end;
    gap: 0;
    text-align: right;
    min-width: var(--page-current-width-ch);
}

.page-controls-current-primary {
    color: var(--ui-text);
}

.page-controls-current-secondary,
.page-controls-slash {
    color: var(--ui-text-dimmed);
    text-align: center;
}

.page-controls-slash.is-hidden,
.page-controls-total.is-hidden {
    visibility: hidden;
}

.page-controls-total {
    color: var(--ui-text-dimmed);
    text-align: left;
    min-width: var(--page-total-width-ch);
}

.page-controls-inline-input {
    font-family: inherit;
    background: transparent;
    border: none;
    outline: none;
    flex: 1 1 auto;
    text-align: right;
    padding: 0;
    min-width: 0;
    width: auto;
}
</style>
