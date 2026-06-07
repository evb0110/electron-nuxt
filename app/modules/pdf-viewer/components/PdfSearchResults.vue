<template>
    <div class="pdf-search-results flex flex-col">
        <PdfPanelEmptyState
            v-if="!trimmedQuery"
            icon="i-ph-magnifying-glass"
            :title="t('searchResults.enterSearchTerm')"
            :description="t('searchResults.enterSearchHint')"
        />
        <PdfPanelEmptyState
            v-else-if="isQueryTooShort"
            icon="i-ph-text-t"
            :title="t('searchResults.typeMinChars', { count: minQueryLength })"
            :description="t('searchResults.enterSearchHint')"
        />
        <PdfPanelEmptyState
            v-else-if="!isSearching && searchError"
            icon="i-ph-warning"
            :title="t('searchResults.unavailable')"
            :description="searchError"
        />
        <PdfPanelEmptyState
            v-else-if="!isSearching && results.length === 0"
            icon="i-ph-magnifying-glass"
            :title="t('searchResults.noResults')"
            :description="t('searchResults.noResultsHint')"
        />
        <div
            v-else-if="isSearching || results.length > 0"
            class="pdf-search-results-list-shell flex flex-1 min-h-0 flex-col"
        >
            <div class="pdf-search-results-header">
                <span class="pdf-search-results-header-summary">
                    {{ t('searchResults.resultCount', { count: results.length }) }} {{ t('searchResults.forQuery', { query: trimmedQuery }) }}
                </span>
                <UIcon
                    v-if="isSearching"
                    name="i-ph-circle-notch"
                    class="pdf-search-results-spinner pdf-search-results-header-spinner size-4"
                    aria-live="polite"
                    :aria-label="t('searchResults.searching')"
                />
                <span
                    v-if="isSearching && progressText"
                    class="pdf-search-results-header-progress"
                >
                    {{ progressText }}
                </span>
                <div
                    v-if="!isSearching && isTruncated"
                    class="pdf-search-results-truncated"
                >
                    {{ t('searchResults.showingFirst', { count: results.length }) }}
                </div>
            </div>
            <div class="pdf-search-results-list app-scrollbar">
                <section
                    v-for="group in groupedResults"
                    :key="group.pageIndex"
                    class="pdf-search-results-group flex flex-col"
                >
                    <button
                        type="button"
                        class="pdf-search-results-group-toggle"
                        :aria-expanded="isGroupExpanded(group.pageIndex)"
                        @click="togglePage(group.pageIndex)"
                    >
                        <UIcon
                            name="i-ph-caret-right"
                            class="pdf-search-results-group-chevron"
                            :class="{ 'is-open': isGroupExpanded(group.pageIndex) }"
                        />
                        <span class="pdf-search-results-group-label">
                            {{ t('searchResults.pageWithCount', {
                                page: formatPageIndicatorWithOptions(group.pageIndex + 1, pageLabels ?? null),
                                count: group.matches.length,
                            }) }}
                        </span>
                    </button>

                    <div v-if="isGroupExpanded(group.pageIndex)" class="flex flex-col">
                        <PdfSearchResultItem
                            v-for="match in group.matches"
                            :key="match.matchIndex"
                            :ref="element => setResultRef(match.matchIndex, element)"
                            :result="match"
                            :is-active="match.matchIndex === activeMatchIndex"
                            :page-labels="pageLabels"
                            :show-page-label="false"
                            @activate="goToResult(match.matchIndex)"
                        />
                    </div>
                </section>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { groupBy } from 'es-toolkit/array';
import type { IPdfSearchMatch } from '@app/types/pdf';
import PdfPanelEmptyState from '@app/modules/pdf-viewer/components/PdfPanelEmptyState.vue';
import PdfSearchResultItem from '@app/modules/pdf-viewer/components/PdfSearchResultItem.vue';
import { formatPageIndicatorWithOptions } from '@app/utils/pdfPageLabels';

const { t } = useTypedI18n();

interface IProps {
    results: IPdfSearchMatch[];
    currentResultIndex: number;
    currentResultNavigationId: number;
    searchQuery: string;
    pageLabels?: string[] | null | undefined;
    isSearching?: boolean | undefined;
    searchError?: string | null | undefined;
    searchProgress?: {
        processed: number;
        total: number;
    } | undefined;
    isTruncated?: boolean | undefined;
    minQueryLength?: number | undefined;
}

const {
    currentResultNavigationId,
    currentResultIndex,
    isSearching = undefined,
    isTruncated: isTruncatedProp = false,
    minQueryLength: minQueryLengthProp = undefined,
    pageLabels = undefined,
    results,
    searchError = undefined,
    searchProgress = undefined,
    searchQuery,
} = defineProps<IProps>();

const emit = defineEmits<{(e: 'goToResult', index: number): void;}>();

const trimmedQuery = computed(() => searchQuery.trim());
const minQueryLength = computed(() => minQueryLengthProp ?? 0);
const isTruncated = computed(() => isTruncatedProp ?? false);
const expandedPages = ref<Set<number>>(new Set());
const resultItemRefs = new Map<number, HTMLElement>();

const activeMatchIndex = computed(() => results[currentResultIndex]?.matchIndex ?? -1);

const groupedResults = computed(() => {
    const groups = groupBy(results, result => result.pageIndex);

    return Object.entries(groups).map(([
        pageIndex,
        matches,
    ]) => ({
        pageIndex: Number(pageIndex),
        matches,
    }));
});

const resultIndexByMatchIndex = computed(() => new Map(
    results.map((result, index) => [
        result.matchIndex,
        index,
    ]),
));

function goToResult(matchIndex: number) {
    emit('goToResult', resultIndexByMatchIndex.value.get(matchIndex) ?? -1);
}

const isQueryTooShort = computed(() => {
    const min = minQueryLength.value;
    if (!min || !trimmedQuery.value) {
        return false;
    }
    return trimmedQuery.value.length < min;
});

const progressText = computed(() => {
    if (!searchProgress || searchProgress.total === 0) {
        return '';
    }

    const total = searchProgress.total;
    const processed = Math.min(searchProgress.processed, total);
    return t('searchResults.pagesProgress', {
        processed,
        total,
    });
});

function isGroupExpanded(pageIndex: number) {
    return expandedPages.value.has(pageIndex);
}

function togglePage(pageIndex: number) {
    const next = new Set(expandedPages.value);
    if (next.has(pageIndex)) {
        next.delete(pageIndex);
    } else {
        next.add(pageIndex);
    }
    expandedPages.value = next;
}

function setResultRef(
    matchIndex: number,
    component: ComponentPublicInstance | Element | null,
) {
    if (!component) {
        resultItemRefs.delete(matchIndex);
        return;
    }

    if (component instanceof HTMLElement) {
        resultItemRefs.set(matchIndex, component);
        return;
    }

    if ('$el' in component && component.$el instanceof HTMLElement) {
        resultItemRefs.set(matchIndex, component.$el);
    }
}

watch(
    groupedResults,
    (groups) => {
        expandedPages.value = new Set(groups.map(group => group.pageIndex));
    },
    { immediate: true },
);

watch(
    () => currentResultNavigationId,
    async (nextNavigationId) => {
        if (nextNavigationId <= 0) {
            return;
        }

        const nextIndex = currentResultIndex;
        const resultCount = results.length;
        if (resultCount <= 0 || nextIndex < 0 || nextIndex >= resultCount) {
            return;
        }

        const currentResult = results[nextIndex];
        if (!currentResult) {
            return;
        }

        expandedPages.value = new Set(expandedPages.value).add(currentResult.pageIndex);

        await nextTick();
        resultItemRefs.get(currentResult.matchIndex)?.scrollIntoView({
            block: 'nearest',
            behavior: 'smooth',
        });
    },
    { flush: 'post' },
);
</script>

<style lang="scss" scoped>
.pdf-search-results {
    min-height: 100%;
}


.pdf-search-results-header {
    display: flex;
    min-width: 0;
    min-height: 36px;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--ui-text-muted);
    border-bottom: 1px solid var(--ui-border);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.pdf-search-results-header-summary {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

.pdf-search-results-header-spinner {
    color: var(--ui-text-dimmed);
}

.pdf-search-results-header-progress {
    flex: 0 0 auto;
    margin-left: 0;
    color: var(--ui-text-dimmed);
}

.pdf-search-results-header-spinner:first-of-type {
    margin-left: auto;
}

.pdf-search-results-truncated {
    margin-left: auto;
    font-size: 11px;
    color: var(--ui-text-dimmed);
}

.pdf-search-results-spinner {
    flex: 0 0 auto;
    animation: pdf-search-spin 1s linear infinite;
}

.pdf-search-results-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
}


.pdf-search-results-group + .pdf-search-results-group {
    border-top: 1px solid var(--ui-border);
}

.pdf-search-results-group-toggle {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.45rem;
    border: none;
    background: color-mix(in oklab, var(--ui-bg-muted) 55%, transparent 45%);
    padding: 0.55rem 0.75rem;
    text-align: left;
    color: var(--ui-text);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
}

.pdf-search-results-group-chevron {
    transition: transform $ease-standard;
}

.pdf-search-results-group-chevron.is-open {
    transform: rotate(90deg);
}

.pdf-search-results-group-label {
    min-width: 0;
}

@keyframes pdf-search-spin {
    from {
        transform: rotate(0deg);
    }

    to {
        transform: rotate(360deg);
    }
}
</style>
