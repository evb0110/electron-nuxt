import { assertSafePdfSearchRegex } from '@contracts/search';

const SEARCH_PAGE_COUNT_MAX = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_PAGE_COUNT_MAX ?? '20000', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 20_000;
    }
    return Math.min(parsed, 1_000_000);
})();

const SEARCH_QUERY_MAX_LENGTH = 2_048;
const SEARCH_REGEX_QUERY_MAX_LENGTH = 512;

function assertSearchQueryWithinLimit(query: string, useRegex: boolean) {
    const maxLength = useRegex ? SEARCH_REGEX_QUERY_MAX_LENGTH : SEARCH_QUERY_MAX_LENGTH;
    if (query.length > maxLength) {
        throw new Error(`Invalid search query: maximum length is ${maxLength} characters`);
    }
}

function assertSearchRegexIsAllowed(query: string, options: {
    matchCase?: boolean | undefined;
    wholeWord?: boolean | undefined;
}) {
    assertSafePdfSearchRegex(query, {
        matchCase: Boolean(options.matchCase),
        wholeWord: Boolean(options.wholeWord),
    });
}

export function validateSearchQuery(query: string, options: {
    matchCase?: boolean | undefined;
    wholeWord?: boolean | undefined;
    useRegex?: boolean | undefined;
}) {
    const useRegex = options.useRegex === true;
    assertSearchQueryWithinLimit(query, useRegex);
    if (useRegex && query.length > 0) {
        assertSearchRegexIsAllowed(query, options);
    }
}

export function parseOptionalSearchPageCount(raw: unknown) {
    if (raw === undefined) {
        return undefined;
    }

    if (
        typeof raw !== 'number'
        || !Number.isSafeInteger(raw)
        || raw < 1
        || raw > SEARCH_PAGE_COUNT_MAX
    ) {
        throw new Error(`Invalid pageCount: must be an integer between 1 and ${SEARCH_PAGE_COUNT_MAX}`);
    }

    return raw;
}
