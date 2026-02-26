<template>
    <button
        type="button"
        class="pdf-search-result"
        :class="{ 'is-active': isActive }"
        :aria-current="isActive ? 'true' : undefined"
        @click="emit('activate')"
        @keydown.enter.prevent="emit('activate')"
        @keydown.space.prevent="emit('activate')"
    >
        <div class="pdf-search-result-meta">
            <span class="pdf-search-result-page">{{ t('searchResults.page', { page: pageIndicator }) }}</span>
            <span class="pdf-search-result-match">{{ t('searchResults.match', { index: result.matchIndex + 1 }) }}</span>
        </div>
        <div
            v-if="result.excerpt"
            class="pdf-search-result-snippet"
        >
            <template v-if="result.excerpt.prefix">…</template>
            <span
                ref="textRef"
            >
                {{ fullText }}
            </span>
            <template v-if="result.excerpt.suffix">…</template>
        </div>
    </button>
</template>

<script setup lang="ts">

import type { IPdfSearchMatch } from '@app/types/pdf';
import {
    registerSearchHighlight,
    unregisterSearchHighlight,
} from '@app/composables/useSearchHighlight';
import { formatPageIndicator } from '@app/utils/pdf-page-labels';

const { t } = useTypedI18n();

interface IProps {
    result: IPdfSearchMatch;
    isActive: boolean;
    pageLabels?: string[] | null;
}

const props = defineProps<IProps>();
const emit = defineEmits<{(e: 'activate'): void;}>();

const textRef = ref<HTMLSpanElement | null>(null);
const highlightId = `search-${Math.random().toString(36).slice(2)}`;

const fullText = computed(() => {
    if (!props.result.excerpt) {
        return '';
    }
    return props.result.excerpt.before + props.result.excerpt.match + props.result.excerpt.after;
});

const matchStart = computed(() => props.result.excerpt?.before.length ?? 0);
const matchEnd = computed(() => matchStart.value + (props.result.excerpt?.match.length ?? 0));
const pageIndicator = computed(() => formatPageIndicator(props.result.pageIndex + 1, props.pageLabels ?? null));

function applyHighlight() {
    if (!textRef.value || typeof CSS === 'undefined' || !CSS.highlights) {
        return;
    }

    const textNode = textRef.value.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        return;
    }

    const textLength = textNode.textContent?.length ?? 0;
    const start = Math.max(0, Math.min(matchStart.value, textLength));
    const end = Math.max(start, Math.min(matchEnd.value, textLength));

    if (start === end) {
        return;
    }

    const range = new Range();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    registerSearchHighlight(highlightId, range);
}

function clearHighlight() {
    unregisterSearchHighlight(highlightId);
}

onMounted(() => {
    nextTick(() => applyHighlight());
});

onBeforeUnmount(() => {
    clearHighlight();
});

watch(
    () => [
        props.result,
        fullText.value,
    ],
    () => {
        clearHighlight();
        nextTick(() => applyHighlight());
    },
);
</script>

<style scoped>
.pdf-search-result {
    width: 100%;
    border: none;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    cursor: pointer;
    background: transparent;
    transition: background-color 0.15s;
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
    line-height: 1.4;
    color: var(--ui-text-muted);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}
</style>

<style>
/* CSS Custom Highlight API - must be global (not scoped) */
::highlight(search-result-match) {
    color: var(--ui-text);
    background-color: var(--app-pdf-search-result-highlight-bg);
}
</style>
