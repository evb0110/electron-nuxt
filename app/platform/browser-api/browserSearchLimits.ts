export {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@contracts/search';

export const BROWSER_SEARCH_MAX_PAGE_COUNT = 1_000_000;
const BROWSER_SEARCH_MAX_QUERY_COST = 8_000_000;

export function validateBrowserSearchPageCount(pageCount: number) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > BROWSER_SEARCH_MAX_PAGE_COUNT) {
        throw new Error(`browser search page count exceeds ${BROWSER_SEARCH_MAX_PAGE_COUNT}`);
    }
    return pageCount;
}

export function validateBrowserSearchQueryCost(query: string, pageCount: number | undefined) {
    if (pageCount !== undefined && query.length * pageCount > BROWSER_SEARCH_MAX_QUERY_COST) {
        throw new Error(`browser search query cost exceeds ${BROWSER_SEARCH_MAX_QUERY_COST}`);
    }
    return query;
}
