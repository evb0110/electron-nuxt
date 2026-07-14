<template>
    <div class="document-bookmark-item">
        <div
            class="document-bookmark-item__row"
            :class="{'is-active': activeId === item.id}"
            :data-bookmark-id="item.id"
            tabindex="0"
            role="button"
            :aria-current="activeId === item.id ? 'location' : undefined"
            @click="emit('activate', item.id)"
            @keydown.enter.prevent="emit('activate', item.id)"
            @keydown.space.prevent="emit('activate', item.id)"
        >
            <AppTooltip v-if="item.children.length > 0" :text="isExpanded ? t('bookmarks.collapse') : t('bookmarks.expand')" :delay-duration="800">
                <button
                    type="button"
                    class="document-bookmark-item__toggle"
                    :aria-label="isExpanded ? t('bookmarks.collapse') : t('bookmarks.expand')"
                    :aria-expanded="isExpanded"
                    @click.stop="emit('toggle-expand', item.id)"
                ><UIcon :name="isExpanded ? 'i-ph-caret-down' : 'i-ph-caret-right'" class="size-4" /></button>
            </AppTooltip>
            <span v-else class="document-bookmark-item__spacer" />
            <AppTooltip :text="item.title || t('bookmarks.untitled')" :delay-duration="800">
                <span class="document-bookmark-item__title" :style="titleStyle">{{ item.title || t('bookmarks.untitled') }}</span>
            </AppTooltip>
        </div>
        <div v-if="item.children.length > 0 && isExpanded" class="document-bookmark-item__children">
            <DocumentBookmarkTreeItem
                v-for="child in item.children"
                :key="child.id"
                :item="child"
                :active-id="activeId"
                :display-mode="displayMode"
                :expanded-ids="expandedIds"
                :active-path-ids="activePathIds"
                @activate="emit('activate', $event)"
                @toggle-expand="emit('toggle-expand', $event)"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    IDocumentBookmarkTreeItem,
    TDocumentBookmarkDisplayMode,
} from '@app/utils/document-viewer/bookmarks/documentBookmarks';

const props = defineProps<{
    item: IDocumentBookmarkTreeItem;
    activeId: string | null;
    displayMode: TDocumentBookmarkDisplayMode;
    expandedIds: ReadonlySet<string>;
    activePathIds: ReadonlySet<string>;
}>();
const emit = defineEmits<{
    activate: [id: string];
    'toggle-expand': [id: string];
}>();
const {t} = useTypedI18n();
const isExpanded = computed(() => {
    if (props.displayMode === 'all-expanded') {
        return true;
    }
    if (props.displayMode === 'current-expanded') {
        return props.activePathIds.has(props.item.id);
    }
    return props.expandedIds.has(props.item.id);
});
const titleStyle = computed(() => ({
    color: props.item.color ?? undefined,
    fontWeight: props.item.bold ? '600' : '500',
    fontStyle: props.item.italic ? 'italic' : 'normal',
}));

</script>

<style scoped>
.document-bookmark-item__row {
    display: flex;
    align-items: center;
    gap: var(--app-sidebar-row-gap);
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    border: 1px solid transparent;
    border-radius: var(--app-outline-row-radius);
    cursor: pointer;
    user-select: none;
    outline: none;
    transition: background-color 0.15s, border-color 0.15s, color 0.15s;
}

.document-bookmark-item__row:hover {
    background: var(--app-sidebar-control-hover-bg);
}

.document-bookmark-item__row:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary) 35%, transparent 65%);
}

.document-bookmark-item__row.is-active {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
    color: var(--ui-text);
}

.document-bookmark-item__toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: var(--app-sidebar-action-size);
    height: var(--app-sidebar-action-size);
    padding: 0;
    border: none;
    border-radius: var(--app-outline-action-radius);
    background: none;
    color: var(--ui-text-muted);
    cursor: pointer;
}

.document-bookmark-item__toggle:hover {
    background: var(--ui-bg-elevated);
}

.document-bookmark-item__spacer {
    width: var(--app-sidebar-action-size);
    flex-shrink: 0;
}

.document-bookmark-item__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--app-sidebar-row-font-size);
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.document-bookmark-item__children { padding-inline-start: var(--app-sidebar-outline-depth-indent); }
</style>
