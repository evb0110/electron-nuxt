import type { Ref } from 'vue';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import type { IPdfBookmarkChangePayload } from '@app/types/pdfUi';
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
    handleBookmarksChange: (payload: IPdfBookmarkChangePayload) => void;
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

    function normalizeAgentBookmarkPath(value: unknown) {
        if (!Array.isArray(value)) {
            return null;
        }

        const path: number[] = [];
        for (const item of value) {
            if (typeof item !== 'number' || !Number.isFinite(item)) {
                return null;
            }
            path.push(Math.max(0, Math.trunc(item)));
        }
        return path;
    }

    function getAgentBookmarkPathListInput(input: Record<string, unknown>, actionId: string) {
        const rawPaths = input.paths;
        if (Array.isArray(rawPaths)) {
            const paths: number[][] = [];
            rawPaths.forEach((rawPath) => {
                const path = normalizeAgentBookmarkPath(rawPath);
                if (!path || path.length === 0) {
                    throw new Error(`${actionId} requires each input.paths item to be a non-empty path array.`);
                }
                paths.push(path);
            });
            if (paths.length === 0) {
                throw new Error(`${actionId} requires at least one bookmark path.`);
            }
            return paths;
        }

        const rawItems = input.bookmarks ?? input.items;
        if (Array.isArray(rawItems)) {
            const paths = rawItems.map((item) => {
                if (!isAgentRecord(item)) {
                    throw new Error(`${actionId} requires each input.items item to include a non-empty path.`);
                }
                const path = getAgentBookmarkPathInput(item);
                if (!path || path.length === 0) {
                    throw new Error(`${actionId} requires each input.items item to include a non-empty path.`);
                }
                return path;
            });
            if (paths.length === 0) {
                throw new Error(`${actionId} requires at least one bookmark path.`);
            }
            return paths;
        }

        const singlePath = getAgentBookmarkPathInput(input);
        if (singlePath && singlePath.length > 0) {
            return [singlePath];
        }

        throw new Error(`${actionId} requires input.paths, input.items with path, or input.path.`);
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

    function compareAgentBookmarkPaths(left: number[], right: number[]) {
        const length = Math.min(left.length, right.length);
        for (let index = 0; index < length; index += 1) {
            const difference = left[index]! - right[index]!;
            if (difference !== 0) {
                return difference;
            }
        }
        return left.length - right.length;
    }

    function pathsAreEqual(left: number[], right: number[]) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function pathStartsWith(path: number[], prefix: number[]) {
        return prefix.length <= path.length && prefix.every((value, index) => value === path[index]);
    }

    function resolveRootBookmarkPaths(paths: number[][]) {
        const roots: number[][] = [];
        const sorted = [...paths].sort(compareAgentBookmarkPaths);
        for (const path of sorted) {
            if (path.length === 0) {
                continue;
            }
            if (roots.some(rootPath => pathStartsWith(path, rootPath))) {
                continue;
            }
            roots.push(path);
        }
        return roots;
    }

    function removeBookmarkPaths(
        items: IPdfBookmarkEntry[],
        paths: number[][],
        parentPath: number[] = [],
    ): IPdfBookmarkEntry[] {
        return items.flatMap((item, index) => {
            const path = [
                ...parentPath,
                index,
            ];
            if (paths.some(targetPath => pathsAreEqual(path, targetPath))) {
                return [];
            }
            return [{
                ...item,
                items: removeBookmarkPaths(item.items, paths, path),
            }];
        });
    }

    function normalizeAgentBookmarkEntry(input: Record<string, unknown>, actionId: string): IPdfBookmarkEntry {
        const rawTitle = getAgentRawStringInput(input, 'title')?.trim();
        const title = rawTitle && rawTitle.length > 0 ? rawTitle : t('bookmarks.untitled');
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
            history: 'record',
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
            const rawTitle = getAgentRawStringInput(bookmarkUpdates, 'title')?.trim();
            updated.title = rawTitle && rawTitle.length > 0 ? rawTitle : t('bookmarks.untitled');
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

    function deleteAgentBookmarks(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const paths = getAgentBookmarkPathListInput(input, actionId);
        paths.forEach(path => getBookmarkLocationAtPath(bookmarks, path, actionId));
        const rootPaths = resolveRootBookmarkPaths(paths);
        const nextBookmarks = removeBookmarkPaths(bookmarks, rootPaths);
        return updateAgentBookmarks(nextBookmarks);
    }

    return {
        addAgentBookmark,
        addAgentBookmarks,
        applyAgentBookmarkPlan,
        createAgentBookmarkSnapshot,
        deleteAgentBookmark,
        deleteAgentBookmarks,
        previewAgentBookmarkPlan,
        setAgentBookmarkTree,
        updateAgentBookmark,
    };
}
