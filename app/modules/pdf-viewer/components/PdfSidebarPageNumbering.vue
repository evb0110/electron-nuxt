<template>
    <div class="pdf-sidebar-pages-panel">
        <UCollapsible
            v-model:open="isExpanded"
            :default-open="false"
            :unmount-on-hide="false"
            class="pdf-sidebar-pages-collapsible"
        >
            <template #default="{ open }">
                <button
                    type="button"
                    class="pdf-sidebar-pages-disclosure"
                    :aria-expanded="open ? 'true' : 'false'"
                >
                    <span class="pdf-sidebar-pages-disclosure-main">
                        <UIcon
                            :name="open ? 'i-ph-caret-down' : 'i-ph-caret-right'"
                            class="pdf-sidebar-pages-disclosure-icon size-4"
                        />
                        <UIcon
                            name="i-ph-hash"
                            class="pdf-sidebar-pages-disclosure-type-icon size-3.5"
                        />
                        <span class="pdf-sidebar-pages-title">{{ t('pageNumbering.numberPages') }}</span>
                    </span>
                </button>
            </template>

            <template #content>
                <div class="pdf-sidebar-pages-editor flex flex-col">
                    <div class="flex flex-col gap-1.5">
                        <div class="pdf-sidebar-pages-field flex flex-col gap-1">
                            <span id="page-label-scope-label" class="pdf-sidebar-pages-label">{{ t('pageNumbering.applyTo') }}</span>
                            <div
                                class="pdf-sidebar-pages-scope-options"
                                role="radiogroup"
                                aria-labelledby="page-label-scope-label"
                            >
                                <label
                                    v-for="scopeOption in numberingScopeOptions"
                                    :key="scopeOption.value"
                                    class="pdf-sidebar-pages-scope-option"
                                    :class="{ 'pdf-sidebar-pages-scope-option-active': numberingScope === scopeOption.value }"
                                >
                                    <input
                                        v-model="numberingScope"
                                        class="pdf-sidebar-pages-scope-input"
                                        type="radio"
                                        name="page-label-scope"
                                        :value="scopeOption.value"
                                    >
                                    <span class="pdf-sidebar-pages-scope-label">{{ scopeOption.label }}</span>
                                </label>
                            </div>
                        </div>

                        <div
                            v-if="numberingScope === 'range'"
                            class="pdf-sidebar-pages-field flex flex-col gap-1"
                        >
                            <label class="pdf-sidebar-pages-label" for="page-label-range-input">{{ t('pageNumbering.pageRange') }}</label>
                            <input
                                id="page-label-range-input"
                                v-model="pageRangeInput"
                                class="pdf-sidebar-pages-input"
                                type="text"
                                inputmode="numeric"
                                :placeholder="t('pageNumbering.rangePlaceholder')"
                            >
                        </div>

                        <div class="pdf-sidebar-pages-field flex flex-col gap-1">
                            <label class="pdf-sidebar-pages-label" for="page-label-style-input">{{ t('pageNumbering.style') }}</label>
                            <select
                                id="page-label-style-input"
                                v-model="pageLabelStyle"
                                class="pdf-sidebar-pages-select"
                            >
                                <option
                                    v-for="styleOption in pageLabelStyleOptions"
                                    :key="styleOption.value"
                                    :value="styleOption.value"
                                >
                                    {{ styleOption.label }}
                                </option>
                            </select>
                        </div>

                        <div class="pdf-sidebar-pages-field flex flex-col gap-1">
                            <label class="pdf-sidebar-pages-label" for="page-label-prefix-input">{{ t('pageNumbering.prefix') }}</label>
                            <input
                                id="page-label-prefix-input"
                                v-model="pageLabelPrefix"
                                class="pdf-sidebar-pages-input"
                                type="text"
                                :placeholder="t('pageNumbering.prefixPlaceholder')"
                            >
                        </div>

                        <div class="pdf-sidebar-pages-field flex flex-col gap-1">
                            <label class="pdf-sidebar-pages-label" for="page-label-start-input">{{ t('pageNumbering.startAt') }}</label>
                            <input
                                id="page-label-start-input"
                                :value="pageLabelStartNumber"
                                class="pdf-sidebar-pages-input"
                                type="number"
                                min="1"
                                :disabled="pageLabelStyle.length === 0"
                                @input="handleStartNumberInput"
                            >
                        </div>
                    </div>

                    <div class="flex items-center gap-1.5">
                        <span class="pdf-sidebar-pages-selection-text">{{ targetSummary }}</span>
                        <UButton
                            size="xs"
                            variant="link"
                            color="neutral"
                            class="pdf-sidebar-pages-clear-button"
                            :disabled="totalPages <= 0"
                            @click="clearAll"
                        >
                            {{ t('pageNumbering.clear') }}
                        </UButton>
                    </div>

                    <p
                        v-if="rangeErrorMessage"
                        class="pdf-sidebar-pages-error"
                    >
                        {{ rangeErrorMessage }}
                    </p>

                    <UButton
                        size="xs"
                        variant="soft"
                        color="primary"
                        class="pdf-sidebar-pages-primary-button"
                        :ui="{ base: 'justify-center text-center whitespace-nowrap' }"
                        :disabled="applyTargetRange === null"
                        @click="applyToTargetRange"
                    >
                        <span class="pdf-sidebar-pages-button-label">{{ t('pageNumbering.applyNumbering') }}</span>
                    </UButton>
                </div>
            </template>
        </UCollapsible>
    </div>
</template>

<script setup lang="ts">

import { uniq } from 'es-toolkit/array';
import type {
    IPdfPageLabelRange,
    IPdfPageRange,
    TPageLabelStyle,
} from '@app/types/pdf';
import {
    buildWholeDocumentPageLabelRanges,
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
    formatPageRange,
    normalizePageLabelRanges,
    parsePageRangeInput,
} from '@app/utils/pdfPageLabels';
import { arePageNumberListsEqual } from '@app/utils/pdfPageSelection';

type TNumberingScope = 'all' | 'range' | 'selection';

interface IProps {
    totalPages: number;
    selectedPages: number[];
    pageLabels?: string[] | null | undefined;
    pageLabelRanges?: IPdfPageLabelRange[] | undefined;
}

const {
    pageLabelRanges = undefined,
    pageLabels = undefined,
    selectedPages,
    totalPages,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:selectedPages': [pages: number[]];
    'update:pageLabelRanges': [ranges: IPdfPageLabelRange[]];
    clear: [];
}>();

const { t } = useTypedI18n();

const isExpanded = ref(false);
const pendingSelectionSyncCount = ref(0);
const pendingRangeSyncCount = ref(0);
const pageRangeInput = ref('');
const numberingScope = ref<TNumberingScope>('all');
const pageLabelStyle = ref<'' | Exclude<TPageLabelStyle, null>>('D');
const pageLabelPrefix = ref('');
const pageLabelStartNumber = ref(1);

const numberingScopeOptions = computed<Array<{
    value: TNumberingScope;
    label: string;
}>>(() => [
    {
        value: 'all',
        label: t('pageNumbering.scopeAll', { count: totalPages }),
    },
    {
        value: 'range',
        label: t('pageNumbering.scopeRange'),
    },
    {
        value: 'selection',
        label: t('pageNumbering.scopeSelection'),
    },
]);

const pageLabelStyleOptions = computed<Array<{
    value: '' | Exclude<TPageLabelStyle, null>;
    label: string;
}>>(() => [
    {
        value: 'D',
        label: t('pageNumbering.decimal'), 
    },
    {
        value: 'r',
        label: t('pageNumbering.romanLower'), 
    },
    {
        value: 'R',
        label: t('pageNumbering.romanUpper'), 
    },
    {
        value: 'a',
        label: t('pageNumbering.lettersLower'), 
    },
    {
        value: 'A',
        label: t('pageNumbering.lettersUpper'), 
    },
    {
        value: '',
        label: t('pageNumbering.prefixOnly'), 
    },
]);

const normalizedPageLabelRanges = computed(() => normalizePageLabelRanges(
    pageLabelRanges ?? [],
    totalPages,
));

function buildEffectivePageLabels() {
    if (pageLabels && pageLabels.length === totalPages) {
        return pageLabels;
    }
    return buildPageLabelsFromRanges(totalPages, normalizedPageLabelRanges.value);
}

const manualRange = computed(() => parsePageRangeInput(pageRangeInput.value, totalPages));

function deriveContiguousSelectionRange(pages: number[]): IPdfPageRange | null {
    if (pages.length === 0) {
        return null;
    }

    const sorted = uniq(pages)
        .filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages)
        .sort((left, right) => left - right);

    if (sorted.length === 0) {
        return null;
    }

    const startPage = sorted[0] ?? 1;
    const endPage = sorted[sorted.length - 1] ?? startPage;

    if ((endPage - startPage + 1) !== sorted.length) {
        return null;
    }

    return {
        startPage,
        endPage, 
    };
}

const selectionRange = computed(() => deriveContiguousSelectionRange(selectedPages));

const allPagesRange = computed<IPdfPageRange | null>(() => {
    if (totalPages <= 0) {
        return null;
    }

    return {
        startPage: 1,
        endPage: totalPages,
    };
});

const applyTargetRange = computed(() => {
    if (numberingScope.value === 'all') {
        return allPagesRange.value;
    }

    if (numberingScope.value === 'range') {
        return pageRangeInput.value.trim().length > 0 ? manualRange.value : null;
    }

    return selectionRange.value;
});

const targetSummary = computed(() => {
    if (numberingScope.value === 'all') {
        if (totalPages <= 0) {
            return t('pageNumbering.targetNone');
        }
        return t('pageNumbering.targetAllPages', { count: totalPages });
    }

    if (numberingScope.value === 'range') {
        if (!pageRangeInput.value.trim()) {
            return t('pageNumbering.targetUnavailableRange');
        }
        if (manualRange.value === null) {
            return t('pageNumbering.targetUnavailableRange');
        }

        return t('pageNumbering.targetPages', {range: formatPageRange(manualRange.value)});
    }

    if (selectedPages.length === 0) {
        return t('pageNumbering.targetNone');
    }

    if (selectionRange.value === null) {
        return t('pageNumbering.targetUnavailableNonContiguous');
    }

    const rangeText = formatPageRange(selectionRange.value);
    return t('pageNumbering.targetSelectedPages', { range: rangeText });
});

const rangeErrorMessage = computed(() => {
    if (numberingScope.value !== 'range') {
        return '';
    }

    if (!pageRangeInput.value.trim()) {
        return '';
    }

    if (manualRange.value !== null) {
        return '';
    }

    return t('pageNumbering.rangeError');
});

function queueSelectionSyncSuppression() {
    pendingSelectionSyncCount.value += 1;
    void nextTick(() => {
        if (pendingSelectionSyncCount.value > 0) {
            pendingSelectionSyncCount.value -= 1;
        }
    });
}

function queueRangeSyncSuppression() {
    pendingRangeSyncCount.value += 1;
    void nextTick(() => {
        if (pendingRangeSyncCount.value > 0) {
            pendingRangeSyncCount.value -= 1;
        }
    });
}

function readEventValue(event: Event) {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
        return target.value;
    }
    return '';
}

function handleStartNumberInput(event: Event) {
    const parsed = Number.parseInt(readEventValue(event), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        pageLabelStartNumber.value = 1;
        return;
    }
    pageLabelStartNumber.value = parsed;
}

function buildRangePages(range: IPdfPageRange) {
    const pages: number[] = [];
    for (let page = range.startPage; page <= range.endPage; page += 1) {
        pages.push(page);
    }
    return pages;
}

function setSelectedPagesSilently(pages: number[]) {
    if (arePageNumberListsEqual(selectedPages, pages)) {
        return;
    }
    queueSelectionSyncSuppression();
    emit('update:selectedPages', pages);
}

function setPageRangeInputSilently(value: string) {
    if (pageRangeInput.value === value) {
        return;
    }
    queueRangeSyncSuppression();
    pageRangeInput.value = value;
}


function getConfiguredPageLabelStyle(): TPageLabelStyle {
    return pageLabelStyle.value === '' ? null : pageLabelStyle.value;
}

function getConfiguredPageLabelRange(startPage: number): IPdfPageLabelRange {
    return {
        startPage,
        style: getConfiguredPageLabelStyle(),
        prefix: pageLabelPrefix.value,
        startNumber: pageLabelStartNumber.value,
    };
}

function applyPageLabelsToWholeDocument() {
    emit('update:pageLabelRanges', buildWholeDocumentPageLabelRanges(totalPages, {
        style: getConfiguredPageLabelStyle(),
        prefix: pageLabelPrefix.value,
        startNumber: pageLabelStartNumber.value,
    }));
}

function applyPageLabelsToRange(range: IPdfPageRange) {
    if (totalPages <= 0) {
        return;
    }

    const nextLabels = [...buildEffectivePageLabels()];
    if (nextLabels.length !== totalPages) {
        return;
    }

    const segmentLabels = buildPageLabelsFromRanges(
        range.endPage - range.startPage + 1,
        [getConfiguredPageLabelRange(1)],
    );

    segmentLabels.forEach((label, index) => {
        nextLabels[range.startPage - 1 + index] = label;
    });

    const nextRanges = derivePageLabelRangesFromLabels(nextLabels, totalPages);
    emit('update:pageLabelRanges', nextRanges);
}

function applyToTargetRange() {
    if (applyTargetRange.value === null) {
        return;
    }

    const targetRange = applyTargetRange.value;
    if (numberingScope.value === 'all') {
        setSelectedPagesSilently([]);
        setPageRangeInputSilently('');
        applyPageLabelsToWholeDocument();
        return;
    }

    setSelectedPagesSilently(buildRangePages(targetRange));
    setPageRangeInputSilently(formatPageRange(targetRange));
    applyPageLabelsToRange(targetRange);
}

function clearAll() {
    numberingScope.value = 'all';
    setSelectedPagesSilently([]);
    setPageRangeInputSilently('');
    emit('clear');
}

watch(
    () => selectedPages,
    (pages) => {
        if (pendingSelectionSyncCount.value > 0) {
            pendingSelectionSyncCount.value -= 1;
            return;
        }

        if (pages.length === 0) {
            if (numberingScope.value === 'selection') {
                numberingScope.value = 'all';
            }
            setPageRangeInputSilently('');
            return;
        }

        numberingScope.value = 'selection';

        if (selectionRange.value === null) {
            setPageRangeInputSilently('');
            return;
        }

        const nextRangeText = formatPageRange(selectionRange.value);
        setPageRangeInputSilently(nextRangeText);
    },
    { deep: true },
);

watch(
    () => pageRangeInput.value,
    (inputValue) => {
        if (pendingRangeSyncCount.value > 0) {
            pendingRangeSyncCount.value -= 1;
            return;
        }

        if (!inputValue.trim()) {
            if (numberingScope.value === 'range') {
                numberingScope.value = selectionRange.value === null ? 'all' : 'selection';
            }
            setSelectedPagesSilently([]);
            return;
        }

        numberingScope.value = 'range';

        if (manualRange.value === null) {
            return;
        }

        const nextPages = buildRangePages(manualRange.value);
        setSelectedPagesSilently(nextPages);
    },
);

</script>

<style scoped>
.pdf-sidebar-pages-panel {
    flex-shrink: 0;
    border-top: 1px solid var(--ui-border);
    padding: 0.625rem 0.75rem;
    background: inherit;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.pdf-sidebar-pages-collapsible {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.pdf-sidebar-pages-disclosure {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    background: transparent;
    color: var(--ui-text);
    padding: 0.375rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
}

.pdf-sidebar-pages-disclosure-main {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
}

.pdf-sidebar-pages-disclosure:hover {
    background: var(--ui-bg-elevated);
}

.pdf-sidebar-pages-disclosure-icon {
    color: var(--ui-text-muted);
    flex-shrink: 0;
}

.pdf-sidebar-pages-disclosure-type-icon {
    color: var(--ui-text-muted);
    flex-shrink: 0;
}

.pdf-sidebar-pages-editor {
    gap: 0.625rem;
    padding-top: 0.375rem;
}

.pdf-sidebar-pages-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 700;
    color: inherit;
}

.pdf-sidebar-pages-field {
    min-width: 0;
}

.pdf-sidebar-pages-label {
    font-size: 0.675rem;
    color: var(--ui-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.pdf-sidebar-pages-scope-options {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}

.pdf-sidebar-pages-scope-option {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.25rem;
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
    padding: 0.25rem 0.375rem;
    font-size: 0.75rem;
    line-height: 1.2;
    cursor: pointer;
    min-width: 0;
}

.pdf-sidebar-pages-scope-option-active {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
    color: var(--ui-text-highlighted);
}

.pdf-sidebar-pages-scope-input {
    flex-shrink: 0;
}

.pdf-sidebar-pages-scope-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pdf-sidebar-pages-input,
.pdf-sidebar-pages-select {
    width: 100%;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
    border-radius: 0.25rem;
    font-size: 0.75rem;
    padding: 0.25rem 0.375rem;
    min-width: 0;
    max-width: 100%;
}

.pdf-sidebar-pages-select {
    text-overflow: ellipsis;
}

.pdf-sidebar-pages-input:disabled {
    opacity: 0.6;
}

.pdf-sidebar-pages-selection-text {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    line-height: 1.3;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.pdf-sidebar-pages-clear-button {
    flex-shrink: 0;
    font-size: 0.7rem;
    padding: 0;
}

.pdf-sidebar-pages-primary-button {
    width: 100%;
    justify-content: center;
}

.pdf-sidebar-pages-button-label {
    display: block;
    width: 100%;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.pdf-sidebar-pages-error {
    margin: 0;
    font-size: 0.7rem;
    color: var(--ui-error);
}
</style>
