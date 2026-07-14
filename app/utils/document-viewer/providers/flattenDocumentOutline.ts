import type {IDocumentOutlineItem} from '@app/utils/document-viewer/source/documentPageSource';

export interface IDocumentFlatOutlineItem {
    title: string;
    pageNumber: number | null;
    depth: number;
}

export function flattenDocumentOutline(
    items: readonly IDocumentOutlineItem[],
    depth = 0,
): IDocumentFlatOutlineItem[] {
    return items.flatMap(item => [
        {
            title: item.title,
            pageNumber: item.pageNumber,
            depth,
        },
        ...flattenDocumentOutline(item.children, depth + 1),
    ]);
}
