import type { Ref } from 'vue';
import { isRecord } from '@contracts/runtimeGuards';
import { isEqual } from 'es-toolkit/predicate';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import type { IPdfBookmarkChangePayload } from '@app/types/pdfUi';
import { normalizeBookmarkColor } from '@app/utils/pdfOutlineHelpers';
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

type TAgentMetadataIssueSeverity = 'error' | 'warning' | 'info';
type TAgentBookmarkInputMode = 'nested' | 'flat';

interface IAgentMetadataIssue {
    severity: TAgentMetadataIssueSeverity;
    code: string;
    message: string;
    page?: number | null;
    path?: number[];
}

interface IAgentBookmarkFlatEntry {
    path: number[];
    depth: number;
    title: string;
    pageIndex: number | null;
    pageNumber: number | null;
    pageYRatio: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    childCount: number;
}

interface IAgentBookmarkSnapshot {
    count: number;
    dirty: boolean;
    summary: {
        rootCount: number;
        totalCount: number;
        maxDepth: number;
        destinationlessCount: number;
        namedDestinationCount: number;
        anchoredPageDestinationCount: number;
        firstPageNumber: number | null;
        lastPageNumber: number | null;
    };
    issues: IAgentMetadataIssue[];
    flat: IAgentBookmarkFlatEntry[];
    bookmarks: Array<Record<string, unknown>>;
}

interface IAgentBookmarkPlan {
    inputMode: TAgentBookmarkInputMode;
    bookmarks: IPdfBookmarkEntry[];
    proposed: IAgentBookmarkSnapshot;
    diff: {
        wouldChange: boolean;
        currentCount: number;
        proposedCount: number;
        addedCount: number;
        removedCount: number;
        updatedCount: number;
        added: IAgentBookmarkFlatEntry[];
        removed: IAgentBookmarkFlatEntry[];
        updated: Array<{
            path: number[];
            before: IAgentBookmarkFlatEntry;
            after: IAgentBookmarkFlatEntry;
        }>;
    };
    issues: IAgentMetadataIssue[];
}

const MAX_ISSUE_COUNT = 50;
const MAX_DIFF_SAMPLE_COUNT = 50;
const MIN_CHILDREN_SHARING_PARENT_DESTINATION_FOR_ANCHOR_WARNING = 2;

function hasInputKey(input: Record<string, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(input, key);
}

function getRawStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' ? value : null;
}

function getNullableStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (value === null) {
        return null;
    }
    return typeof value === 'string' ? value.trim() : undefined;
}

function getNumberInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function getBooleanInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'boolean' ? value : null;
}

function pushIssue(issues: IAgentMetadataIssue[], issue: IAgentMetadataIssue) {
    if (issues.length < MAX_ISSUE_COUNT) {
        issues.push(issue);
    }
}

function requirePageCount(totalPages: number, actionId: string) {
    if (totalPages <= 0) {
        throw new Error(`${actionId} requires an open PDF document.`);
    }
    return totalPages;
}

function normalizePageNumber(value: number | null | undefined, totalPages: number, actionId: string) {
    requirePageCount(totalPages, actionId);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${actionId} requires a valid one-based page number.`);
    }
    const page = Math.trunc(value);
    if (page < 1 || page > totalPages) {
        throw new Error(`${actionId} page ${page} is outside the document.`);
    }
    return page;
}

function normalizeBookmarkPageIndex(
    input: Record<string, unknown>,
    totalPages: number,
    actionId: string,
) {
    const pageNumber = getNumberInput(input, 'page') ?? getNumberInput(input, 'pageNumber');
    if (pageNumber !== null) {
        return normalizePageNumber(pageNumber, totalPages, actionId) - 1;
    }

    const pageIndex = getNumberInput(input, 'pageIndex');
    if (pageIndex === null) {
        return null;
    }
    const normalizedPageIndex = Math.trunc(pageIndex);
    if (normalizedPageIndex < 0 || normalizedPageIndex >= requirePageCount(totalPages, actionId)) {
        throw new Error(`${actionId} pageIndex ${normalizedPageIndex} is outside the document.`);
    }
    return normalizedPageIndex;
}

function getRawBookmarkPageYRatioInput(input: Record<string, unknown>) {
    if (hasInputKey(input, 'pageYRatio')) {
        return input.pageYRatio;
    }
    if (hasInputKey(input, 'yRatio')) {
        return input.yRatio;
    }
    if (hasInputKey(input, 'pageAnchorRatio')) {
        return input.pageAnchorRatio;
    }
    return undefined;
}

function clampBookmarkPageYRatio(value: number) {
    return Math.min(1, Math.max(0, value));
}

function normalizeBookmarkPageYRatioInput(
    input: Record<string, unknown>,
    pageIndex: number | null,
    actionId: string,
) {
    if (pageIndex === null) {
        return null;
    }

    const value = getRawBookmarkPageYRatioInput(input);
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${actionId} pageYRatio must be a finite number from 0 to 1 or null.`);
    }
    return clampBookmarkPageYRatio(value);
}

function normalizeBookmarkPageYRatioValue(
    pageIndex: number | null,
    value: number | null | undefined,
) {
    return pageIndex !== null && typeof value === 'number' && Number.isFinite(value)
        ? clampBookmarkPageYRatio(value)
        : null;
}

function normalizeBookmarkPageYRatioForComparison(
    pageIndex: number | null,
    value: number | null | undefined,
) {
    if (pageIndex === null) {
        return null;
    }
    const normalized = typeof value === 'number' && Number.isFinite(value)
        ? clampBookmarkPageYRatio(value)
        : 0;
    return Number(normalized.toFixed(6));
}

function getBookmarkDestinationKey(bookmark: Pick<IPdfBookmarkEntry, 'pageIndex' | 'pageYRatio' | 'namedDest'>) {
    if (bookmark.namedDest) {
        return `named:${bookmark.namedDest}`;
    }
    if (bookmark.pageIndex === null) {
        return null;
    }
    return `page:${bookmark.pageIndex}:${normalizeBookmarkPageYRatioForComparison(
        bookmark.pageIndex,
        bookmark.pageYRatio,
    )}`;
}

function normalizeBookmarkEntry(
    input: Record<string, unknown>,
    totalPages: number,
    untitledTitle: string,
    actionId: string,
): IPdfBookmarkEntry {
    const rawTitle = getRawStringInput(input, 'title')?.trim();
    const title = rawTitle && rawTitle.length > 0 ? rawTitle : untitledTitle;
    const pageIndex = normalizeBookmarkPageIndex(input, totalPages, actionId);
    const namedDest = getRawStringInput(input, 'namedDest')
        ?? getRawStringInput(input, 'dest')
        ?? null;
    const color = getNullableStringInput(input, 'color');
    const rawItems = Array.isArray(input.items) ? input.items : input.children;
    return {
        title,
        pageIndex,
        pageYRatio: normalizeBookmarkPageYRatioInput(input, pageIndex, actionId),
        namedDest: namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null,
        bold: getBooleanInput(input, 'bold') ?? false,
        italic: getBooleanInput(input, 'italic') ?? false,
        color: color === null ? null : normalizeBookmarkColor(color),
        items: Array.isArray(rawItems)
            ? rawItems
                .filter(isRecord)
                .map(item => normalizeBookmarkEntry(item, totalPages, untitledTitle, actionId))
            : [],
    };
}

function normalizeFlatBookmarkDepth(input: Record<string, unknown>) {
    const depth = getNumberInput(input, 'depth');
    if (depth !== null) {
        return Math.max(0, Math.trunc(depth));
    }

    const level = getNumberInput(input, 'level');
    if (level !== null) {
        return Math.max(0, Math.trunc(level) - 1);
    }

    return 0;
}

function buildBookmarkTreeFromFlatEntries(
    entries: Array<Record<string, unknown>>,
    totalPages: number,
    untitledTitle: string,
    actionId: string,
) {
    const roots: IPdfBookmarkEntry[] = [];
    const stack: IPdfBookmarkEntry[] = [];
    const issues: IAgentMetadataIssue[] = [];

    entries.forEach((entry, index) => {
        const depth = normalizeFlatBookmarkDepth(entry);
        const bookmark = normalizeBookmarkEntry(entry, totalPages, untitledTitle, actionId);
        if (depth === 0) {
            roots.push(bookmark);
            stack.length = 0;
            stack[0] = bookmark;
            return;
        }

        const parent = stack[depth - 1] ?? null;
        if (!parent) {
            pushIssue(issues, {
                severity: 'warning',
                code: 'flat_bookmark_missing_parent',
                message: `Flat bookmark "${bookmark.title}" at entry ${index + 1} has depth ${depth} without a parent; it was promoted to the root level.`,
                page: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
            });
            roots.push(bookmark);
            stack.length = 0;
            stack[0] = bookmark;
            return;
        }

        parent.items.push(bookmark);
        stack.length = depth + 1;
        stack[depth] = bookmark;
    });

    return {
        bookmarks: roots,
        issues,
    };
}

function normalizeBookmarkTreeInput(options: {
    input: Record<string, unknown>;
    totalPages: number;
    untitledTitle: string;
    actionId: string;
}) {
    const rawTree = options.input.bookmarks ?? options.input.items ?? options.input.tree;
    if (Array.isArray(rawTree)) {
        return {
            inputMode: 'nested' as const,
            bookmarks: rawTree
                .filter(isRecord)
                .map(item => normalizeBookmarkEntry(item, options.totalPages, options.untitledTitle, options.actionId)),
            issues: [] as IAgentMetadataIssue[],
        };
    }

    const rawFlat = options.input.entries ?? options.input.flat ?? options.input.outline;
    if (Array.isArray(rawFlat)) {
        const flatResult = buildBookmarkTreeFromFlatEntries(
            rawFlat.filter(isRecord),
            options.totalPages,
            options.untitledTitle,
            options.actionId,
        );
        return {
            inputMode: 'flat' as const,
            ...flatResult,
        };
    }

    throw new Error(`${options.actionId} requires input.bookmarks, input.items, input.tree, input.entries, input.flat, or input.outline.`);
}

function normalizeBookmarkForAgent(
    bookmark: IPdfBookmarkEntry,
    path: number[] = [],
): Record<string, unknown> {
    return {
        path,
        depth: path.length,
        title: bookmark.title,
        pageIndex: bookmark.pageIndex,
        pageNumber: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
        pageYRatio: normalizeBookmarkPageYRatioValue(bookmark.pageIndex, bookmark.pageYRatio),
        namedDest: bookmark.namedDest,
        bold: bookmark.bold,
        italic: bookmark.italic,
        color: bookmark.color,
        items: bookmark.items.map((child, index) => normalizeBookmarkForAgent(child, [
            ...path,
            index,
        ])),
    };
}

function flattenBookmarks(bookmarks: IPdfBookmarkEntry[]) {
    const flat: IAgentBookmarkFlatEntry[] = [];
    const visit = (items: IPdfBookmarkEntry[], path: number[]) => {
        items.forEach((bookmark, index) => {
            const nextPath = [
                ...path,
                index,
            ];
            flat.push({
                path: nextPath,
                depth: nextPath.length - 1,
                title: bookmark.title,
                pageIndex: bookmark.pageIndex,
                pageNumber: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
                pageYRatio: normalizeBookmarkPageYRatioValue(bookmark.pageIndex, bookmark.pageYRatio),
                namedDest: bookmark.namedDest,
                bold: bookmark.bold,
                italic: bookmark.italic,
                color: bookmark.color,
                childCount: bookmark.items.length,
            });
            visit(bookmark.items, nextPath);
        });
    };
    visit(bookmarks, []);
    return flat;
}

function getBookmarkComparable(entry: IAgentBookmarkFlatEntry) {
    return {
        title: entry.title,
        pageIndex: entry.pageIndex,
        pageYRatio: entry.pageYRatio,
        namedDest: entry.namedDest,
        bold: entry.bold,
        italic: entry.italic,
        color: entry.color,
        childCount: entry.childCount,
    };
}

function createBookmarkIssues(bookmarks: IPdfBookmarkEntry[]) {
    const issues: IAgentMetadataIssue[] = [];
    const flat = flattenBookmarks(bookmarks);
    for (const entry of flat) {
        if (entry.pageIndex === null && !entry.namedDest) {
            pushIssue(issues, {
                severity: 'warning',
                code: 'bookmark_without_destination',
                message: `Bookmark "${entry.title}" has no page or named destination.`,
                path: entry.path,
            });
        }
    }

    let previousPage: number | null = null;
    for (const entry of flat) {
        if (entry.pageNumber === null) {
            continue;
        }
        if (previousPage !== null && entry.pageNumber < previousPage) {
            pushIssue(issues, {
                severity: 'info',
                code: 'bookmark_page_order_decreases',
                message: `Bookmark "${entry.title}" points to page ${entry.pageNumber}, before the previous bookmark page ${previousPage}.`,
                page: entry.pageNumber,
                path: entry.path,
            });
        }
        previousPage = entry.pageNumber;
    }

    const visitSiblings = (items: IPdfBookmarkEntry[], path: number[]) => {
        const counts = new Map<string, number>();
        items.forEach((item) => {
            const key = item.title.trim().toLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
        });
        items.forEach((item, index) => {
            const key = item.title.trim().toLowerCase();
            if ((counts.get(key) ?? 0) > 1) {
                pushIssue(issues, {
                    severity: 'info',
                    code: 'duplicate_sibling_bookmark_title',
                    message: `Sibling bookmark title "${item.title}" appears more than once.`,
                    path: [
                        ...path,
                        index,
                    ],
                });
            }
            visitSiblings(item.items, [
                ...path,
                index,
            ]);
        });
    };
    visitSiblings(bookmarks, []);

    const visitChildrenSharingParentDestination = (items: IPdfBookmarkEntry[], path: number[]) => {
        items.forEach((parent, index) => {
            const parentPath = [
                ...path,
                index,
            ];
            const parentDestinationKey = getBookmarkDestinationKey(parent);
            if (parentDestinationKey !== null) {
                const childrenAtParentDestination = parent.items.filter(child => (
                    getBookmarkDestinationKey(child) === parentDestinationKey
                ));
                if (childrenAtParentDestination.length >= MIN_CHILDREN_SHARING_PARENT_DESTINATION_FOR_ANCHOR_WARNING) {
                    pushIssue(issues, {
                        severity: 'error',
                        code: 'bookmark_children_share_parent_destination',
                        message: `${childrenAtParentDestination.length} child bookmarks under "${parent.title}" point to the same destination as their parent. Locate each child heading with document.search/read_pages/capture_page_image and provide a distinct page or pageYRatio anchor, or omit those child bookmarks.`,
                        page: parent.pageIndex === null ? null : parent.pageIndex + 1,
                        path: parentPath,
                    });
                }
            }
            visitChildrenSharingParentDestination(parent.items, parentPath);
        });
    };
    visitChildrenSharingParentDestination(bookmarks, []);

    return issues;
}

function createBookmarkSummary(bookmarks: IPdfBookmarkEntry[], flat: IAgentBookmarkFlatEntry[]) {
    const pageNumbers: number[] = [];
    for (const entry of flat) {
        if (typeof entry.pageNumber === 'number') {
            pageNumbers.push(entry.pageNumber);
        }
    }
    return {
        rootCount: bookmarks.length,
        totalCount: flat.length,
        maxDepth: flat.reduce((maxDepth, entry) => Math.max(maxDepth, entry.depth), 0),
        destinationlessCount: flat.filter(entry => entry.pageIndex === null && !entry.namedDest).length,
        namedDestinationCount: flat.filter(entry => Boolean(entry.namedDest)).length,
        anchoredPageDestinationCount: flat.filter(entry => (
            entry.pageIndex !== null
            && typeof entry.pageYRatio === 'number'
            && entry.pageYRatio > 0
        )).length,
        firstPageNumber: pageNumbers.length > 0 ? Math.min(...pageNumbers) : null,
        lastPageNumber: pageNumbers.length > 0 ? Math.max(...pageNumbers) : null,
    };
}

export function createAgentBookmarkSnapshot(
    bookmarks: IPdfBookmarkEntry[],
    options: {dirty: boolean;},
): IAgentBookmarkSnapshot {
    const flat = flattenBookmarks(bookmarks);
    return {
        count: bookmarks.length,
        dirty: options.dirty,
        summary: createBookmarkSummary(bookmarks, flat),
        issues: createBookmarkIssues(bookmarks),
        flat,
        bookmarks: bookmarks.map((bookmark, index) => normalizeBookmarkForAgent(bookmark, [index])),
    };
}

function createBookmarkDiff(current: IAgentBookmarkSnapshot, proposed: IAgentBookmarkSnapshot) {
    const currentByPath = new Map(current.flat.map(entry => [
        entry.path.join('.'),
        entry,
    ]));
    const proposedByPath = new Map(proposed.flat.map(entry => [
        entry.path.join('.'),
        entry,
    ]));
    const added: IAgentBookmarkFlatEntry[] = [];
    const removed: IAgentBookmarkFlatEntry[] = [];
    const updated: IAgentBookmarkPlan['diff']['updated'] = [];

    for (const proposedEntry of proposed.flat) {
        const key = proposedEntry.path.join('.');
        const currentEntry = currentByPath.get(key);
        if (!currentEntry) {
            if (added.length < MAX_DIFF_SAMPLE_COUNT) {
                added.push(proposedEntry);
            }
            continue;
        }
        if (!isEqual(getBookmarkComparable(currentEntry), getBookmarkComparable(proposedEntry))) {
            if (updated.length < MAX_DIFF_SAMPLE_COUNT) {
                updated.push({
                    path: proposedEntry.path,
                    before: currentEntry,
                    after: proposedEntry,
                });
            }
        }
    }

    for (const currentEntry of current.flat) {
        const key = currentEntry.path.join('.');
        if (!proposedByPath.has(key) && removed.length < MAX_DIFF_SAMPLE_COUNT) {
            removed.push(currentEntry);
        }
    }

    const addedCount = proposed.flat.filter(entry => !currentByPath.has(entry.path.join('.'))).length;
    const removedCount = current.flat.filter(entry => !proposedByPath.has(entry.path.join('.'))).length;
    const updatedCount = proposed.flat.filter((entry) => {
        const currentEntry = currentByPath.get(entry.path.join('.'));
        return currentEntry
            ? !isEqual(getBookmarkComparable(currentEntry), getBookmarkComparable(entry))
            : false;
    }).length;

    return {
        wouldChange: addedCount > 0 || removedCount > 0 || updatedCount > 0,
        currentCount: current.flat.length,
        proposedCount: proposed.flat.length,
        addedCount,
        removedCount,
        updatedCount,
        added,
        removed,
        updated,
    };
}

export function createAgentBookmarkPlan(options: {
    input: Record<string, unknown>;
    currentBookmarks: IPdfBookmarkEntry[];
    totalPages: number;
    dirty: boolean;
    untitledTitle: string;
    actionId: string;
}): IAgentBookmarkPlan {
    requirePageCount(options.totalPages, options.actionId);
    const normalized = normalizeBookmarkTreeInput(options);
    const current = createAgentBookmarkSnapshot(options.currentBookmarks, {dirty: options.dirty});
    const proposed = createAgentBookmarkSnapshot(normalized.bookmarks, {dirty: options.dirty});
    const issues = [
        ...normalized.issues,
        ...proposed.issues,
    ];
    return {
        inputMode: normalized.inputMode,
        bookmarks: normalized.bookmarks,
        proposed,
        diff: createBookmarkDiff(current, proposed),
        issues,
    };
}

const createAgentBookmarkPlanSnapshot = createAgentBookmarkSnapshot;

type TAgentBookmarkSnapshot = ReturnType<typeof createAgentBookmarkPlanSnapshot>;
type TAgentBookmarkIssue = TAgentBookmarkSnapshot['issues'][number];

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

    function getRawAgentBookmarkPageYRatioInput(input: Record<string, unknown>) {
        if (hasAgentInputKey(input, 'pageYRatio')) {
            return input.pageYRatio;
        }
        if (hasAgentInputKey(input, 'yRatio')) {
            return input.yRatio;
        }
        if (hasAgentInputKey(input, 'pageAnchorRatio')) {
            return input.pageAnchorRatio;
        }
        return undefined;
    }

    function hasAgentBookmarkPageYRatioInput(input: Record<string, unknown>) {
        return getRawAgentBookmarkPageYRatioInput(input) !== undefined;
    }

    function normalizeAgentBookmarkPageYRatioInput(
        input: Record<string, unknown>,
        pageIndex: number | null,
        actionId: string,
    ) {
        if (pageIndex === null) {
            return null;
        }

        const value = getRawAgentBookmarkPageYRatioInput(input);
        if (value === undefined || value === null) {
            return null;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`${actionId} pageYRatio must be a finite number from 0 to 1 or null.`);
        }
        return Math.min(1, Math.max(0, value));
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
        const pageIndex = normalizeAgentBookmarkPageIndex(input, actionId);
        const namedDest = getAgentRawStringInput(input, 'namedDest')
            ?? getAgentRawStringInput(input, 'dest')
            ?? null;
        const rawItems = Array.isArray(input.items) ? input.items : input.children;
        const items = Array.isArray(rawItems)
            ? rawItems
                .filter(isAgentRecord)
                .map(item => normalizeAgentBookmarkEntry(item, actionId))
            : [];
        const color = getAgentNullableStringInput(input, 'color');
        return {
            title,
            pageIndex,
            pageYRatio: normalizeAgentBookmarkPageYRatioInput(input, pageIndex, actionId),
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

    function getBlockingBookmarkIssues(snapshot: TAgentBookmarkSnapshot) {
        return snapshot.issues.filter(issue => issue.severity === 'error');
    }

    function getBookmarkIssueKey(issue: TAgentBookmarkIssue) {
        return [
            issue.code,
            issue.path?.join('.') ?? '',
            issue.page ?? '',
        ].join('|');
    }

    function getNewBlockingBookmarkIssues(proposedBookmarks: IPdfBookmarkEntry[]) {
        const currentIssueKeys = new Set(getBlockingBookmarkIssues(createAgentBookmarkSnapshot()).map(getBookmarkIssueKey));
        const proposedSnapshot = createAgentBookmarkPlanSnapshot(proposedBookmarks, {dirty: bookmarksDirty.value});
        return getBlockingBookmarkIssues(proposedSnapshot)
            .filter(issue => !currentIssueKeys.has(getBookmarkIssueKey(issue)));
    }

    function assertAgentBookmarkChangeIsAllowed(
        proposedBookmarks: IPdfBookmarkEntry[],
        actionId: string,
    ) {
        const newBlockingIssues = getNewBlockingBookmarkIssues(proposedBookmarks);
        if (newBlockingIssues.length === 0) {
            return;
        }

        throw new Error(`${actionId} refused to apply unsafe bookmark destinations: ${newBlockingIssues[0]!.message}`);
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
        assertAgentBookmarkChangeIsAllowed(plan.bookmarks, actionId);
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
        assertAgentBookmarkChangeIsAllowed(plan.bookmarks, actionId);
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
        assertAgentBookmarkChangeIsAllowed(bookmarks, actionId);
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
        assertAgentBookmarkChangeIsAllowed(bookmarks, actionId);
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
            updated.pageYRatio = normalizeAgentBookmarkPageYRatioInput(bookmarkUpdates, updated.pageIndex, actionId);
        }
        if (hasAgentBookmarkPageYRatioInput(bookmarkUpdates)) {
            updated.pageYRatio = normalizeAgentBookmarkPageYRatioInput(bookmarkUpdates, updated.pageIndex, actionId);
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
        const rawUpdatedItems = Array.isArray(bookmarkUpdates.items) ? bookmarkUpdates.items : bookmarkUpdates.children;
        if (Array.isArray(rawUpdatedItems)) {
            updated.items = rawUpdatedItems
                .filter(isAgentRecord)
                .map(item => normalizeAgentBookmarkEntry(item, actionId));
        }
        location.list.splice(location.index, 1, updated);
        assertAgentBookmarkChangeIsAllowed(bookmarks, actionId);
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
