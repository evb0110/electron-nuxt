<template>
    <div class="document-search-results flex flex-col">
        <DocumentPanelEmptyState
            v-if="!trimmedQuery"
            icon="i-ph-magnifying-glass"
            :title="t('searchResults.enterSearchTerm')"
            :description="t('searchResults.enterSearchHint')"
        />
        <DocumentPanelEmptyState
            v-else-if="isQueryTooShort"
            icon="i-ph-text-t"
            :title="t('searchResults.typeMinChars', { count: minQueryLength })"
            :description="t('searchResults.enterSearchHint')"
        />
        <DocumentPanelEmptyState
            v-else-if="!isSearching && searchError"
            icon="i-ph-warning"
            :title="t('searchResults.unavailable')"
            :description="searchError"
        />
        <DocumentPanelEmptyState
            v-else-if="!isSearching && results.length === 0"
            icon="i-ph-magnifying-glass"
            :title="t('searchResults.noResults')"
            :description="t('searchResults.noResultsHint')"
        />
        <div
            v-else-if="isSearching || results.length > 0"
            class="document-search-results-list-shell flex flex-1 min-h-0 flex-col"
        >
            <div class="document-search-results-header">
                <span class="document-search-results-header-summary">
                    {{ searchSummaryText }}
                </span>
                <UIcon
                    v-if="isSearching"
                    name="i-ph-circle-notch"
                    class="document-search-results-spinner document-search-results-header-spinner size-4"
                    aria-live="polite"
                    :aria-label="t('searchResults.searching')"
                />
                <span
                    v-if="isSearching && progressText"
                    class="document-search-results-header-progress"
                >
                    {{ progressText }}
                </span>
                <div
                    v-if="!isSearching && isTruncated"
                    class="document-search-results-truncated"
                >
                    {{ t('searchResults.showingFirst', { count: results.length }) }}
                </div>
            </div>
            <AppProgressBar
                v-if="isSearching"
                :value="searchProgressPercent"
                class="document-search-results-progress-bar"
            />
            <div
                v-bind="containerProps"
                class="document-search-results-list app-scrollbar"
            >
                <div v-bind="wrapperProps">
                    <template
                        v-for="virtualRow in virtualRows"
                        :key="virtualRow.data.key"
                    >
                    <button
                        v-if="virtualRow.data.kind === 'group'"
                        type="button"
                        class="document-search-results-group-toggle"
                        :aria-expanded="isGroupExpanded(virtualRow.data.pageIndex)"
                        @click="togglePage(virtualRow.data.pageIndex)"
                    >
                        <UIcon
                            name="i-ph-caret-right"
                            class="document-search-results-group-chevron"
                            :class="{ 'is-open': isGroupExpanded(virtualRow.data.pageIndex) }"
                        />
                        <span class="document-search-results-group-label">
                            {{ t('searchResults.pageWithCount', {
                                page: formatPageIndicatorWithOptions(virtualRow.data.pageIndex + 1, pageLabels ?? null),
                                count: virtualRow.data.matchCount,
                            }) }}
                        </span>
                    </button>

                    <DocumentSearchResultItem
                            v-else
                            :ref="element => setResultRef(asMatchRow(virtualRow.data).resultIndex, element)"
                            :result="asMatchRow(virtualRow.data).match"
                            :is-active="asMatchRow(virtualRow.data).resultIndex === currentResultIndex"
                            :page-labels="pageLabels"
                            :show-page-label="false"
                            class="document-search-results-virtual-match"
                            @activate="goToResult(asMatchRow(virtualRow.data).resultIndex)"
                        />
                    </template>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { useVirtualList } from '@vueuse/core';
import { groupBy } from 'es-toolkit/array';
import type { IDocumentSearchMatch } from '@app/utils/document-viewer/providers/documentSearch';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import DocumentPanelEmptyState from '@app/components/document-viewer/DocumentPanelEmptyState.vue';
import DocumentSearchResultItem from '@app/components/document-viewer/DocumentSearchResultItem.vue';
import { formatDocumentSearchResultsSummary } from '@app/utils/document-viewer/providers/formatDocumentSearchResultsSummary';
import { formatPageIndicatorWithOptions } from '@app/utils/document-viewer/pageLabels';

const { t } = useTypedI18n();

interface IProps {
    results: IDocumentSearchMatch[];
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

const emit = defineEmits<{goToResult: [index: number];}>();

const trimmedQuery = computed(() => searchQuery.trim());
const minQueryLength = computed(() => minQueryLengthProp ?? 0);
const isTruncated = computed(() => isTruncatedProp ?? false);
const expandedPages = ref<Set<number>>(new Set());
const knownGroupPages = ref<Set<number>>(new Set());
const previousSearchQuery = ref('');
const resultItemRefs = new Map<number, HTMLElement>();

const searchSummaryText = computed(() => formatDocumentSearchResultsSummary({
    isSearching: Boolean(isSearching),
    query: trimmedQuery.value,
    resultCount: results.length,
    t,
}));

const groupedResults = computed(() => {
    const groups = groupBy(results.map((match, resultIndex) => ({
        match,
        resultIndex,
    })), result => result.match.pageIndex);

    return Object.entries(groups).map(([
        pageIndex,
        matches,
    ]) => ({
        pageIndex: Number(pageIndex),
        matches,
    }));
});

type TSearchVirtualRow = {
    kind: 'group';
    key: string;
    pageIndex: number;
    matchCount: number;
} | {
    kind: 'match';
    key: string;
    pageIndex: number;
    match: IDocumentSearchMatch;
    resultIndex: number;
};

function asMatchRow(row: TSearchVirtualRow): Extract<TSearchVirtualRow, {kind: 'match';}> {
    if (row.kind !== 'match') {
        throw new Error('Expected a virtual search match row');
    }
    return row;
}

const flattenedRows = computed<TSearchVirtualRow[]>(() => groupedResults.value.flatMap((group) => {
    const header: TSearchVirtualRow = {
        kind: 'group',
        key: `group-${group.pageIndex}`,
        pageIndex: group.pageIndex,
        matchCount: group.matches.length,
    };
    if (!expandedPages.value.has(group.pageIndex)) {
        return [header];
    }
    return [
        header,
        ...group.matches.map(({
            match,
            resultIndex,
        }): TSearchVirtualRow => ({
            kind: 'match',
            key: `match-${resultIndex}`,
            pageIndex: group.pageIndex,
            match,
            resultIndex,
        })),
    ];
}));

const {
    list: virtualRows,
    containerProps,
    wrapperProps,
    scrollTo: scrollToVirtualRow,
} = useVirtualList(flattenedRows, {
    itemHeight: index => flattenedRows.value[index]?.kind === 'group' ? 36 : 84,
    overscan: 8,
});

function goToResult(resultIndex: number) {
    emit('goToResult', resultIndex);
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

const searchProgressPercent = computed(() => {
    if (!searchProgress || !Number.isFinite(searchProgress.total) || searchProgress.total <= 0) {
        return null;
    }

    const total = Math.max(1, Math.trunc(searchProgress.total));
    const processed = Number.isFinite(searchProgress.processed)
        ? Math.min(Math.max(Math.trunc(searchProgress.processed), 0), total)
        : 0;
    return (processed / total) * 100;
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
    resultIndex: number,
    component: ComponentPublicInstance | Element | null,
) {
    if (!component) {
        resultItemRefs.delete(resultIndex);
        return;
    }

    if (component instanceof HTMLElement) {
        resultItemRefs.set(resultIndex, component);
        return;
    }

    if ('$el' in component && component.$el instanceof HTMLElement) {
        resultItemRefs.set(resultIndex, component.$el);
    }
}

watch(
    () => [
        trimmedQuery.value,
        groupedResults.value,
    ] as const,
    ([
        query,
        groups,
    ]) => {
        const nextGroupPages = new Set(groups.map(group => group.pageIndex));

        if (query !== previousSearchQuery.value) {
            previousSearchQuery.value = query;
            knownGroupPages.value = nextGroupPages;
            const firstPage = groups[0]?.pageIndex;
            expandedPages.value = firstPage === undefined ? new Set() : new Set([firstPage]);
            return;
        }

        const nextExpandedPages = new Set(
            Array.from(expandedPages.value).filter(pageIndex => nextGroupPages.has(pageIndex)),
        );
        nextGroupPages.forEach((pageIndex) => {
            if (!knownGroupPages.value.has(pageIndex)) {
                nextExpandedPages.add(pageIndex);
            }
        });

        knownGroupPages.value = nextGroupPages;
        expandedPages.value = nextExpandedPages;
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
        const virtualIndex = flattenedRows.value.findIndex(row => (
            row.kind === 'match' && row.resultIndex === nextIndex
        ));
        if (virtualIndex >= 0) {
            scrollToVirtualRow(virtualIndex);
            await nextTick();
        }
        resultItemRefs.get(nextIndex)?.scrollIntoView({
            block: 'nearest',
            behavior: 'smooth',
        });
    },
    { flush: 'post' },
);
</script>

<style lang="scss" scoped>
.document-search-results {
    min-height: 100%;
}

.document-search-results-virtual-match {
    height: var(--app-search-virtual-row-height);
    overflow: hidden;
}


.document-search-results-header {
    display: flex;
    min-width: 0;
    min-height: var(--app-control-height-md);
    align-items: center;
    gap: var(--app-sidebar-row-gap);
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    font-size: var(--app-sidebar-caption-font-size);
    color: var(--ui-text-muted);
    border-bottom: 1px solid var(--ui-border);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.document-search-results-header-summary {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

.document-search-results-header-spinner {
    color: var(--ui-text-dimmed);
}

.document-search-results-header-progress {
    flex: 0 0 auto;
    margin-left: 0;
    color: var(--ui-text-dimmed);
}

.document-search-results-header-spinner:first-of-type {
    margin-left: auto;
}

.document-search-results-progress-bar {
    height: var(--app-search-progress-height);
    border-radius: 0;
}

.document-search-results-truncated {
    margin-left: auto;
    font-size: var(--app-sidebar-caption-font-size);
    color: var(--ui-text-dimmed);
}

.document-search-results-spinner {
    flex: 0 0 auto;
    animation: document-search-spin 1s linear infinite;
}

.document-search-results-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
}


.document-search-results-group + .document-search-results-group {
    border-top: 1px solid var(--ui-border);
}

.document-search-results-group-toggle {
    display: flex;
    width: 100%;
    align-items: center;
    gap: var(--app-sidebar-row-gap);
    border: none;
    background: color-mix(in oklab, var(--ui-bg-muted) 55%, transparent 45%);
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    text-align: left;
    color: var(--ui-text);
    font-size: var(--app-sidebar-row-font-size);
    font-weight: 600;
    cursor: pointer;
}

.document-search-results-group-chevron {
    transition: transform $ease-standard;
}

.document-search-results-group-chevron.is-open {
    transform: rotate(90deg);
}

.document-search-results-group-label {
    min-width: 0;
}

@keyframes document-search-spin {
    from {
        transform: rotate(0deg);
    }

    to {
        transform: rotate(360deg);
    }
}
</style>
