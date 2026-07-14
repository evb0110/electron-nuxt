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
    return items.map((item, index) => {
        const itemPath = [
            ...path,
            index,
        ];
        return {
            id: createBookmarkId(itemPath),
            title: normalizeTitle(item.title),
            pageNumber: item.pageNumber,
            children: createDocumentBookmarkTree(item.children, itemPath),
        };
    });
}

export function getDocumentBookmarkActivePath(
    items: readonly IDocumentBookmarkTreeItem[],
    currentPage: number,
) {
    let bestPath: string[] = [];
    let bestPage = Number.NEGATIVE_INFINITY;

    function visit(nodes: readonly IDocumentBookmarkTreeItem[], path: readonly string[]) {
        for (const item of nodes) {
            const nextPath = [
                ...path,
                item.id,
            ];
            if (item.pageNumber !== null && item.pageNumber <= currentPage && item.pageNumber >= bestPage) {
                bestPage = item.pageNumber;
                bestPath = nextPath;
            }
            visit(item.children, nextPath);
        }
    }

    visit(items, []);
    return bestPath;
}

export function findDocumentBookmark(
    items: readonly IDocumentBookmarkTreeItem[],
    id: string,
): IDocumentBookmarkTreeItem | null {
    for (const item of items) {
        if (item.id === id) {
            return item;
        }
        const child = findDocumentBookmark(item.children, id);
        if (child) {
            return child;
        }
    }
    return null;
}
