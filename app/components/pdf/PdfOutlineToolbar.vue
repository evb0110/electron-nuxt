<template>
    <div class="pdf-bookmarks-toolbar">
        <div
            class="pdf-bookmarks-view-modes"
            role="group"
            :aria-label="t('bookmarks.controls')"
        >
            <AppTooltip
                v-for="option in displayModeOptions"
                :key="option.id"
                :text="option.title"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="pdf-bookmarks-view-mode-button"
                    :class="{ 'is-active': displayMode === option.id }"
                    :aria-label="option.title"
                    @click="setDisplayMode(option.id)"
                >
                    <UIcon
                        :name="option.icon"
                        class="size-4"
                    />
                </button>
            </AppTooltip>
            <AppTooltip
                :text="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="pdf-bookmarks-view-mode-button"
                    :class="{ 'is-active': isEditMode }"
                    :aria-label="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                    @click="toggleEditMode"
                >
                    <UIcon
                        :name="isEditMode ? 'i-ph-pencil-simple-line' : 'i-ph-pencil'"
                        class="size-4"
                    />
                </button>
            </AppTooltip>
        </div>

        <div class="pdf-bookmarks-toolbar-actions">
            <AppTooltip
                v-if="isEditMode"
                :text="t('bookmarks.addTopLevel')"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="pdf-bookmarks-icon-button"
                    :aria-label="t('bookmarks.addTopLevel')"
                    @click="addRootBookmark"
                >
                    <UIcon
                        name="i-ph-plus"
                        class="size-4"
                    />
                </button>
            </AppTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TBookmarkDisplayMode } from '@app/types/pdfOutline';

interface IProps {
    displayMode: TBookmarkDisplayMode;
    isEditMode: boolean;
}

defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-display-mode', mode: TBookmarkDisplayMode): void;
    (e: 'toggle-edit-mode'): void;
    (e: 'add-root-bookmark'): void;
}>();

const { t } = useTypedI18n();

const displayModeOptions = computed<Array<{
    id: TBookmarkDisplayMode;
    title: string;
    icon: string;
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

function setDisplayMode(mode: TBookmarkDisplayMode) {
    emit('set-display-mode', mode);
}

function toggleEditMode() {
    emit('toggle-edit-mode');
}

function addRootBookmark() {
    emit('add-root-bookmark');
}
</script>

<style scoped>
.pdf-bookmarks-toolbar {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--app-sidebar-border);
}

.pdf-bookmarks-view-modes {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
}

.pdf-bookmarks-view-mode-button,
.pdf-bookmarks-icon-button {
    border: 1px solid transparent;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--ui-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--app-outline-toolbar-button-size, 1.75rem);
    height: var(--app-outline-toolbar-button-size, 1.75rem);
    cursor: pointer;
}

.pdf-bookmarks-view-mode-button:hover,
.pdf-bookmarks-icon-button:hover {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

.pdf-bookmarks-view-mode-button.is-active {
    border-color: var(--app-control-active-border);
    color: var(--ui-text);
    background: var(--app-control-active-bg);
}

.pdf-bookmarks-toolbar-actions {
    display: inline-flex;
    gap: 0.25rem;
}

@media (width <= 780px) {
    .pdf-bookmarks-toolbar {
        grid-template-columns: 1fr;
    }

    .pdf-bookmarks-toolbar-actions {
        justify-content: flex-end;
    }
}
</style>
