<template>
    <button
        type="button"
        class="pdf-search-result flex flex-col gap-1"
        :class="{ 'is-active': isActive }"
        :aria-current="isActive ? 'true' : undefined"
        @click="activate"
        @keydown.enter.prevent="activate"
        @keydown.space.prevent="activate"
    >
        <div class="pdf-search-result-meta">
            <span v-if="showPageLabel" class="pdf-search-result-page">{{ t('searchResults.page', { page: pageIndicator }) }}</span>
            <span class="pdf-search-result-match">{{ t('searchResults.match', { index: matchIndicator }) }}</span>
        </div>
        <div
            v-if="result.excerpt"
            class="pdf-search-result-snippet"
        >
            <template v-if="result.excerpt.prefix">…</template>
            <span>{{ result.excerpt.before }}</span>
            <mark class="pdf-search-result-highlight">{{ result.excerpt.match }}</mark>
            <span>{{ result.excerpt.after }}</span>
            <template v-if="result.excerpt.suffix">…</template>
        </div>
    </button>
</template>

<script setup lang="ts">
import type { IPdfSearchMatch } from '@app/types/pdf';
import { formatPageIndicatorWithOptions } from '@app/utils/pdfPageLabels';

const { t } = useTypedI18n();

interface IProps {
    result: IPdfSearchMatch;
    isActive: boolean;
    pageLabels?: string[] | null | undefined;
    showPageLabel?: boolean | undefined;
}

const {
    pageLabels = undefined,
    result,
    showPageLabel: showPageLabelProp = true,
} = defineProps<IProps>();
const emit = defineEmits<{activate: [];}>();

const showPageLabel = computed(() => showPageLabelProp ?? true);
const pageIndicator = computed(() => formatPageIndicatorWithOptions(result.pageIndex + 1, pageLabels ?? null));
const matchIndicator = computed(() => (result.pageMatchIndex ?? result.matchIndex) + 1);

function activate() {
    emit('activate');
}
</script>

<style lang="scss" scoped>
.pdf-search-result {
    width: 100%;
    border: 1px solid transparent;
    border-radius: 6px;
    text-align: left;
    padding: 8px 12px;
    cursor: pointer;
    background: transparent;
    transition: background-color $ease-standard;
}

.pdf-search-result:hover {
    background: var(--app-sidebar-control-hover-bg);
}

.pdf-search-result.is-active {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
}

.pdf-search-result:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--app-pdf-search-result-focus-ring);
}

.pdf-search-result-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.pdf-search-result-page {
    font-size: 13px;
    font-weight: 500;
}

.pdf-search-result-match {
    font-size: 11px;
    color: var(--ui-text-muted);
}

.pdf-search-result-snippet {
    font-size: 12px;
    line-height: 1.45;
    color: var(--ui-text-muted);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
}

.pdf-search-result-highlight {
    padding: 0;
    border-radius: 0.2rem;
    background: var(--app-pdf-search-result-highlight-bg);
    color: var(--ui-text);
    font-weight: 700;
}

.pdf-search-result.is-active .pdf-search-result-highlight {
    background: var(--app-pdf-search-result-highlight-current-bg);
}
</style>
