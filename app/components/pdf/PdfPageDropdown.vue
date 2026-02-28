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
                <span class="page-controls-current">{{ pageIndicator }}</span>
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
                <input
                    ref="pageInputRef"
                    v-model="pageInputValue"
                    class="page-controls-inline-input"
                    @keydown.enter.prevent="commitPageInput"
                    @keydown.escape.prevent="cancelEditing"
                    @blur="commitPageInput"
                />
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
import {
    findPageByPageLabelInput,
    formatPageIndicator,
} from '@app/utils/pdf-page-labels';

const { t } = useTypedI18n();

interface IProps {
    modelValue: number;
    totalPages: number;
    open: boolean;
    pageLabels?: string[] | null;
    disabled?: boolean;
    compactLevel?: number;
}

const {
    modelValue: currentPage,
    totalPages,
    open,
    pageLabels = null,
    disabled = false,
    compactLevel = 0,
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

const pageIndicator = computed(() => {
    if (!hasPages.value) {
        return '-';
    }
    return formatPageIndicator(currentPage, effectivePageLabels.value);
});

const pageDisplayWidthCh = computed(() => (showTotalInDisplay.value ? 9 : 5));

const pageDisplayStyle = computed(() => ({'--page-display-width-ch': `${pageDisplayWidthCh.value}ch`}));

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
        const newPage = currentPage - 1;
        emit('update:modelValue', newPage);
        emit('goToPage', newPage);
    }
}

function goToNext() {
    if (currentPage < totalPages) {
        const newPage = currentPage + 1;
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
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0 0.5rem;
    width: var(--page-display-width-ch);
    min-width: var(--page-display-width-ch);
    height: var(--toolbar-control-height, 2.25rem);
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
    font-variant-numeric: tabular-nums;
    color: var(--ui-text);
    white-space: nowrap;
}

.page-controls-current {
    text-align: right;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

.page-controls-slash {
    text-align: center;
    padding: 0 0.15rem;
}

.page-controls-slash.is-hidden,
.page-controls-total.is-hidden {
    visibility: hidden;
}

.page-controls-total {
    text-align: left;
}

.page-controls-inline-input {
    font-family: inherit;
    background: transparent;
    border: none;
    outline: none;
    text-align: right;
    padding: 0;
    min-width: 1ch;
}
</style>
