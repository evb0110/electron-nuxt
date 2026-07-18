import type { IDocumentOutlineItem } from '@app/utils/document-viewer/source/documentPageSource';

export type TDocumentBookmarkDisplayMode = 'top-level' | 'all-expanded' | 'current-expanded';

export interface IDocumentBookmarkTreeItem {
    id: string;
    title: string;
    pageNumber: number | null;
    children: IDocumentBookmarkTreeItem[];
    bold?: boolean | undefined;
    italic?: boolean | undefined;
    color?: string | null | undefined;
}

function normalizeTitle(title: string) {
    return title.trim();
}

function createBookmarkId(path: readonly number[]) {
    return `document-bookmark-${path.join('-')}`;
}

export function createDocumentBookmarkTree(
    items: readonly IDocumentOutlineItem[],
    path: readonly number[] = [],
): IDocumentBookmarkTreeItem[] {
    const result: IDocumentBookmarkTreeItem[] = [];
    const stack = items.toReversed().map((item, reverseIndex) => ({
        item,
        itemPath: [
            ...path,
            items.length - reverseIndex - 1,
        ],
        target: result,
    }));
    while (stack.length > 0) {
        const entry = stack.pop()!;
        const mapped: IDocumentBookmarkTreeItem = {
            id: createBookmarkId(entry.itemPath),
            title: normalizeTitle(entry.item.title),
            pageNumber: entry.item.pageNumber,
            children: [],
        };
        entry.target.push(mapped);
        for (let index = entry.item.children.length - 1; index >= 0; index -= 1) {
            stack.push({
                item: entry.item.children[index]!,
                itemPath: [
                    ...entry.itemPath,
                    index,
                ],
                target: mapped.children,
            });
        }
    }
    return result;
}

export function getDocumentBookmarkActivePath(
    items: readonly IDocumentBookmarkTreeItem[],
    currentPage: number,
) {
    let bestPath: string[] = [];
    let bestPage = Number.NEGATIVE_INFINITY;

    const stack = items.toReversed().map(item => ({
        item,
        path: [item.id],
    }));
    while (stack.length > 0) {
        const {
            item,
            path,
        } = stack.pop()!;
        if (item.pageNumber !== null && item.pageNumber <= currentPage && item.pageNumber >= bestPage) {
            bestPage = item.pageNumber;
            bestPath = path;
        }
        for (let index = item.children.length - 1; index >= 0; index -= 1) {
            const child = item.children[index]!;
            stack.push({
                item: child,
                path: [
                    ...path,
                    child.id,
                ],
            });
        }
    }
    return bestPath;
}

export function findDocumentBookmark(
    items: readonly IDocumentBookmarkTreeItem[],
    id: string,
): IDocumentBookmarkTreeItem | null {
    const stack = items.toReversed();
    while (stack.length > 0) {
        const item = stack.pop()!;
        if (item.id === id) {
            return item;
        }
        stack.push(...item.children.toReversed());
    }
    return null;
}
