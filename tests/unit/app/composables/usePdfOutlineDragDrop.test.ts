import {
    computed,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import { usePdfOutlineDragDrop } from '@app/composables/pdf/usePdfOutlineDragDrop';

function createBookmark(id: string): IBookmarkItem {
    return {
        id,
        title: id,
        dest: null,
        pageIndex: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

function createParentMap(items: IBookmarkItem[]) {
    const parents = new Map<string, string | null>();
    const visit = (bookmarkItems: IBookmarkItem[], parentId: string | null) => {
        bookmarkItems.forEach((item) => {
            parents.set(item.id, parentId);
            visit(item.items, item.id);
        });
    };
    visit(items, null);
    return parents;
}

function createOrderMap(items: IBookmarkItem[]) {
    const order = new Map<string, number>();
    let index = 0;
    const visit = (bookmarkItems: IBookmarkItem[]) => {
        bookmarkItems.forEach((item) => {
            order.set(item.id, index);
            index += 1;
            visit(item.items);
        });
    };
    visit(items);
    return order;
}

describe('usePdfOutlineDragDrop', () => {
    it('does not emit bookmark changes for no-op root-end drops', () => {
        const bookmarks = ref([
            createBookmark('first'),
            createBookmark('last'),
        ]);
        const selectedBookmarkIds = ref(new Set(['last']));
        const activeItemId = ref<string | null>('last');
        const emitBookmarksChange = vi.fn();

        const dragDrop = usePdfOutlineDragDrop(
            bookmarks,
            ref(new Set()),
            computed(() => true),
            selectedBookmarkIds,
            computed(() => createParentMap(bookmarks.value)),
            computed(() => createOrderMap(bookmarks.value)),
            vi.fn(),
            vi.fn(),
        );

        dragDrop.handleBookmarkDragStart({ id: 'last' });
        dragDrop.handleTreeEndDrop(activeItemId, emitBookmarksChange);

        expect(bookmarks.value.map(item => item.id)).toEqual([
            'first',
            'last',
        ]);
        expect(activeItemId.value).toBe('last');
        expect(emitBookmarksChange).not.toHaveBeenCalled();
        expect(dragDrop.draggingBookmarkIds.value.size).toBe(0);
    });
});
