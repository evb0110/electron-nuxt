import type { IPdfSearchRequestOptions } from '@contracts/search';
import { isRecord } from '@contracts/runtimeGuards';
import { validateSearchQuery } from '@pdf-core';

export interface INormalizedPdfSearchRequest extends IPdfSearchRequestOptions {
    pdfPath: string;
    query: string;
}

export interface INormalizedPdfSearchWarmIndexRequest extends IPdfSearchRequestOptions {pdfPath: string;}

export const SEARCH_REQUEST_ID_MAX_LENGTH = 128;
export const SEARCH_PDF_PATH_MAX_LENGTH = 4_096;
export const SEARCH_PAGE_COUNT_DEFAULT_MAX = 20_000;

export function normalizeOptionalSearchRequestId(raw: unknown) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== 'string') {
        throw new Error('requestId must be a string');
    }
    const requestId = raw.trim();
    if (!requestId) {
        return undefined;
    }
    if (requestId.length > SEARCH_REQUEST_ID_MAX_LENGTH) {
        throw new Error(`requestId exceeds maximum length (${SEARCH_REQUEST_ID_MAX_LENGTH})`);
    }
    return requestId;
}

export function normalizeOptionalSearchPageCount(
    raw: unknown,
    maxPageCount = SEARCH_PAGE_COUNT_DEFAULT_MAX,
) {
    if (raw === undefined) {
        return undefined;
    }

    if (
        typeof raw !== 'number'
        || !Number.isSafeInteger(raw)
        || raw < 1
        || raw > maxPageCount
    ) {
        throw new Error(`Invalid pageCount: must be an integer between 1 and ${maxPageCount}`);
    }

    return raw;
}

function normalizeSearchPdfPath(raw: unknown) {
    const pdfPath = typeof raw === 'string' ? raw.trim() : '';
    if (!pdfPath) {
        throw new Error('Invalid PDF path');
    }
    if (pdfPath.length > SEARCH_PDF_PATH_MAX_LENGTH) {
        throw new Error(`Invalid PDF path: maximum length is ${SEARCH_PDF_PATH_MAX_LENGTH} characters`);
    }
    return pdfPath;
}

function normalizeSearchBooleanOption(raw: unknown) {
    return typeof raw === 'boolean' ? raw : undefined;
}

export function normalizePdfSearchRequestPayload(
    raw: unknown,
    options: {pageCountMax?: number;} = {},
): INormalizedPdfSearchRequest {
    if (!isRecord(raw)) {
        throw new Error('Invalid search request payload');
    }
    if (typeof raw.query !== 'string') {
        throw new Error('Invalid search query');
    }

    const pageCount = normalizeOptionalSearchPageCount(raw.pageCount, options.pageCountMax);
    const requestId = normalizeOptionalSearchRequestId(raw.requestId);
    const matchCase = normalizeSearchBooleanOption(raw.matchCase);
    const wholeWord = normalizeSearchBooleanOption(raw.wholeWord);
    const useRegex = normalizeSearchBooleanOption(raw.useRegex);
    validateSearchQuery(raw.query, {
        matchCase,
        wholeWord,
        useRegex,
    });

    return {
        pdfPath: normalizeSearchPdfPath(raw.pdfPath),
        query: raw.query,
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(matchCase === undefined ? {} : {matchCase}),
        ...(wholeWord === undefined ? {} : {wholeWord}),
        ...(useRegex === undefined ? {} : {useRegex}),
    };
}

export function normalizePdfSearchWarmIndexPayload(
    raw: unknown,
    options: {pageCountMax?: number;} = {},
): INormalizedPdfSearchWarmIndexRequest {
    if (!isRecord(raw)) {
        throw new Error('Invalid warm-index payload');
    }

    const pageCount = normalizeOptionalSearchPageCount(raw.pageCount, options.pageCountMax);
    const requestId = normalizeOptionalSearchRequestId(raw.requestId);

    return {
        pdfPath: normalizeSearchPdfPath(raw.pdfPath),
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(requestId === undefined ? {} : {requestId}),
    };
}
