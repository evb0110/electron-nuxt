import type {
    IBookmarkItem,
    TBookmarkDisplayMode,
} from '@app/types/pdfOutline';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import {
    collectBookmarkIds,
    findBookmarkById,
    findBookmarkLocation,
    flattenBookmarks,
    normalizeBookmarkColor,
} from '@app/utils/pdfOutlineHelpers';

export const usePdfOutlineEditing = (
    bookmarks: Ref<IBookmarkItem[]>,
    activeItemId: Ref<string | null>,
    expandedBookmarkIds: Ref<Set<string>>,
    displayMode: Ref<TBookmarkDisplayMode>,
    isEditMode: ComputedRef<boolean>,
    parentBookmarkIdMap: ComputedRef<Map<string, string | null>>,
    bookmarkOrderIndexMap: ComputedRef<Map<string, number>>,
    selectedBookmarkIds: Ref<Set<string>>,
    selectionAnchorBookmarkId: Ref<string | null>,
    styleRangeStartId: Ref<string | null>,
    draggingBookmarkIds: Ref<Set<string>>,
    applySingleSelection: (id: string) => void,
    closeBookmarkContextMenu: () => void,
    resetDragState: () => void,
    currentPage: Ref<number>,
    emitBookmarksChange: () => void,
    createBookmarkId: () => string,
) => {
    const { t } = useTypedI18n();
    const editingItemId = ref<string | null>(null);

    function createDraftBookmark(): IBookmarkItem {
        return {
            id: createBookmarkId(),
            title: t('bookmarks.newBookmark'),
            dest: null,
            pageIndex: Math.max(0, (currentPage.value || 1) - 1),
            bold: false,
            italic: false,
            color: null,
            items: [],
        };
    }

    function ensureBookmarkVisibleInTopLevelMode(id: string) {
        if (displayMode.value !== 'top-level') {
            return;
        }

        const parentId = parentBookmarkIdMap.value.get(id);
        if (!parentId) {
            return;
        }

        const nextExpanded = new Set(expandedBookmarkIds.value);
        nextExpanded.add(parentId);
        expandedBookmarkIds.value = nextExpanded;
    }

    function focusNewBookmark(id: string) {
        activeItemId.value = id;
        editingItemId.value = id;
        applySingleSelection(id);
        closeBookmarkContextMenu();
    }

    function startEditingBookmark(id: string) {
        activeItemId.value = id;
        applySingleSelection(id);
        editingItemId.value = id;
        closeBookmarkContextMenu();
    }

    function cancelEditingBookmark() {
        editingItemId.value = null;
    }

    function renameBookmark(payload: {
        id: string;
        title: string 
    }) {
        const location = findBookmarkLocation(bookmarks.value, payload.id);
        editingItemId.value = null;
        if (!location) {
            return;
        }

        const nextTitle = payload.title.trim();
        if (nextTitle.length === 0) {
            return;
        }

        if (location.item.title === nextTitle) {
            return;
        }

        location.item.title = nextTitle;
        emitBookmarksChange();
    }

    function addRootBookmark() {
        const bookmark = createDraftBookmark();
        bookmarks.value.push(bookmark);
        focusNewBookmark(bookmark.id);
        emitBookmarksChange();
    }

    function addSiblingAbove(id: string) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            return;
        }

        const bookmark = createDraftBookmark();
        location.list.splice(location.index, 0, bookmark);
        focusNewBookmark(bookmark.id);
        emitBookmarksChange();
    }

    function addSiblingBelow(id: string) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            return;
        }

        const bookmark = createDraftBookmark();
        location.list.splice(location.index + 1, 0, bookmark);
        focusNewBookmark(bookmark.id);
        emitBookmarksChange();
    }

    function addChildBookmark(id: string) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            return;
        }

        const bookmark = createDraftBookmark();
        location.item.items.push(bookmark);
        ensureBookmarkVisibleInTopLevelMode(bookmark.id);
        focusNewBookmark(bookmark.id);
        emitBookmarksChange();
    }

    function removeIdsFromSet(source: Set<string>, removedIds: Set<string>) {
        const next = new Set<string>();
        for (const id of source) {
            if (!removedIds.has(id)) {
                next.add(id);
            }
        }
        return next;
    }

    function clearRemovedEditingState(removedIds: Set<string>) {
        if (editingItemId.value && removedIds.has(editingItemId.value)) {
            editingItemId.value = null;
        }

        if (styleRangeStartId.value && removedIds.has(styleRangeStartId.value)) {
            styleRangeStartId.value = null;
        }
    }

    function resolveRootBookmarkIds(ids: Iterable<string>) {
        const selectedIds = new Set(ids);
        const roots = new Set<string>();

        for (const id of selectedIds) {
            if (!findBookmarkLocation(bookmarks.value, id)) {
                continue;
            }

            let hasSelectedAncestor = false;
            let cursor = parentBookmarkIdMap.value.get(id) ?? null;

            while (cursor) {
                if (selectedIds.has(cursor)) {
                    hasSelectedAncestor = true;
                    break;
                }
                cursor = parentBookmarkIdMap.value.get(cursor) ?? null;
            }

            if (!hasSelectedAncestor) {
                roots.add(id);
            }
        }

        const order = bookmarkOrderIndexMap.value;
        return [...roots].sort((left, right) => (
            (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
        ));
    }

    function resolveBookmarkRemovalTargetIds(id: string) {
        if (selectedBookmarkIds.value.has(id)) {
            const selectedRoots = resolveRootBookmarkIds(selectedBookmarkIds.value);
            if (selectedRoots.length > 0) {
                return selectedRoots;
            }
        }

        return resolveRootBookmarkIds([id]);
    }

    function removeBookmarkRoots(
        items: readonly IBookmarkItem[],
        rootIds: ReadonlySet<string>,
        removedIds: Set<string>,
    ): IBookmarkItem[] {
        return items.flatMap((item) => {
            if (rootIds.has(item.id)) {
                collectBookmarkIds(item, removedIds);
                return [];
            }

            return [{
                ...item,
                items: removeBookmarkRoots(item.items, rootIds, removedIds),
            }];
        });
    }

    function resolveNextActiveAfterRemoval(
        flatBeforeRemoval: IBookmarkItem[],
        removedIds: Set<string>,
    ) {
        const validIds = new Set(flattenBookmarks(bookmarks.value).map(item => item.id));
        const activeIndex = activeItemId.value && removedIds.has(activeItemId.value)
            ? flatBeforeRemoval.findIndex(item => item.id === activeItemId.value)
            : -1;
        const firstRemovedIndex = flatBeforeRemoval.findIndex(item => removedIds.has(item.id));
        const startIndex = activeIndex >= 0 ? activeIndex : firstRemovedIndex;

        if (startIndex < 0) {
            return null;
        }

        for (let index = startIndex; index < flatBeforeRemoval.length; index += 1) {
            const id = flatBeforeRemoval[index]?.id;
            if (id && !removedIds.has(id) && validIds.has(id)) {
                return id;
            }
        }

        for (let index = startIndex - 1; index >= 0; index -= 1) {
            const id = flatBeforeRemoval[index]?.id;
            if (id && !removedIds.has(id) && validIds.has(id)) {
                return id;
            }
        }

        return null;
    }

    function updateActiveAfterBookmarksRemoval(
        flatBeforeRemoval: IBookmarkItem[],
        removedIds: Set<string>,
    ) {
        if (!activeItemId.value || !removedIds.has(activeItemId.value)) {
            return;
        }

        activeItemId.value = resolveNextActiveAfterRemoval(flatBeforeRemoval, removedIds);
    }

    function removeBookmarkTargets(targetIds: Iterable<string>) {
        const rootIds = resolveRootBookmarkIds(targetIds);
        if (rootIds.length === 0) {
            return;
        }

        const flatBeforeRemoval = flattenBookmarks(bookmarks.value);
        const removedIds = new Set<string>();
        bookmarks.value = removeBookmarkRoots(bookmarks.value, new Set(rootIds), removedIds);
        if (removedIds.size === 0) {
            return;
        }

        updateActiveAfterBookmarksRemoval(flatBeforeRemoval, removedIds);
        clearRemovedEditingState(removedIds);
        selectedBookmarkIds.value = removeIdsFromSet(selectedBookmarkIds.value, removedIds);
        expandedBookmarkIds.value = removeIdsFromSet(expandedBookmarkIds.value, removedIds);

        closeBookmarkContextMenu();
        pruneStaleState();
        emitBookmarksChange();
    }

    function removeBookmark(id: string) {
        removeBookmarkTargets(resolveBookmarkRemovalTargetIds(id));
    }

    function removeSelectedBookmarks() {
        removeBookmarkTargets(selectedBookmarkIds.value);
    }

    function resolveBookmarkStyle(
        item: IBookmarkItem,
        updates: Partial<Pick<IBookmarkItem, 'bold' | 'italic' | 'color'>>,
    ) {
        return {
            bold: typeof updates.bold === 'boolean' ? updates.bold : item.bold,
            italic: typeof updates.italic === 'boolean' ? updates.italic : item.italic,
            color: updates.color === undefined
                ? item.color
                : normalizeBookmarkColor(updates.color),
        };
    }

    function hasBookmarkStyleChanged(
        item: IBookmarkItem,
        nextStyle: Pick<IBookmarkItem, 'bold' | 'italic' | 'color'>,
    ) {
        return item.bold !== nextStyle.bold
            || item.italic !== nextStyle.italic
            || item.color !== nextStyle.color;
    }

    function updateBookmarkStyle(
        id: string,
        updates: Partial<Pick<IBookmarkItem, 'bold' | 'italic' | 'color'>>,
    ) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            return;
        }

        const nextStyle = resolveBookmarkStyle(location.item, updates);
        if (!hasBookmarkStyleChanged(location.item, nextStyle)) {
            return;
        }

        location.item.bold = nextStyle.bold;
        location.item.italic = nextStyle.italic;
        location.item.color = nextStyle.color;
        emitBookmarksChange();
    }

    function toggleBookmarkBold(id: string) {
        const bookmark = findBookmarkById(bookmarks.value, id);
        if (!bookmark) {
            return;
        }
        updateBookmarkStyle(id, { bold: !bookmark.bold });
    }

    function toggleBookmarkItalic(id: string) {
        const bookmark = findBookmarkById(bookmarks.value, id);
        if (!bookmark) {
            return;
        }
        updateBookmarkStyle(id, { italic: !bookmark.italic });
    }

    function setBookmarkColor(id: string, color: string | null) {
        updateBookmarkStyle(id, { color });
    }

    function getValidBookmarkIds() {
        const validIds = new Set<string>();
        function visit(items: IBookmarkItem[]) {
            for (const item of items) {
                validIds.add(item.id);
                visit(item.items);
            }
        }
        visit(bookmarks.value);
        return validIds;
    }

    function hasInvalidId(source: Set<string>, validIds: Set<string>) {
        for (const id of source) {
            if (!validIds.has(id)) {
                return true;
            }
        }
        return false;
    }

    function retainValidIds(source: Set<string>, validIds: Set<string>) {
        const next = new Set<string>();
        for (const id of source) {
            if (validIds.has(id)) {
                next.add(id);
            }
        }
        return next;
    }

    function pruneActiveAndEditingState(validIds: Set<string>) {
        if (activeItemId.value && !validIds.has(activeItemId.value)) {
            activeItemId.value = null;
        }

        if (editingItemId.value && !validIds.has(editingItemId.value)) {
            editingItemId.value = null;
        }

        if (styleRangeStartId.value && !validIds.has(styleRangeStartId.value)) {
            styleRangeStartId.value = null;
        }
    }

    function pruneSelectionState(validIds: Set<string>) {
        selectedBookmarkIds.value = retainValidIds(selectedBookmarkIds.value, validIds);
        if (selectionAnchorBookmarkId.value && !validIds.has(selectionAnchorBookmarkId.value)) {
            selectionAnchorBookmarkId.value = null;
        }
    }

    function pruneDragState(validIds: Set<string>) {
        if (hasInvalidId(draggingBookmarkIds.value, validIds)) {
            resetDragState();
        }
    }

    function pruneStaleState() {
        const validIds = getValidBookmarkIds();
        pruneActiveAndEditingState(validIds);
        pruneSelectionState(validIds);
        pruneDragState(validIds);
        expandedBookmarkIds.value = retainValidIds(expandedBookmarkIds.value, validIds);
    }

    function mapBookmarksForPersistence(items: IBookmarkItem[]): IPdfBookmarkEntry[] {
        return items.map((item) => {
            const title = item.title.trim();
            return {
                title: title.length > 0 ? title : t('bookmarks.untitled'),
                pageIndex: typeof item.pageIndex === 'number' ? item.pageIndex : null,
                namedDest: typeof item.dest === 'string' && item.dest.trim().length > 0 ? item.dest : null,
                bold: item.bold,
                italic: item.italic,
                color: normalizeBookmarkColor(item.color),
                items: mapBookmarksForPersistence(item.items),
            };
        });
    }

    watch(isEditMode, (enabled) => {
        if (enabled) {
            return;
        }
        editingItemId.value = null;
        styleRangeStartId.value = null;
        closeBookmarkContextMenu();
        resetDragState();
    });

    return {
        editingItemId,
        createDraftBookmark,
        startEditingBookmark,
        cancelEditingBookmark,
        renameBookmark,
        addRootBookmark,
        addSiblingAbove,
        addSiblingBelow,
        addChildBookmark,
        resolveRootBookmarkIds,
        resolveBookmarkRemovalTargetIds,
        removeBookmark,
        removeSelectedBookmarks,
        toggleBookmarkBold,
        toggleBookmarkItalic,
        setBookmarkColor,
        updateBookmarkStyle,
        pruneStaleState,
        mapBookmarksForPersistence,
    };
};
