<template>
    <div ref="treeRef" class="document-bookmark-tree">
        <div
            v-bind="containerProps"
            class="document-bookmark-tree__list app-scrollbar app-scroll-region--balanced"
        >
            <div v-bind="wrapperProps">
                <DocumentBookmarkTreeItem
                    v-for="row in virtualRows"
                    :key="row.data.item.id"
                    :item="row.data.item"
                    :depth="row.data.depth"
                    :is-expanded="row.data.isExpanded"
                    :is-active="row.data.item.id === activeId"
                    @activate="emit('activate', $event)"
                    @toggle-expand="emit('toggle-expand', $event)"
                />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import {useVirtualList} from '@vueuse/core';
import type {
    IDocumentBookmarkTreeItem,
    TDocumentBookmarkDisplayMode,
} from '@app/utils/document-viewer/bookmarks/documentBookmarks';
import DocumentBookmarkTreeItem from '@app/components/document-viewer/DocumentBookmarkTreeItem.vue';

const props = defineProps<{
    items: readonly IDocumentBookmarkTreeItem[];
    activeId: string | null;
    displayMode: TDocumentBookmarkDisplayMode;
    expandedIds: ReadonlySet<string>;
    activePathIds: ReadonlySet<string>;
}>();
const emit = defineEmits<{
    activate: [id: string];
    'toggle-expand': [id: string];
}>();
const treeRef = ref<HTMLElement | null>(null);

interface IDocumentBookmarkVisibleRow {
    item: IDocumentBookmarkTreeItem;
    depth: number;
    isExpanded: boolean;
}

// Must match the fixed row height in DocumentBookmarkTreeItem.vue.
const BOOKMARK_ROW_HEIGHT_PX = 42;

function isItemExpanded(item: IDocumentBookmarkTreeItem) {
    if (props.displayMode === 'all-expanded') {
        return true;
    }
    if (props.displayMode === 'current-expanded') {
        return props.activePathIds.has(item.id);
    }
    return props.expandedIds.has(item.id);
}

const visibleRows = computed<IDocumentBookmarkVisibleRow[]>(() => {
    const rows: IDocumentBookmarkVisibleRow[] = [];
    const stack = props.items.toReversed().map(item => ({
        item,
        depth: 0,
    }));
    while (stack.length > 0) {
        const {
            item,
            depth,
        } = stack.pop()!;
        const isExpanded = item.children.length > 0 && isItemExpanded(item);
        rows.push({
            item,
            depth,
            isExpanded,
        });
        if (isExpanded) {
            for (let index = item.children.length - 1; index >= 0; index -= 1) {
                stack.push({
                    item: item.children[index]!,
                    depth: depth + 1,
                });
            }
        }
    }
    return rows;
});

const {
    list: virtualRows,
    containerProps,
    wrapperProps,
    scrollTo: scrollToRow,
} = useVirtualList(visibleRows, {
    itemHeight: BOOKMARK_ROW_HEIGHT_PX,
    overscan: 12,
});

watch(() => props.activeId, async (activeId) => {
    if (!activeId) {
        return;
    }
    await nextTick();
    const renderedRow = treeRef.value
        ?.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(activeId)}"]`);
    if (renderedRow) {
        renderedRow.scrollIntoView({block: 'nearest'});
        return;
    }
    const rowIndex = visibleRows.value.findIndex(row => row.item.id === activeId);
    if (rowIndex >= 0) {
        scrollToRow(rowIndex);
    }
}, {flush: 'post'});
</script>

<style scoped>
.document-bookmark-tree {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    user-select: none;
}

.document-bookmark-tree__list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
}
</style>
