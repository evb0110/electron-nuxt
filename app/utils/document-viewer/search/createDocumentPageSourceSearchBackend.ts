import type {
    IDocumentPageSource,
    IDocumentSearchProvider,
} from '@app/utils/document-viewer/source/documentPageSource';
import { createDocumentTextProviderSearchBackend } from '@app/utils/document-viewer/search/createDocumentTextProviderSearchBackend';
import type { IDocumentSearchBackend } from '@app/utils/document-viewer/search/documentSearch';

const DOCUMENT_SOURCE_MIN_QUERY_LENGTH = 2;
let nextDocumentSourceSearchRequestId = 0;

function createProviderBackend(provider: IDocumentSearchProvider): IDocumentSearchBackend {
    return {
        minQueryLength: DOCUMENT_SOURCE_MIN_QUERY_LENGTH,
        async search(request) {
            const response = await provider.search({
                ...request,
                requestId: `document-source-search-${String(++nextDocumentSourceSearchRequestId)}`,
                onProgress: progress => request.onProgress?.({
                    processed: progress.processed,
                    total: progress.total,
                }),
            });
            return {
                results: response.results.map(result => ({
                    pageIndex: Number(result.pageNumber) - 1,
                    pageMatchIndex: result.pageMatchIndex,
                    matchIndex: result.matchIndex,
                    startOffset: result.startOffset,
                    endOffset: result.endOffset,
                    excerpt: result.excerpt,
                    ...(result.words === undefined ? {} : {words: result.words}),
                    ...(result.pageWidth === undefined ? {} : {pageWidth: result.pageWidth}),
                    ...(result.pageHeight === undefined ? {} : {pageHeight: result.pageHeight}),
                    ...(result.rotation === undefined ? {} : {rotation: result.rotation}),
                })),
                truncated: response.truncated,
            };
        },
    };
}

/** Prefers a source's indexed/native search and falls back to page-text scanning. */
export function createDocumentPageSourceSearchBackend(
    source: IDocumentPageSource | null,
): IDocumentSearchBackend | null {
    if (source?.searchProvider) {
        return createProviderBackend(source.searchProvider);
    }
    if (source?.textProvider) {
        return createDocumentTextProviderSearchBackend({
            provider: source.textProvider,
            pageCount: source.pageCount,
        });
    }
    return null;
}
