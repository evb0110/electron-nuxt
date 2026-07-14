import type { IResolvedSearchMatchOptions } from '@contracts/search';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@contracts/search';
import {
    buildPdfSearchExcerpt,
    findPdfSearchMatches,
    validateSearchQuery,
} from '@pdf-core';
import type { IDocumentTextProvider } from '@app/utils/document-viewer/source/documentPageSource';
import type {
    IDocumentSearchMatch,
    IDocumentSearchProgress,
    IDocumentSearchResponse,
} from '@app/utils/document-viewer/search/documentSearch';

export type {
    IDocumentSearchMatch,
    IDocumentSearchProgress,
    IDocumentSearchResponse,
} from '@app/utils/document-viewer/search/documentSearch';

export const DEFAULT_DOCUMENT_SEARCH_OPTIONS: IResolvedSearchMatchOptions = Object.freeze({
    matchCase: false,
    wholeWord: false,
    useRegex: false,
});

export async function searchDocumentTextProvider(options: {
    provider: IDocumentTextProvider;
    pageCount: number;
    query: string;
    matchOptions: IResolvedSearchMatchOptions;
    signal: AbortSignal;
    onProgress?: ((progress: IDocumentSearchProgress) => void) | undefined;
}): Promise<IDocumentSearchResponse> {
    const query = options.query.trim();
    if (!query) {
        return {
            results: [],
            truncated: false,
        };
    }

    validateSearchQuery(query, options.matchOptions);
    const results: IDocumentSearchMatch[] = [];

    for (let pageNumber = 1; pageNumber <= options.pageCount; pageNumber += 1) {
        options.signal.throwIfAborted();
        const text = await options.provider.getPageText(pageNumber, options.signal);
        options.signal.throwIfAborted();
        const pageMatches = findPdfSearchMatches(text, query, options.matchOptions);

        for (const [
            pageMatchIndex,
            match,
        ] of pageMatches.entries()) {
            if (results.length >= SEARCH_RESULT_LIMIT) {
                return {
                    results,
                    truncated: true,
                };
            }
            results.push({
                pageIndex: pageNumber - 1,
                pageMatchIndex,
                matchIndex: results.length,
                startOffset: match.startOffset,
                endOffset: match.endOffset,
                excerpt: buildPdfSearchExcerpt(
                    text,
                    match.startOffset,
                    match.endOffset,
                    SEARCH_EXCERPT_CONTEXT_CHARS,
                ),
            });
        }

        options.onProgress?.({
            processed: pageNumber,
            total: options.pageCount,
        });
    }

    return {
        results,
        truncated: false,
    };
}
