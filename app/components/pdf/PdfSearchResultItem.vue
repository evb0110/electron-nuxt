<template>
    <button
        type="button"
        class="pdf-search-result flex flex-col gap-1"
        :class="{ 'is-active': isActive }"
        :aria-current="isActive ? 'true' : undefined"
        @click="emit('activate')"
        @keydown.enter.prevent="emit('activate')"
        @keydown.space.prevent="emit('activate')"
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
import { formatPageIndicator } from '@app/utils/pdf-page-labels';

const { t } = useTypedI18n();

interface IProps {
    result: IPdfSearchMatch;
    isActive: boolean;
    pageLabels?: string[] | null;
    showPageLabel?: boolean;
}

const props = defineProps<IProps>();
const emit = defineEmits<{(e: 'activate'): void;}>();

const showPageLabel = computed(() => props.showPageLabel ?? true);
const pageIndicator = computed(() => formatPageIndicator(props.result.pageIndex + 1, props.pageLabels ?? null));
const matchIndicator = computed(() => (props.result.pageMatchIndex ?? props.result.matchIndex) + 1);
</script>

<style lang="scss" scoped>
.pdf-search-result {
    width: 100%;
    border: none;
    text-align: left;
    padding: 8px 12px;
    cursor: pointer;
    background: transparent;
    transition: background-color $ease-standard;
}

.pdf-search-result:hover {
    background: var(--ui-bg-muted);
}

.pdf-search-result.is-active {
    background: var(--ui-bg-accented);
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
    padding: 0 0.1rem;
    border-radius: 0.2rem;
    background: var(--app-pdf-search-result-highlight-bg);
    color: var(--ui-text);
    font-weight: 700;
}
</style>
