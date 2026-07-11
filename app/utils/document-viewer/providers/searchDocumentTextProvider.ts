import type { IDocumentTextProvider } from '@app/utils/document-viewer/source/documentPageSource';

export interface IDocumentTextSearchResult {
    pageNumber: number;
    excerpt: string;
}

export async function searchDocumentTextProvider(options: {
    provider: IDocumentTextProvider;
    pageCount: number;
    query: string;
    signal: AbortSignal;
}) {
    const needle = options.query.trim().toLocaleLowerCase();
    if (!needle) {
        return [] as IDocumentTextSearchResult[];
    }
    const results: IDocumentTextSearchResult[] = [];
    for (let pageNumber = 1; pageNumber <= options.pageCount; pageNumber += 1) {
        options.signal.throwIfAborted();
        const text = await options.provider.getPageText(pageNumber, options.signal);
        const index = text.toLocaleLowerCase().indexOf(needle);
        if (index >= 0) {
            results.push({
                pageNumber,
                excerpt: text.slice(Math.max(0, index - 40), index + needle.length + 80),
            });
        }
    }
    return results;
}
