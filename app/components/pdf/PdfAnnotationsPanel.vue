<template>
    <div class="notes-panel">
        <PdfAnnotationToolbar
            :tool="tool"
            @set-tool="emit('set-tool', $event)"
        />

        <PdfAnnotationStyleEditor
            :tool="tool"
            :settings="settings"
            @set-tool="emit('set-tool', $event)"
            @update-setting="emit('update-setting', $event)"
        />

        <div class="notes-panel-divider" />

        <PdfAnnotationCommentsList
            :comments="comments"
            :active-comment-stable-key="activeCommentStableKey"
            :author-name="appSettings.authorName"
            @focus-comment="emit('focus-comment', $event)"
            @open-note="emit('open-note', $event)"
            @delete-comment="emit('delete-comment', $event)"
            @place-note="emit('place-note')"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import PdfAnnotationCommentsList from '@app/components/pdf/PdfAnnotationCommentsList.vue';

interface IProps {
    tool: TAnnotationTool;
    keepActive: boolean;
    settings: IAnnotationSettings;
    comments: IAnnotationCommentSummary[];
    currentPage: number;
    activeCommentStableKey?: string | null;
}

const { settings: appSettings } = useSettings();

defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
    (e: 'update:keep-active', value: boolean): void;
    (e: 'update-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }): void;
    (e: 'focus-comment', comment: IAnnotationCommentSummary): void;
    (e: 'open-note', comment: IAnnotationCommentSummary): void;
    (e: 'delete-comment', comment: IAnnotationCommentSummary): void;
    (e: 'place-note'): void;
}>();
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

.notes-panel-divider {
    border-top: 1px solid var(--ui-border);
    margin: 0 -0.25rem;
}
</style>
