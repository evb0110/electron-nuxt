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
                v-if="canOpenNote && !isImageComment"
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
            <div
                v-if="canEditColor"
                class="annotation-context-menu-color-row"
            >
                <span class="annotation-context-menu-color-label">{{ t('annotationProperties.color') }}</span>
                <div class="annotation-context-menu-color-swatches">
                    <button
                        v-for="swatch in ANNOTATION_COLOR_SWATCHES"
                        :key="swatch"
                        type="button"
                        class="annotation-context-menu-color-button"
                        :class="{ 'is-active': normalizeColorValue(swatch) === normalizeColorValue(editableColor) }"
                        :style="{ backgroundColor: swatch }"
                        :aria-label="swatch"
                        :aria-pressed="normalizeColorValue(swatch) === normalizeColorValue(editableColor)"
                        @click="updateColor(swatch)"
                    />
                </div>
            </div>
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
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="markupSquiggly"
            >
                {{ t('contextMenu.squiggly') }}
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
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { parseCssRgbColor } from '@app/utils/pdf-viewer/text-markup-color/parseCssRgbColor';
import { rgbToHex } from '@app/utils/pdf-viewer/text-markup-color/rgbToHex';

interface IContextMenuState {
    visible: boolean;
    comment: {
        stableKey: string;
        text: string;
        color?: string | null;
        hasNote?: boolean | undefined;
        source?: string | undefined;
        subtype?: string | null | undefined;
    } | null;
    hasSelection: boolean;
    selectionText: string;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

const props = defineProps<{
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
    'update-color': [color: string];
    'markup': [tool: TAnnotationTool];
    'create-free-note': [];
    'create-selection-note': [];
    'insert-image-from-file': [];
    'paste-image-from-clipboard': [];
}>();

const { t } = useTypedI18n();

const EDITABLE_COLOR_SUBTYPES = new Set([
    'highlight',
    'underline',
    'strikeout',
    'strikethrough',
    'squiggly',
]);

function getFallbackColorForSubtype(subtype: string | null | undefined) {
    const normalizedSubtype = subtype?.trim().toLowerCase() ?? '';
    if (normalizedSubtype === 'underline') {
        return DEFAULT_ANNOTATION_SETTINGS.underlineColor;
    }
    if (normalizedSubtype === 'strikeout' || normalizedSubtype === 'strikethrough') {
        return DEFAULT_ANNOTATION_SETTINGS.strikethroughColor;
    }
    if (normalizedSubtype === 'squiggly') {
        return DEFAULT_ANNOTATION_SETTINGS.squigglyColor;
    }
    return DEFAULT_ANNOTATION_SETTINGS.highlightColor;
}

const canOpenNote = computed(() => {
    const comment = props.menu.comment;
    if (!comment) {
        return false;
    }
    const subtype = comment.subtype?.trim().toLowerCase() ?? '';
    return comment.text.trim().length > 0
        || comment.hasNote === true
        || subtype === 'text'
        || subtype === 'note-linked'
        || subtype === 'note-inline'
        || subtype.includes('popup')
        || subtype.includes('note');
});

function normalizeColorInputValue(
    color: string | null | undefined,
    subtype: string | null | undefined,
) {
    const value = color?.trim() ?? '';
    const parsed = parseCssRgbColor(value);
    if (parsed) {
        return rgbToHex(parsed);
    }
    const match = /^#(?<hex>[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
    const hex = match?.groups?.hex;
    if (!hex) {
        return getFallbackColorForSubtype(subtype);
    }
    return hex.length === 3
        ? `#${hex.split('').map(channel => channel + channel).join('')}`
        : `#${hex}`;
}

const canEditColor = computed(() => {
    const subtype = props.menu.comment?.subtype?.trim().toLowerCase() ?? '';
    return EDITABLE_COLOR_SUBTYPES.has(subtype);
});

const editableColor = computed(() => normalizeColorInputValue(
    props.menu.comment?.color,
    props.menu.comment?.subtype,
));

function normalizeColorValue(color: string | null | undefined) {
    return color?.trim().toLowerCase() ?? '';
}

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

function updateColor(color: string) {
    emit('update-color', color);
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

function markupSquiggly() {
    emit('markup', 'squiggly');
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

.annotation-context-menu-color-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.45rem;
    padding: 0.55rem 0.75rem 0.65rem;
    border-top: 1px solid var(--ui-border);
}

.annotation-context-menu-color-label {
    color: var(--ui-text);
}

.annotation-context-menu-color-swatches {
    display: grid;
    grid-template-columns: repeat(9, 1.35rem);
    gap: 0.3rem;
}

.annotation-context-menu-color-button {
    width: 1.35rem;
    height: 1.35rem;
    padding: 0;
    border: 1px solid color-mix(in oklab, var(--app-pdf-color-swatch-border) 45%, transparent);
    border-radius: 0.3rem;
    cursor: pointer;
}

.annotation-context-menu-color-button.is-active {
    border-color: var(--app-sidebar-bg);
    box-shadow:
        0 0 0 1px var(--app-sidebar-bg),
        0 0 0 3px var(--ui-text);
}
</style>
