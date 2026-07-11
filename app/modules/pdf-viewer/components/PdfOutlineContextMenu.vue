<template>
    <PdfContextMenuBase
        class="bookmarks-context-menu"
        :visible="visible && Boolean(bookmark)"
        :style="menuStyle"
        variant="panel"
        min-width="var(--app-context-menu-preferred-width)"
        z-index="var(--app-pdf-annotation-style-popover-z-index)"
    >
        <template v-if="bookmark">
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="editBookmark(bookmark.id)"
            >
                {{ t('bookmarks.editBookmark') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="addSiblingAbove(bookmark.id)"
            >
                {{ t('bookmarks.addSiblingAbove') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="addSiblingBelow(bookmark.id)"
            >
                {{ t('bookmarks.addSiblingBelow') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="addChild(bookmark.id)"
            >
                {{ t('bookmarks.addChild') }}
            </button>
            <div class="pdf-context-menu__divider" />

            <div class="bookmarks-context-menu-style-block">
                <div class="bookmarks-context-menu-style-row">
                    <button
                        type="button"
                        class="bookmarks-style-toggle"
                        :class="{ 'is-active': bookmark.bold }"
                        :aria-label="bookmark.bold ? t('bookmarks.disableBold') : t('bookmarks.enableBold')"
                        @click="toggleBold(bookmark.id)"
                    >
                        <UIcon name="i-ph-text-b" class="bookmarks-style-toggle-icon" />
                    </button>
                    <button
                        type="button"
                        class="bookmarks-style-toggle"
                        :class="{ 'is-active': bookmark.italic }"
                        :aria-label="bookmark.italic ? t('bookmarks.disableItalic') : t('bookmarks.enableItalic')"
                        @click="toggleItalic(bookmark.id)"
                    >
                        <UIcon name="i-ph-text-italic" class="bookmarks-style-toggle-icon" />
                    </button>
                    <button
                        type="button"
                        class="bookmarks-style-toggle"
                        :class="{ 'is-active': !bookmark.color }"
                        :aria-label="t('bookmarks.defaultColor')"
                        @click="setColor(bookmark.id, null)"
                    >
                        <span class="bookmarks-style-toggle-letter">A</span>
                    </button>
                </div>
                <div class="bookmarks-context-menu-color-row">
                    <button
                        v-for="preset in colorPresets"
                        :key="preset"
                        type="button"
                        class="bookmarks-color-swatch"
                        :class="{ 'is-active': bookmark.color === preset }"
                        :style="{ background: preset }"
                        :aria-label="t('bookmarks.setColor', { color: preset })"
                        @click="setColor(bookmark.id, preset)"
                    />
                </div>
            </div>

            <div class="pdf-context-menu__divider" />
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="setStyleRangeStart(bookmark.id)"
            >
                {{ bookmark.id === styleRangeStartId ? t('bookmarks.rangeStartSet') : t('bookmarks.setStyleStart') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                :disabled="!canApplyStyleRange"
                @click="applyStyleToRange"
            >
                {{ applyStyleRangeLabel }}
            </button>

            <div class="pdf-context-menu__divider" />
            <button
                type="button"
                class="pdf-context-menu__action pdf-context-menu__action--danger"
                @click="removeBookmark(bookmark.id)"
            >
                {{ removeLabel }}
            </button>
        </template>
    </PdfContextMenuBase>
</template>

<script setup lang="ts">
import PdfContextMenuBase from '@app/modules/pdf-viewer/components/PdfContextMenuBase.vue';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import { BOOKMARK_COLOR_PRESETS } from '@app/constants/pdfColors';

interface IProps {
    visible: boolean;
    x: number;
    y: number;
    bookmark: IBookmarkItem | null;
    styleRangeStartId: string | null;
    canApplyStyleRange: boolean;
    applyStyleRangeLabel: string;
    removeLabel: string;
}

const {
    x,
    y,
} = defineProps<IProps>();

const emit = defineEmits<{
    edit: [id: string];
    'add-sibling-above': [id: string];
    'add-sibling-below': [id: string];
    'add-child': [id: string];
    'toggle-bold': [id: string];
    'toggle-italic': [id: string];
    'set-color': [payload: {
        id: string;
        color: string | null 
    }];
    'set-style-range-start': [id: string];
    'apply-style-to-range': [];
    remove: [id: string];
}>();

const { t } = useTypedI18n();

const colorPresets = BOOKMARK_COLOR_PRESETS;

const menuStyle = computed(() => ({
    left: `${x}px`,
    top: `${y}px`,
}));

function editBookmark(id: string) {
    emit('edit', id);
}

function addSiblingAbove(id: string) {
    emit('add-sibling-above', id);
}

function addSiblingBelow(id: string) {
    emit('add-sibling-below', id);
}

function addChild(id: string) {
    emit('add-child', id);
}

function toggleBold(id: string) {
    emit('toggle-bold', id);
}

function toggleItalic(id: string) {
    emit('toggle-italic', id);
}

function setColor(id: string, color: string | null) {
    emit('set-color', {
        id,
        color,
    });
}

function setStyleRangeStart(id: string) {
    emit('set-style-range-start', id);
}

function applyStyleToRange() {
    emit('apply-style-to-range');
}

function removeBookmark(id: string) {
    emit('remove', id);
}
</script>

<style scoped>
.bookmarks-context-menu-style-block {
    padding: var(--app-space-xs) var(--app-space-sm);
    display: flex;
    flex-direction: column;
    gap: var(--app-space-lg);
}

.bookmarks-context-menu-style-row {
    display: flex;
    gap: var(--app-space-lg);
}

.bookmarks-style-toggle {
    width: var(--app-control-height-xs);
    height: var(--app-control-height-xs);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-sm);
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-weight: 700;
    cursor: pointer;
}

.bookmarks-style-toggle-icon {
    width: 0.95rem;
    height: 0.95rem;
}

.bookmarks-style-toggle-letter {
    font-size: var(--app-text-size-ui);
    font-weight: 600;
}

.bookmarks-style-toggle:nth-child(2) {
    font-style: italic;
}

.bookmarks-style-toggle.is-active {
    border-color: var(--app-control-active-border);
    color: var(--ui-text-highlighted);
    background: var(--app-control-active-bg);
}

.bookmarks-context-menu-color-row {
    display: flex;
    gap: var(--app-space-lg);
}

.bookmarks-color-swatch {
    width: var(--app-outline-loading-icon-height);
    height: var(--app-outline-loading-icon-height);
    border-radius: var(--app-radius-full);
    border: 1px solid color-mix(in srgb, var(--ui-bg-inverted) 16%, transparent 84%);
    cursor: pointer;
}

.bookmarks-color-swatch.is-active {
    border-color: var(--app-sidebar-bg);
    box-shadow: 0 0 0 1px var(--app-sidebar-bg), 0 0 0 3px var(--ui-text);
}
</style>
