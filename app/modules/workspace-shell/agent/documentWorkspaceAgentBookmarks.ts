import type { Ref } from 'vue';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { normalizeBookmarkColor } from '@app/utils/pdfOutlineHelpers';
import {
    createAgentBookmarkPlan,
    createAgentBookmarkSnapshot as createAgentBookmarkPlanSnapshot,
} from '@app/utils/agentMetadataPlans';
import {
    getAgentBooleanInput,
    getAgentNullableStringInput,
    getAgentNumberArrayInput,
    getAgentNumberInput,
    getAgentRawStringInput,
    hasAgentInputKey,
    isAgentRecord,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import {
    normalizeAgentPageNumber,
    requireAgentPdfPageCount,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';
import type { TWorkspaceAgentTranslate } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';

interface ICreateDocumentAgentBookmarksOptions {
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    bookmarksDirty: Ref<boolean>;
    handleBookmarksChange: (payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }) => void;
    t: TWorkspaceAgentTranslate;
    totalPages: Ref<number>;
}

export function createDocumentAgentBookmarks(options: ICreateDocumentAgentBookmarksOptions) {
    const {
        bookmarkItems,
        bookmarksDirty,
        handleBookmarksChange,
        t,
        totalPages,
    } = options;

    function normalizeAgentBookmarkPageIndex(input: Record<string, unknown>, actionId: string) {
        const pageNumber = getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber');
        if (pageNumber !== null) {
            return normalizeAgentPageNumber(pageNumber, totalPages.value, actionId) - 1;
        }

        const pageIndex = getAgentNumberInput(input, 'pageIndex');
        if (pageIndex === null) {
            return null;
        }
        const normalizedPageIndex = Math.trunc(pageIndex);
        if (normalizedPageIndex < 0 || normalizedPageIndex >= requireAgentPdfPageCount(totalPages.value, actionId)) {
            throw new Error(`${actionId} pageIndex ${normalizedPageIndex} is outside the document.`);
        }
        return normalizedPageIndex;
    }

    function cloneAgentBookmarkEntry(bookmark: IPdfBookmarkEntry): IPdfBookmarkEntry {
        return {
            ...bookmark,
            items: bookmark.items.map(cloneAgentBookmarkEntry),
        };
    }

    function cloneAgentBookmarks() {
        return bookmarkItems.value.map(cloneAgentBookmarkEntry);
    }

    function getAgentBookmarkPathInput(input: Record<string, unknown>, key = 'path') {
        const path = getAgentNumberArrayInput(input, key);
        return path?.map(index => Math.max(0, Math.trunc(index))) ?? null;
    }

    function getBookmarkListAtPath(
        bookmarks: IPdfBookmarkEntry[],
        path: number[],
        actionId: string,
    ) {
        let list = bookmarks;
        for (const index of path) {
            const bookmark = list[index];
            if (!bookmark) {
                throw new Error(`${actionId} bookmark path was not found.`);
            }
            list = bookmark.items;
        }
        return list;
    }

    function getBookmarkLocationAtPath(
        bookmarks: IPdfBookmarkEntry[],
        path: number[] | null,
        actionId: string,
    ) {
        if (!path || path.length === 0) {
            throw new Error(`${actionId} requires input.path.`);
        }
        const parentPath = path.slice(0, -1);
        const index = path[path.length - 1]!;
        const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
        const bookmark = list[index];
        if (!bookmark) {
            throw new Error(`${actionId} bookmark path was not found.`);
        }
        return {
            list,
            index,
            bookmark,
        };
    }

    function normalizeAgentBookmarkEntry(input: Record<string, unknown>, actionId: string): IPdfBookmarkEntry {
        const title = getAgentRawStringInput(input, 'title')?.trim() || t('bookmarks.untitled');
        const namedDest = getAgentRawStringInput(input, 'namedDest')
            ?? getAgentRawStringInput(input, 'dest')
            ?? null;
        const items = Array.isArray(input.items)
            ? input.items
                .filter(isAgentRecord)
                .map(item => normalizeAgentBookmarkEntry(item, actionId))
            : [];
        const color = getAgentNullableStringInput(input, 'color');
        return {
            title,
            pageIndex: normalizeAgentBookmarkPageIndex(input, actionId),
            namedDest: namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null,
            bold: getAgentBooleanInput(input, 'bold') ?? false,
            italic: getAgentBooleanInput(input, 'italic') ?? false,
            color: color === null ? null : normalizeBookmarkColor(color),
            items,
        };
    }

    function normalizeAgentBookmarkInput(input: Record<string, unknown>, actionId: string) {
        const rawBookmark = input.bookmark;
        return normalizeAgentBookmarkEntry(
            isAgentRecord(rawBookmark) ? rawBookmark : input,
            actionId,
        );
    }

    function createAgentBookmarkSnapshot() {
        return createAgentBookmarkPlanSnapshot(bookmarkItems.value, {dirty: bookmarksDirty.value});
    }

    function updateAgentBookmarks(bookmarks: IPdfBookmarkEntry[]) {
        handleBookmarksChange({
            bookmarks,
            dirty: true,
        });
        return createAgentBookmarkSnapshot();
    }

    function setAgentBookmarkTree(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentBookmarkPlan(input, actionId);
        return {
            ...updateAgentBookmarks(plan.bookmarks),
            plan,
        };
    }

    function previewAgentBookmarkPlan(input: Record<string, unknown>, actionId: string) {
        return createAgentBookmarkPlan({
            input,
            currentBookmarks: bookmarkItems.value,
            totalPages: totalPages.value,
            dirty: bookmarksDirty.value,
            untitledTitle: t('bookmarks.untitled'),
            actionId,
        });
    }

    function applyAgentBookmarkPlan(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentBookmarkPlan(input, actionId);
        return {
            ...updateAgentBookmarks(plan.bookmarks),
            plan,
        };
    }

    function addAgentBookmark(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const parentPath = getAgentBookmarkPathInput(input, 'parentPath') ?? [];
        const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
        const bookmark = normalizeAgentBookmarkInput(input, actionId);
        const index = getAgentNumberInput(input, 'index');
        const insertIndex = index === null
            ? list.length
            : Math.min(list.length, Math.max(0, Math.trunc(index)));
        list.splice(insertIndex, 0, bookmark);
        return updateAgentBookmarks(bookmarks);
    }

    function addAgentBookmarks(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const batchParentPath = getAgentBookmarkPathInput(input, 'parentPath') ?? [];
        const rawItems = input.bookmarks ?? input.items;
        if (!Array.isArray(rawItems)) {
            throw new Error(`${actionId} requires input.bookmarks or input.items.`);
        }

        rawItems
            .filter(isAgentRecord)
            .forEach((item) => {
                const parentPath = getAgentBookmarkPathInput(item, 'parentPath') ?? batchParentPath;
                const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
                const insertIndex = getAgentNumberInput(item, 'index');
                const bookmark = normalizeAgentBookmarkEntry(item, actionId);
                list.splice(
                    insertIndex === null ? list.length : Math.min(list.length, Math.max(0, Math.trunc(insertIndex))),
                    0,
                    bookmark,
                );
            });
        return updateAgentBookmarks(bookmarks);
    }

    function updateAgentBookmark(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const location = getBookmarkLocationAtPath(bookmarks, getAgentBookmarkPathInput(input), actionId);
        const bookmarkUpdates = isAgentRecord(input.bookmark) ? input.bookmark : input;
        const updated = {...location.bookmark};
        if (hasAgentInputKey(bookmarkUpdates, 'title')) {
            updated.title = getAgentRawStringInput(bookmarkUpdates, 'title')?.trim() || t('bookmarks.untitled');
        }
        if (
            hasAgentInputKey(bookmarkUpdates, 'page')
            || hasAgentInputKey(bookmarkUpdates, 'pageNumber')
            || hasAgentInputKey(bookmarkUpdates, 'pageIndex')
        ) {
            updated.pageIndex = normalizeAgentBookmarkPageIndex(bookmarkUpdates, actionId);
        }
        if (hasAgentInputKey(bookmarkUpdates, 'namedDest') || hasAgentInputKey(bookmarkUpdates, 'dest')) {
            const namedDest = getAgentRawStringInput(bookmarkUpdates, 'namedDest')
                ?? getAgentRawStringInput(bookmarkUpdates, 'dest')
                ?? null;
            updated.namedDest = namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null;
        }
        if (hasAgentInputKey(bookmarkUpdates, 'bold')) {
            updated.bold = getAgentBooleanInput(bookmarkUpdates, 'bold') ?? false;
        }
        if (hasAgentInputKey(bookmarkUpdates, 'italic')) {
            updated.italic = getAgentBooleanInput(bookmarkUpdates, 'italic') ?? false;
        }
        if (hasAgentInputKey(bookmarkUpdates, 'color')) {
            const color = getAgentNullableStringInput(bookmarkUpdates, 'color');
            updated.color = color === null ? null : normalizeBookmarkColor(color);
        }
        if (Array.isArray(bookmarkUpdates.items)) {
            updated.items = bookmarkUpdates.items
                .filter(isAgentRecord)
                .map(item => normalizeAgentBookmarkEntry(item, actionId));
        }
        location.list.splice(location.index, 1, updated);
        return updateAgentBookmarks(bookmarks);
    }

    function deleteAgentBookmark(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const location = getBookmarkLocationAtPath(bookmarks, getAgentBookmarkPathInput(input), actionId);
        location.list.splice(location.index, 1);
        return updateAgentBookmarks(bookmarks);
    }

    return {
        addAgentBookmark,
        addAgentBookmarks,
        applyAgentBookmarkPlan,
        createAgentBookmarkSnapshot,
        deleteAgentBookmark,
        previewAgentBookmarkPlan,
        setAgentBookmarkTree,
        updateAgentBookmark,
    };
}
