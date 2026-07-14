<template>
    <div class="document-bookmarks-toolbar">
        <div class="document-bookmarks-toolbar__display" role="group" :aria-label="t('bookmarks.controls')">
            <AppTooltip v-for="option in displayModeOptions" :key="option.id" :text="option.title" :delay-duration="800">
                <button
                    type="button"
                    class="document-bookmarks-toolbar__button"
                    :class="{'is-active': displayMode === option.id}"
                    :aria-label="option.title"
                    :aria-pressed="displayMode === option.id"
                    @click="emit('set-display-mode', option.id)"
                ><UIcon :name="option.icon" class="size-3.5" /></button>
            </AppTooltip>
        </div>

        <div v-if="editable" class="document-bookmarks-toolbar__actions">
            <AppTooltip
                v-if="isEditMode && selectedDeleteCount > 0"
                :text="t('bookmarks.removeSelectedBookmarks', {count: selectedDeleteCount})"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="document-bookmarks-toolbar__button document-bookmarks-toolbar__button--danger"
                    :aria-label="t('bookmarks.removeSelectedBookmarks', {count: selectedDeleteCount})"
                    @click="emit('remove-selected-bookmarks')"
                ><UIcon name="i-ph-trash" class="size-3.5" /></button>
            </AppTooltip>
            <AppTooltip v-if="isEditMode" :text="t('bookmarks.addTopLevel')" :delay-duration="800">
                <button
                    type="button"
                    class="document-bookmarks-toolbar__button"
                    :aria-label="t('bookmarks.addTopLevel')"
                    @click="emit('add-root-bookmark')"
                ><UIcon name="i-ph-plus" class="size-3.5" /></button>
            </AppTooltip>
            <AppTooltip :text="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')" :delay-duration="800">
                <button
                    type="button"
                    class="document-bookmarks-toolbar__button"
                    :class="{'is-active': isEditMode}"
                    :aria-label="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                    :aria-pressed="isEditMode"
                    @click="emit('toggle-edit-mode')"
                ><UIcon :name="isEditMode ? 'i-ph-pencil-simple-line' : 'i-ph-pencil'" class="size-3.5" /></button>
            </AppTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TDocumentBookmarkDisplayMode } from '@app/utils/document-viewer/bookmarks/documentBookmarks';

const {
    displayMode,
    editable = false,
    isEditMode = false,
    selectedDeleteCount = 0,
} = defineProps<{
    displayMode: TDocumentBookmarkDisplayMode;
    editable?: boolean;
    isEditMode?: boolean;
    selectedDeleteCount?: number;
}>();
const emit = defineEmits<{
    'set-display-mode': [mode: TDocumentBookmarkDisplayMode];
    'toggle-edit-mode': [];
    'add-root-bookmark': [];
    'remove-selected-bookmarks': [];
}>();
const {t} = useTypedI18n();
const displayModeOptions = computed<Array<{
    id: TDocumentBookmarkDisplayMode;
    title: string;
    icon: string
}>>(() => [
    {
        id: 'top-level',
        title: t('bookmarks.topLevelOnly'),
        icon: 'i-ph-rows',
    },
    {
        id: 'all-expanded',
        title: t('bookmarks.expandAll'),
        icon: 'i-ph-tree-view',
    },
    {
        id: 'current-expanded',
        title: t('bookmarks.expandCurrentPath'),
        icon: 'i-ph-crosshair-simple',
    },
]);

</script>

<style scoped>
.document-bookmarks-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-3xl);
    padding: var(--app-space-lg) var(--app-space-3xl);
    border-bottom: 1px solid var(--app-sidebar-border);
}

.document-bookmarks-toolbar__display,
.document-bookmarks-toolbar__actions {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
    min-width: 0;
}

.document-bookmarks-toolbar__button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--app-outline-toolbar-button-size);
    height: var(--app-outline-toolbar-button-size);
    border: 1px solid transparent;
    border-radius: var(--app-radius-md);
    background: transparent;
    color: var(--ui-text-muted);
    cursor: pointer;
    transition: background-color var(--app-transition-quick), color var(--app-transition-quick), border-color var(--app-transition-quick);
}

.document-bookmarks-toolbar__button:hover {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

.document-bookmarks-toolbar__button.is-active {
    background: var(--app-control-active-bg);
    border-color: var(--app-control-active-border);
    color: var(--ui-text);
}

.document-bookmarks-toolbar__button--danger:hover {
    color: var(--ui-error);
}
</style>
