<template>
    <div class="notes-panel">
        <PdfAnnotationToolbar
            :tool="tool"
            :keep-active="keepActive"
            @set-tool="emit('set-tool', $event)"
            @update:keep-active="emit('update:keep-active', $event)"
        />

        <PdfAnnotationStyleEditor
            :tool="tool"
            :settings="settings"
            @set-tool="emit('set-tool', $event)"
            @update-setting="emit('update-setting', $event)"
        />

        <section v-if="pagesWithNotes.length > 0" class="notes-section notes-pages">
            <header class="notes-section-header">
                <h3 class="notes-section-title">{{ t('annotations.whereNotes') }}</h3>
                <p class="notes-section-description">{{ t('annotations.whereNotesDescription') }}</p>
            </header>

            <div class="page-chip-list">
                <button
                    v-for="item in pagesWithNotes"
                    :key="item.pageNumber"
                    type="button"
                    class="page-chip"
                    :class="{ 'is-current': item.pageNumber === currentPage }"
                    @click="focusFirstCommentOnPage(item.pageNumber)"
                >
                    <span class="page-chip-label">{{ t('annotations.page') }} {{ item.pageNumber }}</span>
                    <span class="page-chip-count">• {{ t('annotations.noteCount', item.noteCount) }}</span>
                </button>
            </div>
        </section>

        <PdfAnnotationCommentsList
            :comments="comments"
            :active-comment-stable-key="activeCommentStableKey"
            :author-name="appSettings.authorName"
            @focus-comment="emit('focus-comment', $event)"
            @open-note="emit('open-note', $event)"
            @copy-comment="emit('copy-comment', $event)"
            @delete-comment="emit('delete-comment', $event)"
        />
    </div>
</template>

<script setup lang="ts">
import {computed} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import PdfAnnotationCommentsList from '@app/components/pdf/PdfAnnotationCommentsList.vue';
import { isTextNoteComment } from '@app/utils/pdf-annotation-comments';

interface IProps {
    tool: TAnnotationTool;
    keepActive: boolean;
    settings: IAnnotationSettings;
    comments: IAnnotationCommentSummary[];
    currentPage: number;
    activeCommentStableKey?: string | null;
}

interface IPageAnnotationOverview {
    pageNumber: number;
    noteCount: number;
}

const { t } = useTypedI18n();
const { settings: appSettings } = useSettings();

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
    (e: 'update:keep-active', value: boolean): void;
    (e: 'update-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }): void;
    (e: 'focus-comment', comment: IAnnotationCommentSummary): void;
    (e: 'open-note', comment: IAnnotationCommentSummary): void;
    (e: 'copy-comment', comment: IAnnotationCommentSummary): void;
    (e: 'delete-comment', comment: IAnnotationCommentSummary): void;
}>();

const currentPage = computed(() => props.currentPage);
const noteComments = computed(() => props.comments.filter(isTextNoteComment));

function focusFirstCommentOnPage(pageNumber: number) {
    const comment = noteComments.value.find(item => item.pageNumber === pageNumber);
    if (!comment) {
        return;
    }
    emit('focus-comment', comment);
}

const pagesWithNotes = computed<IPageAnnotationOverview[]>(() => {
    const map = new Map<number, IPageAnnotationOverview>();

    noteComments.value.forEach((comment) => {
        const current = map.get(comment.pageNumber);
        if (current) {
            current.noteCount += 1;
            return;
        }

        map.set(comment.pageNumber, {
            pageNumber: comment.pageNumber,
            noteCount: 1,
        });
    });

    return Array
        .from(map.values())
        .sort((left, right) => left.pageNumber - right.pageNumber);
});
</script>

<style scoped>
.notes-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    min-height: 100%;
    overflow: visible;
    box-sizing: border-box;
    position: relative;
}

.notes-section {
    border: 1px solid var(--app-notes-section-border);
    border-radius: var(--app-notes-section-radius);
    background: var(--app-notes-section-bg);
    padding: var(--app-notes-section-padding);
    display: flex;
    flex-direction: column;
    gap: var(--app-notes-section-gap);
    box-shadow: var(--app-notes-section-shadow);
}

.notes-section-header {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.notes-section-title {
    margin: 0;
    font-size: var(--app-notes-section-title-size);
    line-height: var(--app-notes-section-title-line-height);
    letter-spacing: var(--app-notes-section-title-letter-spacing);
    text-transform: uppercase;
    color: var(--app-notes-section-title-color);
}

.notes-section-description {
    margin: 0;
    font-size: var(--app-notes-section-description-size);
    line-height: var(--app-notes-section-description-line-height);
    color: var(--app-notes-section-description-color);
}

.page-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
}

.page-chip {
    border: 1px solid var(--ui-border);
    border-radius: 999px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.76rem;
    padding: 0.22rem 0.55rem;
    cursor: pointer;
}

.page-chip.is-current {
    border-color: color-mix(in srgb, var(--ui-primary) 70%, var(--ui-border) 30%);
    color: var(--ui-text-highlighted);
}

.page-chip-label {
    font-weight: 600;
}

.page-chip-count {
    color: var(--ui-text-toned);
}
</style>
