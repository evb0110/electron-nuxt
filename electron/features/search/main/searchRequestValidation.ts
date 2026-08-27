import { validateSearchQuery as validateSharedSearchQuery } from '@pdf-core';
import { normalizeOptionalSearchPageCount } from '@electron/features/search/searchRequestPayload';

export function validateSearchQuery(query: string, options: {
    matchCase?: boolean | undefined;
    wholeWord?: boolean | undefined;
    useRegex?: boolean | undefined;
}) {
    validateSharedSearchQuery(query, {
        ...(options.matchCase === undefined ? {} : {matchCase: options.matchCase}),
        ...(options.wholeWord === undefined ? {} : {wholeWord: options.wholeWord}),
        ...(options.useRegex === undefined ? {} : {useRegex: options.useRegex}),
    });
}

export function parseOptionalSearchPageCount(raw: unknown) {
    return normalizeOptionalSearchPageCount(raw);
}
