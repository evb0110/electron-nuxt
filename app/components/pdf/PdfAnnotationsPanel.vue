<template>
    <div class="notes-panel">
        <PdfAnnotationToolbar
            :tool="tool"
            @set-tool="setTool"
        />

        <template v-if="showStyleEditor">
            <PdfAnnotationStyleEditor
                :tool="tool"
                :settings="settings"
                @set-tool="setTool"
                @update-setting="updateSetting"
            />

            <div class="notes-panel-divider" />
        </template>

        <PdfAnnotationCommentsList
            :comments="comments"
            :active-comment-stable-key="activeCommentStableKey"
            :author-name="appSettings.authorName"
            @focus-comment="focusComment"
            @open-note="openNote"
            @delete-comment="deleteComment"
            @place-note="placeNote"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import { isAuthoringAnnotationTool } from '@app/composables/pdf/annotations/annotationRules';
import PdfAnnotationCommentsList from '@app/components/pdf/PdfAnnotationCommentsList.vue';
import PdfAnnotationStyleEditor from '@app/components/pdf/PdfAnnotationStyleEditor.vue';
import PdfAnnotationToolbar from '@app/components/pdf/PdfAnnotationToolbar.vue';

interface IProps {
    tool: TAnnotationTool;
    keepActive: boolean;
    settings: IAnnotationSettings;
    comments: IAnnotationCommentSummary[];
    currentPage: number;
    activeCommentStableKey?: string | null;
}

const { settings: appSettings } = useSettings();

const {
    activeCommentStableKey = undefined,
    tool,
} = defineProps<IProps>();
const showStyleEditor = computed(() => isAuthoringAnnotationTool(tool));

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

function setTool(tool: TAnnotationTool) {
    emit('set-tool', tool);
}

function updateSetting(payload: {
    key: keyof IAnnotationSettings;
    value: IAnnotationSettings[keyof IAnnotationSettings];
}) {
    emit('update-setting', payload);
}

function focusComment(comment: IAnnotationCommentSummary) {
    emit('focus-comment', comment);
}

function openNote(comment: IAnnotationCommentSummary) {
    emit('open-note', comment);
}

function deleteComment(comment: IAnnotationCommentSummary) {
    emit('delete-comment', comment);
}

function placeNote() {
    emit('place-note');
}
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
