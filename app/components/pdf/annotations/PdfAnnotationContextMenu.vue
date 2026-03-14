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
                @click="emit('open-note')"
            >
                {{ t('contextMenu.openPopUpNote') }}
            </button>
            <button
                v-if="!isImageComment"
                type="button"
                class="pdf-context-menu__action"
                :disabled="!canCopy"
                @click="emit('copy-text')"
            >
                {{ t('contextMenu.copyTextToClipboard') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action pdf-context-menu__action--danger"
                @click="emit('delete')"
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
                @click="emit('copy-selection-text')"
            >
                {{ t('contextMenu.copyTextToClipboard') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="emit('markup', 'highlight')"
            >
                {{ t('contextMenu.highlight') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="emit('markup', 'underline')"
            >
                {{ t('contextMenu.underline') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="emit('markup', 'strikethrough')"
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
            @click="emit('create-free-note')"
        >
            {{ t('contextMenu.addNoteHere') }}
        </button>
        <button
            v-if="menu.hasSelection"
            type="button"
            class="pdf-context-menu__action"
            @click="emit('create-selection-note')"
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
            @click="emit('insert-image-from-file')"
        >
            {{ t('contextMenu.insertImageFromFile') }}
        </button>
        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="!canInsertImage"
            @click="emit('paste-image-from-clipboard')"
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
