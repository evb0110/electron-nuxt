import {
    normalizeOptionalSearchPageCount,
    validateSearchQuery as validateSharedSearchQuery,
} from '@contracts/search';

export const SEARCH_PAGE_COUNT_MAX = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_PAGE_COUNT_MAX ?? '20000', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 20_000;
    }
    return Math.min(parsed, 1_000_000);
})();

export function validateSearchQuery(query: string, options: {
    matchCase?: boolean | undefined;
    wholeWord?: boolean | undefined;
    useRegex?: boolean | undefined;
}) {
    validateSharedSearchQuery(query, options);
}

export function parseOptionalSearchPageCount(raw: unknown) {
    return normalizeOptionalSearchPageCount(raw, SEARCH_PAGE_COUNT_MAX);
}
