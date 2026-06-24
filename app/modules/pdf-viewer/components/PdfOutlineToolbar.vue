<template>
    <div class="pdf-bookmarks-toolbar">
        <div
            class="pdf-bookmarks-display-segment"
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
                    class="pdf-bookmarks-segment-button"
                    :class="{ 'is-active': displayMode === option.id }"
                    :aria-label="option.title"
                    :aria-pressed="displayMode === option.id"
                    @click="setDisplayMode(option.id)"
                >
                    <UIcon
                        :name="option.icon"
                        class="size-3.5"
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
                        class="size-3.5"
                    />
                </button>
            </AppTooltip>
            <AppTooltip
                :text="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="pdf-bookmarks-icon-button"
                    :class="{ 'is-active': isEditMode }"
                    :aria-label="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                    :aria-pressed="isEditMode"
                    @click="toggleEditMode"
                >
                    <UIcon
                        :name="isEditMode ? 'i-ph-pencil-simple-line' : 'i-ph-pencil'"
                        class="size-3.5"
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
    'set-display-mode': [mode: TBookmarkDisplayMode];
    'toggle-edit-mode': [];
    'add-root-bookmark': [];
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-3xl);
    padding: var(--app-space-lg) var(--app-space-3xl);
    border-bottom: 1px solid var(--app-sidebar-border);
}

.pdf-bookmarks-display-segment {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
    min-width: 0;
}

.pdf-bookmarks-toolbar-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
}

.pdf-bookmarks-segment-button,
.pdf-bookmarks-icon-button {
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
    transition:
        background-color var(--app-transition-quick),
        color var(--app-transition-quick),
        border-color var(--app-transition-quick);
}

.pdf-bookmarks-segment-button:hover,
.pdf-bookmarks-icon-button:hover {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

.pdf-bookmarks-segment-button.is-active,
.pdf-bookmarks-icon-button.is-active {
    background: var(--app-control-active-bg);
    border-color: var(--app-control-active-border);
    color: var(--ui-text);
}
</style>
