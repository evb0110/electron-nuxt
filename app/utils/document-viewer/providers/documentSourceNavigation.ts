import type {
    IDocumentOutlineItem,
    IDocumentPageSource,
} from '@app/utils/document-viewer/source/documentPageSource';

export interface IDocumentFlatOutlineItem {
    title: string;
    pageNumber: number | null;
    depth: number;
}

export interface IDocumentTextSearchResult {
    pageNumber: number;
    excerpt: string;
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

export async function searchDocumentText(
    source: IDocumentPageSource,
    query: string,
    signal: AbortSignal,
): Promise<IDocumentTextSearchResult[]> {
    const provider = source.textProvider;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!provider || normalizedQuery.length < 2) {
        return [];
    }
    const results: IDocumentTextSearchResult[] = [];
    for (let pageNumber = 1; pageNumber <= source.pageCount; pageNumber += 1) {
        signal.throwIfAborted();
        const text = await provider.getPageText(pageNumber, signal);
        const index = text.toLocaleLowerCase().indexOf(normalizedQuery);
        if (index >= 0) {
            results.push({
                pageNumber,
                excerpt: text
                    .slice(Math.max(0, index - 36), Math.min(text.length, index + normalizedQuery.length + 72))
                    .replace(/\s+/gu, ' '),
            });
        }
    }
    return results;
}
