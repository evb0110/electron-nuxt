<template>
    <div ref="treeRef" class="document-bookmark-tree app-scrollbar app-scroll-region--balanced">
        <DocumentBookmarkTreeItem
            v-for="item in items"
            :key="item.id"
            :item="item"
            :active-id="activeId"
            :display-mode="displayMode"
            :expanded-ids="expandedIds"
            :active-path-ids="activePathIds"
            @activate="emit('activate', $event)"
            @toggle-expand="emit('toggle-expand', $event)"
        />
    </div>
</template>

<script setup lang="ts">
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

watch(() => props.activeId, async (activeId) => {
    if (!activeId) {
        return;
    }
    await nextTick();
    const row = [...(treeRef.value?.querySelectorAll<HTMLElement>('[data-bookmark-id]') ?? [])]
        .find(element => element.dataset.bookmarkId === activeId);
    row?.scrollIntoView({block: 'nearest'});
}, {flush: 'post'});
</script>

<style scoped>
.document-bookmark-tree {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    user-select: none;
}
</style>
