import {
    computed,
    ref,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import { usePdfOutlineEditing } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineEditing';

function createBookmark(id: string, items: IBookmarkItem[] = []): IBookmarkItem {
    return {
        id,
        title: id,
        dest: null,
        pageIndex: null,
        bold: false,
        italic: false,
        color: null,
        items,
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

function createEditingHarness(initialBookmarks: IBookmarkItem[]) {
    const bookmarks = ref(initialBookmarks);
    const activeItemId = ref<string | null>(null);
    const expandedBookmarkIds = ref(new Set<string>());
    const selectedBookmarkIds = ref(new Set<string>());
    const selectionAnchorBookmarkId = ref<string | null>(null);
    const styleRangeStartId = ref<string | null>(null);
    const draggingBookmarkIds = ref(new Set<string>());
    const emitBookmarksChange = vi.fn();

    const editing = usePdfOutlineEditing(
        bookmarks,
        activeItemId,
        expandedBookmarkIds,
        ref('top-level'),
        computed(() => true),
        computed(() => createParentMap(bookmarks.value)),
        computed(() => createOrderMap(bookmarks.value)),
        selectedBookmarkIds,
        selectionAnchorBookmarkId,
        styleRangeStartId,
        draggingBookmarkIds,
        vi.fn((id: string) => {
            selectedBookmarkIds.value = new Set([id]);
            selectionAnchorBookmarkId.value = id;
        }),
        vi.fn(),
        vi.fn(() => {
            draggingBookmarkIds.value = new Set();
        }),
        ref(1),
        emitBookmarksChange,
        vi.fn(() => 'new-bookmark'),
    );

    return {
        bookmarks,
        activeItemId,
        expandedBookmarkIds,
        selectedBookmarkIds,
        selectionAnchorBookmarkId,
        styleRangeStartId,
        draggingBookmarkIds,
        emitBookmarksChange,
        editing,
    };
}

describe('usePdfOutlineEditing', () => {
    beforeEach(() => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
    });

    it('removes selected sibling bookmarks in one edit', () => {
        const harness = createEditingHarness([
            createBookmark('first'),
            createBookmark('second'),
            createBookmark('third'),
        ]);
        harness.activeItemId.value = 'first';
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'third',
        ]);

        harness.editing.removeSelectedBookmarks();

        expect(harness.bookmarks.value.map(item => item.id)).toEqual(['second']);
        expect(harness.activeItemId.value).toBe('second');
        expect(harness.selectedBookmarkIds.value.size).toBe(0);
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });

    it('removes a selected parent only once when its child is also selected', () => {
        const harness = createEditingHarness([
            createBookmark('parent', [createBookmark('child')]),
            createBookmark('sibling'),
        ]);
        harness.activeItemId.value = 'child';
        harness.expandedBookmarkIds.value = new Set(['parent']);
        harness.selectedBookmarkIds.value = new Set([
            'parent',
            'child',
        ]);
        harness.selectionAnchorBookmarkId.value = 'child';

        harness.editing.removeSelectedBookmarks();

        expect(harness.bookmarks.value.map(item => item.id)).toEqual(['sibling']);
        expect(harness.activeItemId.value).toBe('sibling');
        expect(harness.expandedBookmarkIds.value.size).toBe(0);
        expect(harness.selectedBookmarkIds.value.size).toBe(0);
        expect(harness.selectionAnchorBookmarkId.value).toBeNull();
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });

    it('keeps an existing batch selection when removing an unselected bookmark', () => {
        const harness = createEditingHarness([
            createBookmark('first'),
            createBookmark('second'),
            createBookmark('third'),
        ]);
        harness.activeItemId.value = 'third';
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'second',
        ]);

        harness.editing.removeBookmark('third');

        expect(harness.bookmarks.value.map(item => item.id)).toEqual([
            'first',
            'second',
        ]);
        expect(harness.activeItemId.value).toBe('second');
        expect([...harness.selectedBookmarkIds.value]).toEqual([
            'first',
            'second',
        ]);
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });

    it('removes the selected roots from a selected context bookmark', () => {
        const harness = createEditingHarness([
            createBookmark('first'),
            createBookmark('second'),
            createBookmark('third'),
        ]);
        harness.activeItemId.value = 'first';
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'third',
        ]);

        harness.editing.removeBookmark('first');

        expect(harness.bookmarks.value.map(item => item.id)).toEqual(['second']);
        expect(harness.activeItemId.value).toBe('second');
        expect(harness.selectedBookmarkIds.value.size).toBe(0);
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });
});
