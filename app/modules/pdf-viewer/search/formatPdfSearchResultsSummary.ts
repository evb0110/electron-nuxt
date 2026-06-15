import type { TTranslateFn } from '@i18n-app';

interface IPdfSearchResultsSummaryOptions {
    isSearching: boolean;
    query: string;
    resultCount: number;
    t: TTranslateFn;
}

export function formatPdfSearchResultsSummary(options: IPdfSearchResultsSummaryOptions) {
    const {
        isSearching,
        query,
        resultCount,
        t,
    } = options;

    if (isSearching && resultCount === 0) {
        return t('searchResults.searching');
    }

    return `${t('searchResults.resultCount', { count: resultCount })} ${t('searchResults.forQuery', { query })}`;
}
