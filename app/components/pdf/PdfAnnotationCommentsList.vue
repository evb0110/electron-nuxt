<template>
    <div class="notes-list-section flex flex-col gap-2">
        <div class="notes-list-header">
            <span class="notes-list-title">{{ t('annotations.notes') }}</span>
            <span class="notes-count">({{ filteredComments.length }})</span>
            <button
                type="button"
                class="notes-header-btn"
                :aria-label="t('annotations.placeNoteOnPage')"
                @click="emit('place-note')"
            >
                <UIcon name="i-lucide-message-square-plus" />
            </button>
            <button
                type="button"
                class="notes-header-btn"
                :aria-label="t('annotations.searchNotes')"
                @click="onSearchButtonClick"
            >
                <UIcon name="i-lucide-search" />
            </button>
        </div>

        <input
            v-if="searchVisible"
            ref="searchInputRef"
            v-model.trim="query"
            type="search"
            class="notes-search"
            :placeholder="t('annotations.searchNotes')"
            @keydown.stop
            @keyup.stop
        />

        <div class="notes-list app-scrollbar flex flex-col">
            <button
                v-for="comment in filteredComments"
                :key="comment.stableKey"
                type="button"
                class="note-item flex flex-col"
                :class="{ 'is-active': activeCommentStableKey === comment.stableKey }"
                @click="focusComment(comment)"
                @dblclick.prevent.stop="openComment(comment)"
            >
                <span class="note-item-top">
                    <span class="note-item-page">
                        <template v-for="(part, index) in highlightTextParts(pageLabel(comment))" :key="`page-${comment.stableKey}-${index}`">
                            <span v-if="!part.match">{{ part.text }}</span>
                            <mark v-else class="note-match">{{ part.text }}</mark>
                        </template>
                    </span>
                    <span class="note-item-type">
                        <template v-for="(part, index) in highlightTextParts(commentTypeLabel(comment))" :key="`type-${comment.stableKey}-${index}`">
                            <span v-if="!part.match">{{ part.text }}</span>
                            <mark v-else class="note-match">{{ part.text }}</mark>
                        </template>
                    </span>
                    <button
                        type="button"
                        class="note-item-delete"
                        :aria-label="t('annotations.delete')"
                        @click.stop="emit('delete-comment', comment)"
                    >
                        <UIcon name="i-lucide-trash-2" />
                    </button>
                </span>
                <span class="note-item-text">
                    <template v-for="(part, index) in highlightTextParts(notePreview(comment))" :key="`text-${comment.stableKey}-${index}`">
                        <span v-if="!part.match">{{ part.text }}</span>
                        <mark v-else class="note-match">{{ part.text }}</mark>
                    </template>
                </span>
                <span class="note-item-meta">
                    <span>
                        <template v-for="(part, index) in highlightTextParts(authorLabel(comment))" :key="`author-${comment.stableKey}-${index}`">
                            <span v-if="!part.match">{{ part.text }}</span>
                            <mark v-else class="note-match">{{ part.text }}</mark>
                        </template>
                    </span>
                    <span v-if="comment.modifiedAt">{{ formatTime(comment.modifiedAt) }}</span>
                </span>
            </button>

            <PdfPanelEmptyState
                v-if="filteredComments.length === 0"
                icon="i-lucide-sticky-note"
                :title="t('annotations.noNotesFound')"
                :description="t('annotations.noNotesHint')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import PdfPanelEmptyState from '@app/components/pdf/PdfPanelEmptyState.vue';
import {
    isTextNoteComment,
    compareComments,
    matchesCommentQuery,
    splitByQueryMatches,
} from '@app/utils/pdf-annotation-comments';

interface IProps {
    comments: IAnnotationCommentSummary[];
    activeCommentStableKey?: string | null;
    authorName?: string | null;
}

const { t } = useTypedI18n();

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'focus-comment', comment: IAnnotationCommentSummary): void;
    (e: 'open-note', comment: IAnnotationCommentSummary): void;
    (e: 'delete-comment', comment: IAnnotationCommentSummary): void;
    (e: 'place-note'): void;
}>();

const query = ref('');
const searchVisible = ref(false);
const searchInputRef = ref<HTMLInputElement | null>(null);

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const authorName = computed(() => props.authorName ?? null);
const activeCommentStableKey = computed(() => props.activeCommentStableKey ?? null);
const normalizedQuery = computed(() => query.value.trim().toLowerCase());

const sortedComments = computed(() => props.comments.slice().sort(compareComments));
const noteComments = computed(() => sortedComments.value.filter(isTextNoteComment));

const filteredComments = computed(() => {
    return noteComments.value.filter(comment => matchesCommentQuery(comment, normalizedQuery.value, authorName.value));
});

async function onSearchButtonClick() {
    if (!searchVisible.value) {
        searchVisible.value = true;
        await nextTick();
    }

    searchInputRef.value?.focus();
}

function commentTypeLabel(comment: IAnnotationCommentSummary) {
    const kind = comment.kindLabel?.trim();
    if (kind) {
        return kind;
    }

    const subtype = (comment.subtype ?? '').toLowerCase();
    if (subtype.includes('highlight')) {
        return t('annotations.highlightLabel');
    }
    if (subtype.includes('underline')) {
        return t('annotations.underlineLabel');
    }
    if (subtype.includes('strike')) {
        return t('annotations.strikeOutLabel');
    }
    if (subtype.includes('squiggly')) {
        return t('annotations.squiggleLabel');
    }
    if (subtype.includes('ink')) {
        return t('annotations.inkLabel');
    }
    if (subtype.includes('text') || subtype.includes('popup') || subtype.includes('note')) {
        return t('annotations.stickyNoteLabel');
    }
    if (subtype.includes('square') || subtype.includes('rectangle')) {
        return t('annotations.rectangleLabel');
    }
    if (subtype.includes('circle')) {
        return t('annotations.circleLabel');
    }
    if (subtype.includes('line')) {
        return t('annotations.lineLabel');
    }
    if (subtype.includes('arrow')) {
        return t('annotations.arrowLabel');
    }

    return t('annotations.annotationLabel');
}

function notePreview(comment: IAnnotationCommentSummary) {
    const text = comment.text.trim();
    if (!text) {
        return t('annotations.emptyNote');
    }

    return text;
}

function authorLabel(comment: IAnnotationCommentSummary) {
    return comment.author || authorName.value || t('annotations.unknownAuthor');
}

function pageLabel(comment: IAnnotationCommentSummary) {
    return `${t('annotations.page')} ${comment.pageNumber}`;
}

function highlightTextParts(text: string) {
    return splitByQueryMatches(text, normalizedQuery.value);
}

function formatTime(timestamp: number) {
    return timeFormatter.format(timestamp);
}

function focusComment(comment: IAnnotationCommentSummary) {
    emit('focus-comment', comment);
}

function openComment(comment: IAnnotationCommentSummary) {
    emit('focus-comment', comment);
    emit('open-note', comment);
}

</script>

<style lang="scss" scoped>
.notes-list-section {
    flex: 1 1 0;
    min-height: 0;
}

.notes-list-header {
    display: flex;
    align-items: center;
    gap: 0.35rem;
}

.notes-list-title {
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--ui-text-highlighted);
}

.notes-count {
    font-size: 0.78rem;
    color: var(--ui-text-muted);
}

.notes-header-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border: none;
    border-radius: 0.35rem;
    background: transparent;
    color: var(--ui-text-muted);
    font-size: 0.85rem;
    cursor: pointer;
}

.notes-header-btn:first-of-type {
    margin-left: auto;
}

.notes-header-btn:hover {
    background: color-mix(in srgb, var(--ui-border) 40%, transparent);
    color: var(--ui-text-highlighted);
}

.notes-search {
    width: 100%;
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    font-size: 0.82rem;
    padding: 0.45rem 0.55rem;
}

.notes-list {
    flex: 1 1 0;
    min-height: 5rem;
    overflow: auto;
    gap: 0.45rem;
    padding-right: 0.1rem;
}

.note-item {
    position: relative;
    border: 1px solid var(--ui-border);
    border-radius: 0.55rem;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    text-align: left;
    padding: 0.5rem;
    gap: 0.35rem;
    cursor: pointer;
}

.note-item.is-active {
    border-color: var(--app-notes-item-selected-ring);
    border-width: 2px;
    padding: calc(0.5rem - 1px);
}

.note-item-top {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    font-size: 0.72rem;
}

.note-item-page {
    font-weight: 700;
    color: var(--ui-text-highlighted);
}

.note-item-type {
    color: var(--ui-text-muted);
}

.note-item-delete {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.35rem;
    height: 1.35rem;
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--ui-text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    opacity: 0;
    transition: opacity $ease-standard;
}

.note-item-delete:hover {
    background: color-mix(in srgb, var(--ui-error) 15%, transparent);
    color: var(--ui-error);
}

.note-item:hover .note-item-delete {
    opacity: 1;
}

.note-item-text {
    font-size: 0.8rem;
    line-height: 1.35;
    color: var(--ui-text-highlighted);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.note-item-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
    font-size: 0.7rem;
    color: var(--ui-text-toned);
}

.note-match {
    background: var(--app-pdf-search-result-highlight-bg);
    color: inherit;
    border-radius: 0.2rem;
    padding: 0;
}

</style>
