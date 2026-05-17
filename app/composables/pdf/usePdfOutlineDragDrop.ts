import type {
    IBookmarkItem,
    IBookmarkDropTarget,
    IBookmarkDropPayload,
} from '@app/types/pdfOutline';
import {
    findBookmarkLocation,
    collectBookmarkIds,
} from '@app/utils/pdfOutlineHelpers';

type TBookmarkDropDestination =
    | { kind: 'root-end' }
    | {
        kind: 'target';
        payload: IBookmarkDropPayload;
    };

function removeDraggedBookmarkItems(
    items: readonly IBookmarkItem[],
    draggedIds: ReadonlySet<string>,
): {
    items: IBookmarkItem[];
    draggedItems: IBookmarkItem[];
} {
    return items.reduce<{
        items: IBookmarkItem[];
        draggedItems: IBookmarkItem[];
    }>((result, item) => {
        if (draggedIds.has(item.id)) {
            return {
                ...result,
                draggedItems: [
                    ...result.draggedItems,
                    item,
                ],
            };
        }

        const childResult = removeDraggedBookmarkItems(item.items, draggedIds);
        return {
            items: [
                ...result.items,
                {
                    ...item,
                    items: childResult.items,
                },
            ],
            draggedItems: [
                ...result.draggedItems,
                ...childResult.draggedItems,
            ],
        };
    }, {
        items: [],
        draggedItems: [],
    });
}

function insertBookmarkItems(
    items: readonly IBookmarkItem[],
    draggedItems: readonly IBookmarkItem[],
    destination: TBookmarkDropDestination,
): {
    items: IBookmarkItem[];
    expandedBookmarkId: string | null;
    inserted: boolean;
} {
    if (destination.kind === 'root-end') {
        return {
            items: [
                ...items,
                ...draggedItems,
            ],
            expandedBookmarkId: null,
            inserted: true,
        };
    }

    const nextItems = items.flatMap((item) => {
        if (item.id === destination.payload.targetId) {
            if (destination.payload.position === 'before') {
                return [
                    ...draggedItems,
                    item,
                ];
            }
            if (destination.payload.position === 'after') {
                return [
                    item,
                    ...draggedItems,
                ];
            }
            return [{
                ...item,
                items: [
                    ...item.items,
                    ...draggedItems,
                ],
            }];
        }

        const childResult = insertBookmarkItems(item.items, draggedItems, destination);
        return [{
            ...item,
            items: childResult.items,
        }];
    });
    const targetExpanded = destination.payload.position === 'child'
        ? destination.payload.targetId
        : null;
    const inserted = JSON.stringify(nextItems) !== JSON.stringify(items);

    return {
        items: nextItems,
        expandedBookmarkId: inserted ? targetExpanded : null,
        inserted,
    };
}

function moveBookmarkNodes(
    items: readonly IBookmarkItem[],
    draggedRootIds: readonly string[],
    destination: TBookmarkDropDestination,
) {
    const draggedIdSet = new Set(draggedRootIds);
    const extraction = removeDraggedBookmarkItems(items, draggedIdSet);
    const draggedById = new Map(extraction.draggedItems.map(item => [
        item.id,
        item,
    ]));
    const draggedItems = draggedRootIds
        .map(id => draggedById.get(id) ?? null)
        .filter((item): item is IBookmarkItem => item !== null);

    if (draggedItems.length === 0) {
        return {
            bookmarks: [...items],
            expandedBookmarkId: null,
            moved: false,
        };
    }

    const insertion = insertBookmarkItems(extraction.items, draggedItems, destination);
    return {
        bookmarks: insertion.items,
        expandedBookmarkId: insertion.expandedBookmarkId,
        moved: insertion.inserted,
    };
}

export const usePdfOutlineDragDrop = (
    bookmarks: Ref<IBookmarkItem[]>,
    expandedBookmarkIds: Ref<Set<string>>,
    isEditMode: ComputedRef<boolean>,
    selectedBookmarkIds: Ref<Set<string>>,
    parentBookmarkIdMap: ComputedRef<Map<string, string | null>>,
    bookmarkOrderIndexMap: ComputedRef<Map<string, number>>,
    applySingleSelection: (id: string) => void,
    closeBookmarkContextMenu: () => void,
) => {
    const draggingBookmarkIds = ref<Set<string>>(new Set());
    const bookmarkDropTarget = ref<IBookmarkDropTarget | null>(null);
    const isRootAppendDropTarget = ref(false);

    function resetDragState() {
        draggingBookmarkIds.value = new Set();
        bookmarkDropTarget.value = null;
        isRootAppendDropTarget.value = false;
    }

    function resolveSelectedRootIds(selection: Set<string>) {
        const roots = new Set<string>();
        for (const id of selection) {
            let hasSelectedAncestor = false;
            let cursor = parentBookmarkIdMap.value.get(id) ?? null;

            while (cursor) {
                if (selection.has(cursor)) {
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
        return [...roots].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    }

    function collectDraggedBranchIds(draggedRootIds: string[]) {
        const ids = new Set<string>();
        for (const id of draggedRootIds) {
            const location = findBookmarkLocation(bookmarks.value, id);
            if (!location) {
                continue;
            }
            collectBookmarkIds(location.item, ids);
        }
        return ids;
    }

    function canDropBookmarks(draggedRootIds: string[], targetId: string) {
        if (draggedRootIds.includes(targetId)) {
            return false;
        }

        const draggedBranchIds = collectDraggedBranchIds(draggedRootIds);
        return !draggedBranchIds.has(targetId);
    }

    function moveBookmarksToRootEnd(draggedRootIds: string[]) {
        const result = moveBookmarkNodes(bookmarks.value, draggedRootIds, { kind: 'root-end' });
        if (!result.moved) {
            return;
        }
        bookmarks.value = result.bookmarks;
    }

    function handleBookmarkDragStart(payload: { id: string }) {
        if (!isEditMode.value) {
            return;
        }

        if (!selectedBookmarkIds.value.has(payload.id)) {
            applySingleSelection(payload.id);
        }

        const draggedRoots = resolveSelectedRootIds(selectedBookmarkIds.value);
        draggingBookmarkIds.value = new Set(draggedRoots.length > 0 ? draggedRoots : [payload.id]);
        bookmarkDropTarget.value = null;
        isRootAppendDropTarget.value = false;
        closeBookmarkContextMenu();
    }

    function handleBookmarkDragHover(payload: IBookmarkDropPayload) {
        const draggingRoots = [...draggingBookmarkIds.value];
        if (!isEditMode.value || draggingRoots.length === 0) {
            return;
        }

        if (!canDropBookmarks(draggingRoots, payload.targetId)) {
            bookmarkDropTarget.value = null;
            isRootAppendDropTarget.value = false;
            return;
        }

        bookmarkDropTarget.value = {
            id: payload.targetId,
            position: payload.position,
        };
        isRootAppendDropTarget.value = false;
    }

    function handleBookmarkDrop(
        payload: IBookmarkDropPayload,
        activeItemId: Ref<string | null>,
        emitBookmarksChange: () => void,
    ) {
        const draggingRoots = [...draggingBookmarkIds.value];
        if (!isEditMode.value || draggingRoots.length === 0) {
            return;
        }

        if (!canDropBookmarks(draggingRoots, payload.targetId)) {
            resetDragState();
            return;
        }

        const targetLocationBeforeExtraction = findBookmarkLocation(bookmarks.value, payload.targetId);
        if (targetLocationBeforeExtraction) {
            const result = moveBookmarkNodes(bookmarks.value, draggingRoots, {
                kind: 'target',
                payload,
            });
            if (result.moved) {
                bookmarks.value = result.bookmarks;
            }
            if (result.expandedBookmarkId) {
                expandedBookmarkIds.value = new Set([
                    ...expandedBookmarkIds.value,
                    result.expandedBookmarkId,
                ]);
            }
        }

        activeItemId.value = draggingRoots[0] ?? null;
        emitBookmarksChange();
        resetDragState();
    }

    function handleTreeEndDragOver() {
        if (!isEditMode.value || draggingBookmarkIds.value.size === 0) {
            return;
        }

        bookmarkDropTarget.value = null;
        isRootAppendDropTarget.value = true;
    }

    function handleTreeEndDrop(
        activeItemId: Ref<string | null>,
        emitBookmarksChange: () => void,
    ) {
        const draggingRoots = [...draggingBookmarkIds.value];
        if (!isEditMode.value || draggingRoots.length === 0) {
            return;
        }

        moveBookmarksToRootEnd(draggingRoots);
        activeItemId.value = draggingRoots[0] ?? null;
        emitBookmarksChange();
        resetDragState();
    }

    function handleBookmarkDragEnd() {
        resetDragState();
    }

    return {
        draggingBookmarkIds,
        bookmarkDropTarget,
        isRootAppendDropTarget,
        resetDragState,
        handleBookmarkDragStart,
        handleBookmarkDragHover,
        handleBookmarkDrop,
        handleTreeEndDragOver,
        handleTreeEndDrop,
        handleBookmarkDragEnd,
    };
};
