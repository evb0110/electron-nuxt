import { SEARCH_RESULT_LIMIT } from '@electron/config/constants';
import type {
    ISearchResponse,
    TSearchWorkerOutboundMessage,
} from '@electron/features/search/protocol';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/workerMessage';
import { parsePageNumber } from '@contracts/pageNumbers';
import { isOcrWord } from '@contracts/shared';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';

type TSearchMatch = ISearchResponse['results'][number];

const SEARCH_OUTBOUND_RESULT_LIMIT = Math.max(1, SEARCH_RESULT_LIMIT);
const SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS = 4_096;
const SEARCH_OUTBOUND_WORD_LIMIT = 2_048;
const SEARCH_OUTBOUND_WORD_TEXT_MAX_CHARS = 4_096;

function parseSearchExcerpt(value: unknown) {
    if (!isWorkerMessageRecord(value)) {
        return null;
    }
    if (
        typeof value.prefix !== 'boolean'
        || typeof value.suffix !== 'boolean'
        || typeof value.before !== 'string'
        || typeof value.match !== 'string'
        || typeof value.after !== 'string'
    ) {
        return null;
    }
    return {
        prefix: value.prefix,
        suffix: value.suffix,
        before: value.before,
        match: value.match,
        after: value.after,
    };
}

function parseNonNegativeWorkerInteger(value: unknown) {
    if (!isFiniteWorkerMessageNumber(value) || !Number.isSafeInteger(value) || value < 0) {
        return null;
    }
    return value;
}

function parsePositiveWorkerNumber(value: unknown) {
    return isFiniteWorkerMessageNumber(value) && value > 0
        ? value
        : undefined;
}

function parseOcrRotation(value: unknown): TOcrIndexRotation | undefined {
    return value === 0 || value === 90 || value === 180 || value === 270
        ? value
        : undefined;
}

function trimSearchTextSegment(value: string, maxLength: number, fromEnd = false) {
    if (value.length <= maxLength) {
        return {
            value,
            truncated: false,
        };
    }
    return {
        value: fromEnd ? value.slice(-maxLength) : value.slice(0, maxLength),
        truncated: true,
    };
}

function capSearchMatch(match: TSearchMatch) {
    let truncated = false;
    const before = trimSearchTextSegment(match.excerpt.before, SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS, true);
    const matchedText = trimSearchTextSegment(match.excerpt.match, SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS);
    const after = trimSearchTextSegment(match.excerpt.after, SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS);
    truncated = before.truncated || matchedText.truncated || after.truncated;

    let words = match.words;
    if (words !== undefined) {
        if (words.length > SEARCH_OUTBOUND_WORD_LIMIT) {
            words = words.slice(0, SEARCH_OUTBOUND_WORD_LIMIT);
            truncated = true;
        }
        words = words.map((word) => {
            if (word.text.length <= SEARCH_OUTBOUND_WORD_TEXT_MAX_CHARS) {
                return word;
            }
            truncated = true;
            return {
                ...word,
                text: word.text.slice(0, SEARCH_OUTBOUND_WORD_TEXT_MAX_CHARS),
            };
        });
    }

    return {
        match: {
            ...match,
            excerpt: {
                prefix: match.excerpt.prefix || before.truncated,
                suffix: match.excerpt.suffix || after.truncated || matchedText.truncated,
                before: before.value,
                match: matchedText.value,
                after: after.value,
            },
            ...(words === undefined ? {} : {words}),
        } satisfies TSearchMatch,
        truncated,
    };
}

export function capSearchResponse(
    response: ISearchResponse,
    maxResults = SEARCH_OUTBOUND_RESULT_LIMIT,
): ISearchResponse {
    let truncated = response.truncated || response.results.length > maxResults;
    const results: TSearchMatch[] = [];
    for (const result of response.results.slice(0, maxResults)) {
        const capped = capSearchMatch(result);
        results.push(capped.match);
        truncated = truncated || capped.truncated;
    }
    return {
        results,
        truncated,
        ...(response.canceled === undefined ? {} : {canceled: response.canceled}),
    };
}

function parseSearchMatch(value: unknown, pageCount?: number) {
    if (!isWorkerMessageRecord(value)) {
        return null;
    }
    const excerpt = parseSearchExcerpt(value.excerpt);
    if (!excerpt) {
        return null;
    }
    const pageNumber = isFiniteWorkerMessageNumber(value.pageNumber)
        ? parsePageNumber(value.pageNumber, pageCount)
        : null;
    const pageMatchIndex = parseNonNegativeWorkerInteger(value.pageMatchIndex);
    const matchIndex = parseNonNegativeWorkerInteger(value.matchIndex);
    const startOffset = parseNonNegativeWorkerInteger(value.startOffset);
    const endOffset = parseNonNegativeWorkerInteger(value.endOffset);
    if (
        pageNumber === null
        || pageMatchIndex === null
        || matchIndex === null
        || startOffset === null
        || endOffset === null
        || endOffset < startOffset
    ) {
        return null;
    }
    const words = Array.isArray(value.words) && value.words.every(isOcrWord) ? value.words : undefined;
    const pageWidth = parsePositiveWorkerNumber(value.pageWidth);
    const pageHeight = parsePositiveWorkerNumber(value.pageHeight);
    const rotation = parseOcrRotation(value.rotation);
    return {
        pageNumber,
        pageMatchIndex,
        matchIndex,
        startOffset,
        endOffset,
        excerpt,
        ...(words !== undefined ? { words } : {}),
        ...(pageWidth !== undefined ? { pageWidth } : {}),
        ...(pageHeight !== undefined ? { pageHeight } : {}),
        ...(rotation !== undefined ? { rotation } : {}),
    };
}

function parseSearchResponse(value: unknown, pageCount?: number) {
    if (!isWorkerMessageRecord(value) || !Array.isArray(value.results) || typeof value.truncated !== 'boolean') {
        return null;
    }
    if (value.canceled !== undefined && typeof value.canceled !== 'boolean') {
        return null;
    }
    const results: TSearchMatch[] = [];
    for (const result of value.results) {
        const parsedResult = parseSearchMatch(result, pageCount);
        if (!parsedResult) {
            return null;
        }
        results.push(parsedResult);
    }
    return capSearchResponse({
        results,
        truncated: value.truncated,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
    });
}

export function parseSearchWorkerOutboundMessage(
    value: unknown,
    resolvePageCount: (requestId: string) => number | undefined,
): TSearchWorkerOutboundMessage | null {
    if (!isWorkerMessageRecord(value) || typeof value.type !== 'string' || typeof value.requestId !== 'string') {
        return null;
    }
    const pageCount = resolvePageCount(value.requestId);
    switch (value.type) {
        case 'progress': {
            if (
                !isFiniteWorkerMessageNumber(value.processed)
                || !isFiniteWorkerMessageNumber(value.total)
                || value.processed < 0
                || value.total < 0
                || (value.results !== undefined && !Array.isArray(value.results))
            ) {
                return null;
            }
            const parsedResultsStartIndex = value.resultsStartIndex === undefined
                ? undefined
                : parseNonNegativeWorkerInteger(value.resultsStartIndex);
            if (parsedResultsStartIndex === null) {
                return null;
            }
            const resultsStartIndex = parsedResultsStartIndex;
            if (value.truncated !== undefined && typeof value.truncated !== 'boolean') {
                return null;
            }
            if (value.canceled !== undefined && typeof value.canceled !== 'boolean') {
                return null;
            }
            if (Array.isArray(value.results)) {
                const results: TSearchMatch[] = [];
                for (const result of value.results) {
                    const parsedResult = parseSearchMatch(result, pageCount);
                    if (!parsedResult) {
                        return null;
                    }
                    results.push(parsedResult);
                }
                const maxResults = resultsStartIndex === undefined
                    ? SEARCH_OUTBOUND_RESULT_LIMIT
                    : Math.max(0, SEARCH_OUTBOUND_RESULT_LIMIT - resultsStartIndex);
                const cappedResponse = capSearchResponse({
                    results,
                    truncated: Boolean(value.truncated),
                    ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
                }, maxResults);
                return {
                    type: 'progress',
                    requestId: value.requestId,
                    processed: value.processed,
                    total: value.total,
                    results: cappedResponse.results,
                    ...(resultsStartIndex === undefined ? {} : {resultsStartIndex}),
                    truncated: cappedResponse.truncated,
                    ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
                };
            }
            return {
                type: 'progress',
                requestId: value.requestId,
                processed: value.processed,
                total: value.total,
                ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
            };
        }
        case 'complete': {
            const response = parseSearchResponse(value.response, pageCount);
            return response ? {
                type: 'complete',
                requestId: value.requestId,
                response,
            } : null;
        }
        case 'cancelled':
            return {
                type: 'cancelled',
                requestId: value.requestId,
            };
        case 'error':
            return typeof value.error === 'string'
                ? {
                    type: 'error',
                    requestId: value.requestId,
                    error: value.error,
                }
                : null;
        default:
            return null;
    }
}

export function getSearchWorkerOutboundRequestId(value: unknown) {
    return isWorkerMessageRecord(value) && typeof value.requestId === 'string'
        ? value.requestId
        : null;
}
