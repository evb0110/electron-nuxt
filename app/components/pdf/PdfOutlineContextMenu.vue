<template>
    <PdfContextMenuBase
        class="bookmarks-context-menu"
        :visible="visible && Boolean(bookmark)"
        :style="menuStyle"
        variant="panel"
        min-width="210px"
        :z-index="1400"
    >
        <template v-if="bookmark">
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="emit('edit', bookmark.id)"
            >
                {{ t('bookmarks.editBookmark') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="emit('add-sibling-above', bookmark.id)"
            >
                {{ t('bookmarks.addSiblingAbove') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="emit('add-sibling-below', bookmark.id)"
            >
                {{ t('bookmarks.addSiblingBelow') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="emit('add-child', bookmark.id)"
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
                        @click="emit('toggle-bold', bookmark.id)"
                    >
                        <UIcon name="i-ph-text-b" class="bookmarks-style-toggle-icon" />
                    </button>
                    <button
                        type="button"
                        class="bookmarks-style-toggle"
                        :class="{ 'is-active': bookmark.italic }"
                        :aria-label="bookmark.italic ? t('bookmarks.disableItalic') : t('bookmarks.enableItalic')"
                        @click="emit('toggle-italic', bookmark.id)"
                    >
                        <UIcon name="i-ph-text-italic" class="bookmarks-style-toggle-icon" />
                    </button>
                    <button
                        type="button"
                        class="bookmarks-style-toggle"
                        :class="{ 'is-active': !bookmark.color }"
                        :aria-label="t('bookmarks.defaultColor')"
                        @click="emit('set-color', { id: bookmark.id, color: null })"
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
                        @click="emit('set-color', { id: bookmark.id, color: preset })"
                    />
                </div>
            </div>

            <div class="pdf-context-menu__divider" />
            <button
                type="button"
                class="pdf-context-menu__action"
                @click="emit('set-style-range-start', bookmark.id)"
            >
                {{ bookmark.id === styleRangeStartId ? t('bookmarks.rangeStartSet') : t('bookmarks.setStyleStart') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                :disabled="!canApplyStyleRange"
                @click="emit('apply-style-to-range')"
            >
                {{ applyStyleRangeLabel }}
            </button>

            <div class="pdf-context-menu__divider" />
            <button
                type="button"
                class="pdf-context-menu__action pdf-context-menu__action--danger"
                @click="emit('remove', bookmark.id)"
            >
                {{ t('bookmarks.removeBookmark') }}
            </button>
        </template>
    </PdfContextMenuBase>
</template>

<script setup lang="ts">
import PdfContextMenuBase from '@app/components/pdf/PdfContextMenuBase.vue';
import type { IBookmarkItem } from '@app/types/pdf-outline';
import { BOOKMARK_COLOR_PRESETS } from '@app/constants/pdf-colors';

interface IProps {
    visible: boolean;
    x: number;
    y: number;
    bookmark: IBookmarkItem | null;
    styleRangeStartId: string | null;
    canApplyStyleRange: boolean;
    applyStyleRangeLabel: string;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'edit', id: string): void;
    (e: 'add-sibling-above', id: string): void;
    (e: 'add-sibling-below', id: string): void;
    (e: 'add-child', id: string): void;
    (e: 'toggle-bold', id: string): void;
    (e: 'toggle-italic', id: string): void;
    (e: 'set-color', payload: {
        id: string;
        color: string | null 
    }): void;
    (e: 'set-style-range-start', id: string): void;
    (e: 'apply-style-to-range'): void;
    (e: 'remove', id: string): void;
}>();

const { t } = useTypedI18n();

const colorPresets = BOOKMARK_COLOR_PRESETS;

const menuStyle = computed(() => ({
    left: `${props.x}px`,
    top: `${props.y}px`,
}));
</script>

<style scoped>
.bookmarks-context-menu-style-block {
    padding: 3px 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.bookmarks-context-menu-style-row {
    display: flex;
    gap: 6px;
}

.bookmarks-style-toggle {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--ui-border);
    border-radius: 5px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}

.bookmarks-style-toggle-icon {
    width: 0.95rem;
    height: 0.95rem;
}

.bookmarks-style-toggle-letter {
    font-size: 0.9rem;
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
    gap: 6px;
}

.bookmarks-color-swatch {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--ui-bg-inverted) 16%, transparent 84%);
    cursor: pointer;
}

.bookmarks-color-swatch.is-active {
    border-color: var(--app-sidebar-bg);
    box-shadow: 0 0 0 1px var(--app-sidebar-bg), 0 0 0 3px var(--ui-text);
}
</style>
