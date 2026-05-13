<template>
    <PdfContextMenuBase
        class="annotation-context-menu"
        :visible="menu.visible"
        :style="style"
        variant="grid"
        min-width="246px"
    >
        <template v-if="menu.comment">
            <p class="pdf-context-menu__section-title">
                <span
                    v-if="menu.comment.color"
                    class="annotation-context-menu-color-swatch"
                    :style="{ background: menu.comment.color }"
                />
                {{ annotationLabel }}
            </p>
            <button
                v-if="!isImageComment"
                type="button"
                class="pdf-context-menu__action"
                @click="openNote"
            >
                {{ t('contextMenu.openPopUpNote') }}
            </button>
            <button
                v-if="!isImageComment"
                type="button"
                class="pdf-context-menu__action"
                :disabled="!canCopy"
                @click="copyText"
            >
                {{ t('contextMenu.copyTextToClipboard') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action pdf-context-menu__action--danger"
                @click="deleteAnnotation"
            >
                {{ deleteLabel }}
            </button>
            <div class="pdf-context-menu__divider" />
        </template>

        <template v-if="menu.hasSelection">
            <p class="pdf-context-menu__section-title">
                {{ t('contextMenu.markupSelection') }}
            </p>
            <button
                type="button"
                class="pdf-context-menu__action"
                :disabled="!canCopySelection"
                @click="copySelectionText"
            >
                {{ t('contextMenu.copyTextToClipboard') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="markupHighlight"
            >
                {{ t('contextMenu.highlight') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="markupUnderline"
            >
                {{ t('contextMenu.underline') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="markupStrikethrough"
            >
                {{ t('contextMenu.strikethrough') }}
            </button>
            <div class="pdf-context-menu__divider" />
        </template>

        <p class="pdf-context-menu__section-title">
            {{ t('contextMenu.addNote') }}
        </p>
        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="!canCreateFree"
            @click="createFreeNote"
        >
            {{ t('contextMenu.addNoteHere') }}
        </button>
        <button
            v-if="menu.hasSelection"
            type="button"
            class="pdf-context-menu__action"
            @click="createSelectionNote"
        >
            {{ t('contextMenu.addNoteToSelection') }}
        </button>
        <div class="pdf-context-menu__divider" />
        <p class="pdf-context-menu__section-title">
            {{ t('contextMenu.insertImage') }}
        </p>
        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="!canInsertImage"
            @click="insertImageFromFile"
        >
            {{ t('contextMenu.insertImageFromFile') }}
        </button>
        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="!canInsertImage"
            @click="pasteImageFromClipboard"
        >
            {{ t('contextMenu.pasteImageFromClipboard') }}
        </button>
    </PdfContextMenuBase>
</template>

<script setup lang="ts">
import PdfContextMenuBase from '@app/components/pdf/PdfContextMenuBase.vue';
import type { TAnnotationTool } from '@app/types/annotations';

interface IContextMenuState {
    visible: boolean;
    comment: {
        stableKey: string;
        text: string;
        color?: string | null;
        source?: string;
    } | null;
    hasSelection: boolean;
    selectionText: string;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

defineProps<{
    menu: IContextMenuState;
    style: Record<string, string>;
    canCopy: boolean;
    canCopySelection: boolean;
    canCreateFree: boolean;
    canInsertImage: boolean;
    annotationLabel: string;
    deleteLabel: string;
    isImageComment?: boolean;
}>();

const emit = defineEmits<{
    'open-note': [];
    'copy-text': [];
    'copy-selection-text': [];
    'delete': [];
    'markup': [tool: TAnnotationTool];
    'create-free-note': [];
    'create-selection-note': [];
    'insert-image-from-file': [];
    'paste-image-from-clipboard': [];
}>();

const { t } = useTypedI18n();

function openNote() {
    emit('open-note');
}

function copyText() {
    emit('copy-text');
}

function copySelectionText() {
    emit('copy-selection-text');
}

function deleteAnnotation() {
    emit('delete');
}

function markupHighlight() {
    emit('markup', 'highlight');
}

function markupUnderline() {
    emit('markup', 'underline');
}

function markupStrikethrough() {
    emit('markup', 'strikethrough');
}

function createFreeNote() {
    emit('create-free-note');
}

function createSelectionNote() {
    emit('create-selection-note');
}

function insertImageFromFile() {
    emit('insert-image-from-file');
}

function pasteImageFromClipboard() {
    emit('paste-image-from-clipboard');
}
</script>

<style scoped>
.annotation-context-menu-color-swatch {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 2px;
    flex-shrink: 0;
    border: 1px solid var(--app-pdf-context-menu-swatch-border);
}
</style>
