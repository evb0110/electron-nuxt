<template>
    <div class="notes-list-section flex flex-col gap-2">
        <div class="notes-list-header">
            <span class="notes-list-title">{{ t('annotations.annotations') }}</span>
            <span class="notes-count">({{ filteredComments.length }})</span>
            <UButton
                type="button"
                class="notes-header-btn notes-header-btn--place"
                color="neutral"
                variant="ghost"
                size="xs"
                square
                icon="i-ph-chat-circle-dots"
                :aria-label="t('annotations.placeNoteOnPage')"
                @click="placeNote"
            />
            <UButton
                type="button"
                class="notes-header-btn"
                color="neutral"
                variant="ghost"
                size="xs"
                square
                icon="i-ph-magnifying-glass"
                :aria-label="t('annotations.searchAnnotations')"
                @click="onSearchButtonClick"
            />
        </div>

        <AppSearchInput
            v-if="searchVisible"
            ref="searchInputRef"
            v-model="query"
            type="search"
            class="notes-search"
            color="neutral"
            variant="outline"
            size="xs"
            :placeholder="t('annotations.searchAnnotations')"
            @keydown.stop
            @keyup.stop
        />

        <div
            v-bind="commentsContainerProps"
            class="notes-list app-scrollbar app-scroll-region--balanced"
        >
            <div v-bind="commentsWrapperProps">
                <button
                v-for="virtualComment in virtualComments"
                :key="virtualComment.data.stableKey"
                type="button"
                class="note-item flex flex-col"
                :class="{ 'is-active': activeCommentStableKey === annotationIdForSummary(virtualComment.data) }"
                @click="focusComment(virtualComment.data)"
                @dblclick.prevent.stop="openComment(virtualComment.data)"
            >
                <template v-for="comment in [virtualComment.data]" :key="comment.stableKey">
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
                    <span
                        v-if="inlineChipKind(comment)"
                        class="note-item-color-chip"
                        :class="`note-item-color-chip--${inlineChipKind(comment)}`"
                        :style="inlineChipStyle(comment)"
                        :aria-label="inlineChipAriaLabel(comment)"
                    />
                    <button
                        type="button"
                        class="note-item-delete"
                        :aria-label="t('annotations.delete')"
                        @click.stop="deleteComment(comment)"
                        @dblclick.stop.prevent
                    >
                        <UIcon name="i-ph-trash" />
                    </button>
                </span>
                <span
                    v-if="hasShapeStylePreview(comment)"
                    class="note-item-shape-style"
                    :aria-label="shapeStyleAriaLabel(comment)"
                >
                    <span
                        class="note-item-shape-stroke"
                        :style="shapeStrokeStyle(comment)"
                        aria-hidden="true"
                    />
                    <span class="note-item-shape-style-text">
                        <template v-for="(part, index) in highlightTextParts(shapeStyleLabel(comment))" :key="`style-${comment.stableKey}-${index}`">
                            <span v-if="!part.match">{{ part.text }}</span>
                            <mark v-else class="note-match">{{ part.text }}</mark>
                        </template>
                    </span>
                </span>
                <span v-else class="note-item-text">
                    <span
                        :class="textMarkupKind(comment) ? `note-item-text-mark note-item-text-mark--${textMarkupKind(comment)}` : null"
                        :style="textMarkupKind(comment) ? textMarkupStyle(comment) : null"
                    >
                        <template v-for="(part, index) in highlightTextParts(annotationPreview(comment))" :key="`text-${comment.stableKey}-${index}`">
                            <span v-if="!part.match">{{ part.text }}</span>
                            <mark v-else class="note-match">{{ part.text }}</mark>
                        </template>
                    </span>
                </span>
                <span class="note-item-meta">
                    <span>
                        <template v-for="(part, index) in highlightTextParts(authorLabel(comment))" :key="`author-${comment.stableKey}-${index}`">
                            <span v-if="!part.match">{{ part.text }}</span>
                            <mark v-else class="note-match">{{ part.text }}</mark>
                        </template>
                    </span>
                    <span v-if="commentTimeLabel(comment)">{{ commentTimeLabel(comment) }}</span>
                </span>
                </template>
            </button>
            </div>

            <DocumentPanelEmptyState
                v-if="showEmptyState"
                icon="i-ph-note"
                :title="t('annotations.noAnnotationsFound')"
                :description="t('annotations.noAnnotationsHint')"
            />
            <div
                v-else-if="showLoadingState"
                class="notes-loading-state"
                aria-hidden="true"
            >
                <span />
                <span />
                <span />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import {isFiniteNumber} from '@contracts/runtimeGuards';
import { clamp } from 'es-toolkit/math';
import { useVirtualList } from '@vueuse/core';
import type {
    IAnnotationCommentSummary,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import DocumentPanelEmptyState from '@app/components/document-viewer/DocumentPanelEmptyState.vue';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import {
    compareAnnotationCommentSummaries,
    getAnnotationCommentDisplayTimestamp,
    getAnnotationCommentPreviewText,
    matchesCommentQuery,
    splitByQueryMatches,
} from '@app/utils/pdfAnnotationComments';
import { isNoteEligibleComment } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isNoteEligibleComment';
import {
    annotationKindLabelFromSubtype,
    isTextMarkupSubtype,
} from '@app/services/pdf/annotationSubtype';
import AppSearchInput from '@app/components/AppSearchInput.vue';

const POINT_NOTE_MARKER_MAX_SIZE = 0.02;

interface IProps {
    comments: IAnnotationCommentSummary[];
    status: TAnnotationCommentsStatus;
    activeCommentStableKey?: string | null | undefined;
    authorName?: string | null | undefined;
}

const { t } = useTypedI18n();

const {
    activeCommentStableKey: activeCommentStableKeyProp = undefined,
    authorName: authorNameProp = undefined,
    comments,
    status,
} = defineProps<IProps>();

const emit = defineEmits<{
    'focus-comment': [comment: IAnnotationCommentSummary];
    'open-note': [comment: IAnnotationCommentSummary];
    'delete-comment': [comment: IAnnotationCommentSummary];
    'place-note': [];
}>();

const query = ref('');
const searchVisible = ref(false);
const searchInputRef = useTemplateRef<{focus: () => void}>('searchInputRef');

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const authorName = computed(() => authorNameProp ?? null);
const activeCommentStableKey = computed(() => activeCommentStableKeyProp ?? null);
const normalizedQuery = computed(() => query.value.trim().toLowerCase());

const sortedComments = computed(() => comments.slice().sort(compareAnnotationCommentSummaries));

const filteredComments = computed(() => {
    return sortedComments.value.filter(comment => matchesCommentQuery(comment, normalizedQuery.value, authorName.value));
});
const {
    list: virtualComments,
    containerProps: commentsContainerProps,
    wrapperProps: commentsWrapperProps,
} = useVirtualList(filteredComments, {
    itemHeight: 112,
    overscan: 6,
});
const showLoadingState = computed(() => status === 'loading' && filteredComments.value.length === 0);
const showEmptyState = computed(() => status === 'ready' && filteredComments.value.length === 0);


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

    return t(annotationKindLabelFromSubtype(comment.subtype).key);
}

function annotationPreview(comment: IAnnotationCommentSummary) {
    const text = getAnnotationCommentPreviewText(comment);
    if (!text) {
        return isNoteEligibleComment(comment)
            ? t('annotations.emptyNote')
            : t('annotations.emptyAnnotation');
    }

    return text;
}

function hasShapeFill(comment: IAnnotationCommentSummary) {
    return Boolean(comment.fillColor && comment.fillColor !== 'transparent');
}

function hasShapeStylePreview(comment: IAnnotationCommentSummary) {
    return comment.source === 'shape'
        && !getAnnotationCommentPreviewText(comment)
        && (Boolean(comment.color) || isFiniteNumber(comment.strokeWidth) || hasShapeFill(comment));
}

function formatShapeStrokeWidth(comment: IAnnotationCommentSummary) {
    if (!isFiniteNumber(comment.strokeWidth)) {
        return '';
    }

    return Number(comment.strokeWidth.toFixed(1)).toString();
}

function shapeStyleLabel(comment: IAnnotationCommentSummary) {
    const strokeWidth = formatShapeStrokeWidth(comment);
    if (strokeWidth) {
        return `${t('annotations.stroke')} ${strokeWidth}`;
    }

    if (hasShapeFill(comment)) {
        return t('annotationProperties.fill');
    }

    return t('annotations.stroke');
}

function shapeStyleAriaLabel(comment: IAnnotationCommentSummary) {
    const parts: string[] = [];
    if (comment.color) {
        parts.push(`${t('annotations.stroke')} ${comment.color}`);
    }
    if (hasShapeFill(comment)) {
        parts.push(`${t('annotationProperties.fill')} ${comment.fillColor}`);
    }
    const strokeWidth = formatShapeStrokeWidth(comment);
    if (strokeWidth) {
        parts.push(shapeStyleLabel(comment));
    }

    return parts.join(', ');
}

function shapeOpacity(comment: IAnnotationCommentSummary) {
    if (!isFiniteNumber(comment.opacity)) {
        return '1';
    }

    return clamp(comment.opacity, 0, 1).toString();
}

function shapePreviewColor(comment: IAnnotationCommentSummary) {
    return comment.color ?? comment.fillColor ?? 'currentColor';
}

function shapeStrokeStyle(comment: IAnnotationCommentSummary) {
    return {
        '--note-item-shape-color': shapePreviewColor(comment),
        '--note-item-shape-opacity': shapeOpacity(comment),
        '--note-item-shape-stroke-width': `${formatShapeStrokeWidth(comment) || '1'}px`,
    };
}

function normalizedSubtype(comment: IAnnotationCommentSummary) {
    return (comment.subtype ?? '').trim().toLowerCase();
}

function isInlineNoteSubtype(subtype: string) {
    return subtype === 'freetext' || subtype === 'typewriter' || subtype === 'note-inline';
}

function isStickyNoteSubtype(subtype: string) {
    return subtype === 'text' || subtype === 'note-linked';
}

function isStampSubtype(subtype: string) {
    return subtype === 'stamp';
}

function isPointLikeInlineNote(comment: IAnnotationCommentSummary) {
    if (!isInlineNoteSubtype(normalizedSubtype(comment))) {
        return false;
    }
    if (comment.hasNote === true) {
        return true;
    }

    const rect = comment.markerRect;
    return Boolean(
        rect
        && isFiniteNumber(rect.width)
        && isFiniteNumber(rect.height)
        && rect.width <= POINT_NOTE_MARKER_MAX_SIZE
        && rect.height <= POINT_NOTE_MARKER_MAX_SIZE,
    );
}

function hasUserPreviewText(comment: IAnnotationCommentSummary) {
    return Boolean(getAnnotationCommentPreviewText(comment));
}

function textMarkupKind(comment: IAnnotationCommentSummary) {
    if (!comment.color || !hasUserPreviewText(comment)) {
        return null;
    }

    const subtype = normalizedSubtype(comment);
    if (!isTextMarkupSubtype(subtype)) {
        return null;
    }

    if (subtype === 'underline') {
        return 'underline';
    }
    if (subtype === 'strikeout') {
        return 'strikeout';
    }
    if (subtype === 'squiggly') {
        return 'squiggly';
    }
    return 'highlight';
}

function textMarkupStyle(comment: IAnnotationCommentSummary) {
    return {'--note-item-marker-color': comment.color ?? 'currentcolor'};
}

function inlineChipKind(comment: IAnnotationCommentSummary) {
    if (!comment.color) {
        return null;
    }

    if (hasShapeStylePreview(comment) || textMarkupKind(comment)) {
        return null;
    }

    const subtype = normalizedSubtype(comment);

    if (isStickyNoteSubtype(subtype) || isStampSubtype(subtype)) {
        return null;
    }
    if (isPointLikeInlineNote(comment)) {
        return null;
    }

    if (isInlineNoteSubtype(subtype) || comment.source === 'shape') {
        return 'solid';
    }

    return null;
}

function inlineChipStyle(comment: IAnnotationCommentSummary) {
    return {'--note-item-chip-color': comment.color ?? 'currentcolor'};
}

function inlineChipAriaLabel(comment: IAnnotationCommentSummary) {
    return comment.color
        ? `${commentTypeLabel(comment)} ${comment.color}`
        : commentTypeLabel(comment);
}

function authorLabel(comment: IAnnotationCommentSummary) {
    const commentAuthor = comment.author?.trim();
    if (commentAuthor) {
        return commentAuthor;
    }
    const configuredAuthor = authorName.value?.trim();
    return configuredAuthor && configuredAuthor.length > 0
        ? configuredAuthor
        : t('annotations.unknownAuthor');
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

function commentTimeLabel(comment: IAnnotationCommentSummary) {
    const timestamp = getAnnotationCommentDisplayTimestamp(comment);
    return timestamp ? formatTime(timestamp) : '';
}

function focusComment(comment: IAnnotationCommentSummary) {
    emit('focus-comment', comment);
}

function openComment(comment: IAnnotationCommentSummary) {
    emit('focus-comment', comment);
    if (isNoteEligibleComment(comment)) {
        emit('open-note', comment);
    }
}

function deleteComment(comment: IAnnotationCommentSummary) {
    emit('delete-comment', comment);
}

function placeNote() {
    emit('place-note');
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
    gap: var(--app-sidebar-row-gap);
}

.notes-list-title {
    font-size: var(--app-sidebar-row-font-size);
    font-weight: 700;
    color: var(--ui-text-highlighted);
}

.notes-count {
    font-size: var(--app-sidebar-caption-font-size);
    color: var(--ui-text-muted);
}

.notes-header-btn {
    flex: 0 0 auto;
}

.notes-header-btn--place {
    margin-left: auto;
}

.notes-search {
    width: 100%;
}

.notes-list {
    flex: 1 1 0;
    min-height: var(--app-annotation-list-min-height);
    overflow: auto;
    gap: var(--app-sidebar-row-gap);
    padding-right: 0.1rem;
}

.note-item {
    position: relative;
    border: 1px solid var(--app-sidebar-border);
    border-radius: 0.55rem;
    background: color-mix(in oklab, var(--ui-bg) 70%, var(--ui-bg-muted) 30%);
    color: var(--ui-text-highlighted);
    text-align: left;
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    gap: var(--app-sidebar-row-gap);
    cursor: pointer;
    transition:
        background-color 0.12s ease,
        border-color 0.12s ease,
        box-shadow 0.12s ease;
    width: 100%;
    height: var(--app-annotation-editor-height);
    margin-bottom: var(--app-annotation-editor-margin);
    overflow: hidden;
}

.note-item:hover {
    border-color: var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg) 82%, var(--ui-bg-muted) 18%);
}

.note-item.is-active {
    border-color: var(--ui-primary);
    background: color-mix(in oklab, var(--ui-primary) 10%, var(--ui-bg) 90%);
    box-shadow:
        inset 3px 0 0 var(--ui-primary),
        0 0 0 1px color-mix(in oklab, var(--ui-primary) 35%, transparent);
}

.note-item-top {
    display: flex;
    align-items: center;
    gap: var(--app-sidebar-row-gap);
    flex-wrap: wrap;
    font-size: var(--app-sidebar-caption-font-size);
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
    width: var(--app-sidebar-action-size);
    height: var(--app-sidebar-action-size);
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--ui-text-muted);
    font-size: var(--app-sidebar-caption-font-size);
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
    font-size: var(--app-sidebar-row-font-size);
    line-height: 1.35;
    color: var(--ui-text-highlighted);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.note-item-shape-style {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: var(--app-sidebar-row-gap);
    color: var(--ui-text-highlighted);
}

.note-item-shape-stroke {
    flex: 0 0 2rem;
    height: clamp(0.12rem, var(--note-item-shape-stroke-width), 0.5rem);
    border-radius: 0.25rem;
    background: var(--note-item-shape-color);
    opacity: var(--note-item-shape-opacity);
}

.note-item-shape-style-text {
    min-width: 0;
    overflow: hidden;
    color: var(--ui-text-highlighted);
    font-size: var(--app-sidebar-row-font-size);
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.note-item-color-chip {
    --note-item-chip-color: currentcolor;

    display: inline-block;
    flex: 0 0 auto;
    margin-left: 0.1rem;
}

.note-item-color-chip--solid {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    border-radius: 0.18rem;
    background: var(--note-item-chip-color);
}

.note-item-text-mark {
    --note-item-marker-color: currentcolor;
}

.note-item-text-mark--highlight {
    background: color-mix(in srgb, var(--note-item-marker-color) 45%, transparent);
    border-radius: 0.15rem;
    padding: 0 var(--app-space-2xs);
    box-decoration-break: clone;
}

.note-item-text-mark--underline {
    text-decoration: underline;
    text-decoration-color: var(--note-item-marker-color);
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
}

.note-item-text-mark--strikeout {
    text-decoration: line-through;
    text-decoration-color: var(--note-item-marker-color);
    text-decoration-thickness: 1px;
}

.note-item-text-mark--squiggly {
    text-decoration: underline wavy;
    text-decoration-color: var(--note-item-marker-color);
    text-decoration-thickness: 0.75px;
    text-underline-offset: 3px;
}

.note-item-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-sidebar-row-gap);
    font-size: var(--app-sidebar-caption-font-size);
    color: var(--ui-text-toned);
}

.note-match {
    background: var(--app-pdf-search-result-highlight-bg);
    color: inherit;
    border-radius: 0.2rem;
    padding: 0;
}

.notes-loading-state {
    display: flex;
    flex-direction: column;
    gap: var(--app-sidebar-row-gap);
    padding: var(--app-sidebar-row-padding-block) var(--app-space-2xs);
}

.notes-loading-state span {
    display: block;
    height: var(--app-annotation-preview-height);
    border: 1px solid var(--ui-border);
    border-radius: 0.45rem;
    background: color-mix(in srgb, var(--ui-bg-muted) 70%, transparent);
}

</style>
