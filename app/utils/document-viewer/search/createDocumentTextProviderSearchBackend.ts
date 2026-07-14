import type { IDocumentTextProvider } from '@app/utils/document-viewer/source/documentPageSource';
import { searchDocumentTextProvider } from '@app/utils/document-viewer/providers/documentSearch';
import type { IDocumentSearchBackend } from '@app/utils/document-viewer/search/documentSearch';

const DOCUMENT_TEXT_PROVIDER_MIN_QUERY_LENGTH = 2;

export function createDocumentTextProviderSearchBackend(options: {
    provider: IDocumentTextProvider;
    pageCount: number;
}): IDocumentSearchBackend {
    return {
        minQueryLength: DOCUMENT_TEXT_PROVIDER_MIN_QUERY_LENGTH,
        search: request => searchDocumentTextProvider({
            provider: options.provider,
            pageCount: options.pageCount,
            query: request.query,
            matchOptions: request.matchOptions,
            signal: request.signal,
            onProgress: request.onProgress,
        }),
    };
}
