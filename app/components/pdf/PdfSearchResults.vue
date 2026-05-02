<template>
    <div class="pdf-search-results flex flex-col">
        <div
            v-if="isSearching"
            class="pdf-search-results-status"
        >
            <UIcon name="i-lucide-loader-2" class="pdf-search-results-spinner size-4" />
            <span class="pdf-search-results-status-label">
                {{ t('searchResults.searching') }}
            </span>
            <span
                v-if="progressText"
                class="pdf-search-results-status-progress"
            >
                ({{ progressText }})
            </span>
        </div>
        <PdfPanelEmptyState
            v-if="!trimmedQuery"
            icon="i-lucide-search"
            :title="t('searchResults.enterSearchTerm')"
            :description="t('searchResults.enterSearchHint')"
        />
        <PdfPanelEmptyState
            v-else-if="isQueryTooShort"
            icon="i-lucide-type"
            :title="t('searchResults.typeMinChars', { count: minQueryLength })"
            :description="t('searchResults.enterSearchHint')"
        />
        <PdfPanelEmptyState
            v-else-if="!isSearching && searchError"
            icon="i-lucide-triangle-alert"
            :title="t('searchResults.unavailable')"
            :description="searchError"
        />
        <PdfPanelEmptyState
            v-else-if="!isSearching && results.length === 0"
            icon="i-lucide-search-x"
            :title="t('searchResults.noResults')"
            :description="t('searchResults.noResultsHint')"
        />
        <div
            v-else-if="results.length > 0"
            class="pdf-search-results-list-shell flex flex-1 min-h-0 flex-col"
        >
            <div class="pdf-search-results-header">
                {{ t('searchResults.resultCount', { count: results.length }) }} {{ t('searchResults.forQuery', { query: trimmedQuery }) }}
                <div
                    v-if="isTruncated"
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
                            name="i-lucide-chevron-right"
                            class="pdf-search-results-group-chevron"
                            :class="{ 'is-open': isGroupExpanded(group.pageIndex) }"
                        />
                        <span class="pdf-search-results-group-label">
                            {{ t('searchResults.pageWithCount', {
                                page: formatPageIndicator(group.pageIndex + 1, pageLabels ?? null),
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
                            @activate="$emit('goToResult', match.matchIndex)"
                        />
                    </div>
                </section>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import type { IPdfSearchMatch } from '@app/types/pdf';
import PdfPanelEmptyState from '@app/components/pdf/PdfPanelEmptyState.vue';
import PdfSearchResultItem from '@app/components/pdf/PdfSearchResultItem.vue';
import { formatPageIndicator } from '@app/utils/pdf-page-labels';

const { t } = useTypedI18n();

interface IProps {
    results: IPdfSearchMatch[];
    currentResultIndex: number;
    searchQuery: string;
    searchOptions?: {
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
    };
    pageLabels?: string[] | null;
    isSearching?: boolean;
    searchError?: string | null;
    searchProgress?: {
        processed: number;
        total: number;
    };
    isTruncated?: boolean;
    minQueryLength?: number;
}

const props = defineProps<IProps>();

defineEmits<{(e: 'goToResult', index: number): void;}>();

const trimmedQuery = computed(() => props.searchQuery.trim());
const minQueryLength = computed(() => props.minQueryLength ?? 0);
const isTruncated = computed(() => props.isTruncated ?? false);
const expandedPages = ref<Set<number>>(new Set());
const resultItemRefs = new Map<number, HTMLElement>();

const activeMatchIndex = computed(() => props.results[props.currentResultIndex]?.matchIndex ?? -1);

const groupedResults = computed(() => {
    const groups = new Map<number, IPdfSearchMatch[]>();

    props.results.forEach((result) => {
        const matches = groups.get(result.pageIndex) ?? [];
        matches.push(result);
        groups.set(result.pageIndex, matches);
    });

    return Array.from(groups.entries()).map(([
        pageIndex,
        matches,
    ]) => ({
        pageIndex,
        matches,
    }));
});

const isQueryTooShort = computed(() => {
    const min = minQueryLength.value;
    if (!min || !trimmedQuery.value) {
        return false;
    }
    return trimmedQuery.value.length < min;
});

const progressText = computed(() => {
    if (!props.searchProgress || props.searchProgress.total === 0) {
        return '';
    }

    const total = props.searchProgress.total;
    const processed = Math.min(props.searchProgress.processed, total);
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
    () => [
        props.currentResultIndex,
        props.results.length,
    ] as const,
    async ([
        nextIndex,
        resultCount,
    ]) => {
        if (resultCount <= 0 || nextIndex < 0 || nextIndex >= resultCount) {
            return;
        }

        const currentResult = props.results[nextIndex];
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
    min-height: 36px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--ui-text-muted);
    border-bottom: 1px solid var(--ui-border);
    font-variant-numeric: tabular-nums;
}

.pdf-search-results-truncated {
    margin-top: 4px;
    font-size: 11px;
    color: var(--ui-text-dimmed);
}

.pdf-search-results-status {
    display: flex;
    min-height: 40px;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    overflow: hidden;
    color: var(--ui-text-muted);
    border-bottom: 1px solid var(--ui-border);
    white-space: nowrap;
}

.pdf-search-results-status-label {
    flex: 0 0 auto;
}

.pdf-search-results-status-progress {
    display: inline-block;
    min-width: 18ch;
}

.pdf-search-results-status span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
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
