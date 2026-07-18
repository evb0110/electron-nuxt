import {
    parsePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import {
    isOcrWord,
    type IOcrWord,
} from '@contracts/shared';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { isRecord } from '@contracts/runtimeGuards';

/** Shared user-visible search limits. Keep every runtime on these values. */
export const SEARCH_RESULT_LIMIT = 500;
export const SEARCH_EXCERPT_CONTEXT_CHARS = 56;

export interface IPdfSearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

export type TPdfSearchUtf16Offset = number;

export interface IPdfSearchUtf16Range {
    startOffset: TPdfSearchUtf16Offset;
    endOffset: TPdfSearchUtf16Offset;
}

export interface IPdfSearchResult {
    pageNumber: TPageNumber;
    pageMatchIndex: number;
    matchIndex: number;
    startOffset: TPdfSearchUtf16Offset;
    endOffset: TPdfSearchUtf16Offset;
    excerpt: IPdfSearchExcerpt;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
    rotation?: TOcrIndexRotation;
}

export interface IPdfSearchResponse {
    results: IPdfSearchResult[];
    truncated: boolean;
    canceled?: boolean;
}

function decodeSearchExcerpt(value: unknown): IPdfSearchExcerpt | null {
    if (
        !isRecord(value)
        || typeof value.prefix !== 'boolean'
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

function decodeSearchResult(value: unknown, pageCount?: number): IPdfSearchResult | null {
    if (!isRecord(value)) {
        return null;
    }
    const pageNumber = typeof value.pageNumber === 'number'
        ? parsePageNumber(value.pageNumber, pageCount)
        : null;
    const excerpt = decodeSearchExcerpt(value.excerpt);
    const isNonNegativeInteger = (candidate: unknown): candidate is number => (
        typeof candidate === 'number'
        && Number.isSafeInteger(candidate)
        && candidate >= 0
    );
    if (
        pageNumber === null
        || !isNonNegativeInteger(value.pageMatchIndex)
        || !isNonNegativeInteger(value.matchIndex)
        || !isNonNegativeInteger(value.startOffset)
        || !isNonNegativeInteger(value.endOffset)
        || value.endOffset < value.startOffset
        || excerpt === null
        || (value.words !== undefined && (!Array.isArray(value.words) || !value.words.every(isOcrWord)))
        || (value.pageWidth !== undefined && (typeof value.pageWidth !== 'number' || !Number.isFinite(value.pageWidth) || value.pageWidth <= 0))
        || (value.pageHeight !== undefined && (typeof value.pageHeight !== 'number' || !Number.isFinite(value.pageHeight) || value.pageHeight <= 0))
        || (value.rotation !== undefined && value.rotation !== 0 && value.rotation !== 90 && value.rotation !== 180 && value.rotation !== 270)
    ) {
        return null;
    }
    return {
        pageNumber,
        pageMatchIndex: value.pageMatchIndex,
        matchIndex: value.matchIndex,
        startOffset: value.startOffset,
        endOffset: value.endOffset,
        excerpt,
        ...(value.words === undefined ? {} : {words: value.words}),
        ...(value.pageWidth === undefined ? {} : {pageWidth: value.pageWidth}),
        ...(value.pageHeight === undefined ? {} : {pageHeight: value.pageHeight}),
        ...(value.rotation === undefined ? {} : {rotation: value.rotation}),
    };
}

function decodeSearchResponse(value: unknown, pageCount?: number): IPdfSearchResponse | null {
    if (
        !isRecord(value)
        || !Array.isArray(value.results)
        || value.results.length > SEARCH_RESULT_LIMIT
        || typeof value.truncated !== 'boolean'
        || (value.canceled !== undefined && typeof value.canceled !== 'boolean')
    ) {
        return null;
    }
    const results: IPdfSearchResult[] = [];
    for (const result of value.results) {
        const decoded = decodeSearchResult(result, pageCount);
        if (decoded === null) {
            return null;
        }
        results.push(decoded);
    }
    return {
        results,
        truncated: value.truncated,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
    };
}

/** The sole runtime decoder for search results crossing worker, IPC, or native boundaries. */
export const SEARCH_WIRE_CODEC = {
    decodeExcerpt: decodeSearchExcerpt,
    decodeResult: decodeSearchResult,
    decodeResponse: decodeSearchResponse,
} as const;

export interface IPdfSearchProgress {
    requestId: string;
    processed: number;
    total: number;
    results?: IPdfSearchResult[];
    resultsStartIndex?: number;
    truncated?: boolean;
    canceled?: boolean;
    status?: 'running' | 'success' | 'canceled' | 'failed';
    error?: string;
}

export type TSearchErrorCode =
    | 'SEARCH_INVALID_PAYLOAD'
    | 'SEARCH_PATH_DENIED'
    | 'SEARCH_WORKER_LIMIT'
    | 'SEARCH_WORKER_PROTOCOL'
    | 'SEARCH_TIMEOUT'
    | 'SEARCH_WORKER_ERROR'
    | 'SEARCH_INTERNAL';

export interface ISearchErrorEnvelope {
    code: TSearchErrorCode;
    message: string;
    retryable: boolean;
    timestamp: number;
    details?: string;
}

export interface ISearchErrorEnvelopeCarrier {errorEnvelope?: ISearchErrorEnvelope;}

export function isSearchErrorEnvelope(value: unknown): value is ISearchErrorEnvelope {
    return isRecord(value)
        && typeof value.code === 'string'
        && [
            'SEARCH_INVALID_PAYLOAD',
            'SEARCH_PATH_DENIED',
            'SEARCH_WORKER_LIMIT',
            'SEARCH_WORKER_PROTOCOL',
            'SEARCH_TIMEOUT',
            'SEARCH_WORKER_ERROR',
            'SEARCH_INTERNAL',
        ].includes(value.code)
        && typeof value.message === 'string'
        && typeof value.retryable === 'boolean'
        && typeof value.timestamp === 'number'
        && (value.details === undefined || typeof value.details === 'string');
}

export function findSearchErrorEnvelope(value: unknown): ISearchErrorEnvelope | null {
    if (!isRecord(value)) {
        return null;
    }
    if (isSearchErrorEnvelope(value.errorEnvelope)) {
        return value.errorEnvelope;
    }
    return findSearchErrorEnvelope(value.cause);
}

export interface ISearchMatchOptions {
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
}

export interface IResolvedSearchMatchOptions {
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}

/** Exhaustive option semantics; consumers must not invent additional combinations. */
export const SEARCH_OPTION_SEMANTICS = [
    {
        matchCase: false,
        wholeWord: false,
        useRegex: false,
        matcher: 'literal-unicode-fold',
    },
    {
        matchCase: true,
        wholeWord: false,
        useRegex: false,
        matcher: 'literal-exact',
    },
    {
        matchCase: false,
        wholeWord: true,
        useRegex: false,
        matcher: 'literal-unicode-fold-boundary',
    },
    {
        matchCase: true,
        wholeWord: true,
        useRegex: false,
        matcher: 'literal-exact-boundary',
    },
    {
        matchCase: false,
        wholeWord: false,
        useRegex: true,
        matcher: 'regex-unicode-fold',
    },
    {
        matchCase: true,
        wholeWord: false,
        useRegex: true,
        matcher: 'regex-exact',
    },
    {
        matchCase: false,
        wholeWord: true,
        useRegex: true,
        matcher: 'regex-unicode-fold-boundary',
    },
    {
        matchCase: true,
        wholeWord: true,
        useRegex: true,
        matcher: 'regex-exact-boundary',
    },
] as const;

export interface IPdfSearchRequestOptions extends ISearchMatchOptions {
    requestId?: string;
    pageCount?: number;
    documentRevision?: TDocumentRevisionToken;
}

export const SEARCH_REQUEST_ID_MAX_LENGTH = 128;
export const SEARCH_PDF_PATH_MAX_LENGTH = 4_096;
export const SEARCH_PAGE_COUNT_DEFAULT_MAX = 20_000;
export const SEARCH_QUERY_MAX_LENGTH = 2_048;
export const SEARCH_REGEX_QUERY_MAX_LENGTH = 512;
export const SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH = 8_192;

export type TSearchablePageTextSeparator = 'none' | 'space' | 'line';

export interface ISearchablePageTextItem {
    text: string;
    separatorAfter?: TSearchablePageTextSeparator;
}

export interface ISearchablePageTextItemOffset {
    itemIndex: number;
    startOffset: TPdfSearchUtf16Offset;
    endOffset: TPdfSearchUtf16Offset;
}

export interface IAssembledSearchablePageText {
    text: string;
    itemOffsets: ISearchablePageTextItemOffset[];
    sourceOffsets: IPdfSearchUtf16Range[];
}

const SEARCH_LIGATURE_FOLDS: Readonly<Record<string, string>> = {
    '\uFB00': 'ff',
    '\uFB01': 'fi',
    '\uFB02': 'fl',
    '\uFB03': 'ffi',
    '\uFB04': 'ffl',
    '\uFB05': 'st',
    '\uFB06': 'st',
};

interface INormalizedSearchText {
    text: string;
    sourceStarts: number[];
    sourceEnds: number[];
}

/**
 * Search normalization is deliberately narrower than NFKC: canonical Unicode
 * composition plus the presentation ligatures commonly emitted by PDF fonts.
 */
export function normalizeSearchText(text: string) {
    return Array.from(text, character => SEARCH_LIGATURE_FOLDS[character] ?? character)
        .join('')
        .normalize('NFC');
}

function normalizeSearchTextWithOffsets(text: string): INormalizedSearchText {
    const normalizedParts: string[] = [];
    const sourceStarts: number[] = [];
    const sourceEnds: number[] = [];
    const graphemePattern = /\P{M}\p{M}*|\p{M}+/gu;

    for (const match of text.matchAll(graphemePattern)) {
        const source = match[0];
        const sourceStart = match.index;
        const sourceEnd = sourceStart + source.length;
        const normalized = normalizeSearchText(source);
        normalizedParts.push(normalized);
        for (let index = 0; index < normalized.length; index += 1) {
            sourceStarts.push(sourceStart);
            sourceEnds.push(sourceEnd);
        }
    }

    return {
        text: normalizedParts.join(''),
        sourceStarts,
        sourceEnds,
    };
}

function joinSearchLineHyphenation(text: string) {
    return text.replace(/\u00AD|-[\p{Zs}\t]*(?:\r\n?|\n)[\p{Zs}\t]*/gu, '');
}

/**
 * Canonical assembly used by PDF.js items, word-box/OCR items and plain-text
 * extractors. Adjacent non-whitespace items receive one separator, line-end
 * hyphens are joined, and normalization/collapse policy is applied once.
 */
export function assembleSearchablePageText(
    items: readonly ISearchablePageTextItem[],
): IAssembledSearchablePageText {
    const parts: string[] = [];
    const owners: number[] = [];
    const rawSourceStarts: number[] = [];
    const rawSourceEnds: number[] = [];
    let sourceCursor = 0;

    const append = (value: string, owner: number, generated = false) => {
        parts.push(value);
        for (let index = 0; index < value.length; index += 1) {
            owners.push(owner);
            rawSourceStarts.push(sourceCursor + (generated ? 0 : index));
            rawSourceEnds.push(sourceCursor + (generated ? 0 : index + 1));
        }
    };

    items.forEach((item, itemIndex) => {
        const previous = parts.at(-1)?.at(-1) ?? '';
        const first = item.text.at(0) ?? '';
        if (previous && first && !/\s/u.test(previous) && !/\s/u.test(first)) {
            append(' ', itemIndex, true);
        }
        append(item.text, itemIndex);
        sourceCursor += item.text.length;
        const separator = item.separatorAfter ?? 'none';
        const last = parts.at(-1)?.at(-1) ?? '';
        if (separator === 'line' && last !== '\n') {
            append('\n', itemIndex, true);
        } else if (separator === 'space' && last && !/\s/u.test(last)) {
            append(' ', itemIndex, true);
        }
    });

    const rawText = parts.join('');
    const sourceMappedText: INormalizedSearchText = {
        text: rawText,
        sourceStarts: rawSourceStarts,
        sourceEnds: rawSourceEnds,
    };
    const sourceMappedOwners = owners;
    const joinedText = joinSearchLineHyphenation(sourceMappedText.text);
    const retainedOwners: number[] = [];
    const retainedSourceStarts: number[] = [];
    const retainedSourceEnds: number[] = [];
    let normalizedOffset = 0;
    const hyphenationPattern = /\u00AD|-[\p{Zs}\t]*(?:\r\n?|\n)[\p{Zs}\t]*/gu;
    for (const match of sourceMappedText.text.matchAll(hyphenationPattern)) {
        retainedOwners.push(...sourceMappedOwners.slice(normalizedOffset, match.index));
        retainedSourceStarts.push(...sourceMappedText.sourceStarts.slice(normalizedOffset, match.index));
        retainedSourceEnds.push(...sourceMappedText.sourceEnds.slice(normalizedOffset, match.index));
        normalizedOffset = match.index + match[0].length;
    }
    retainedOwners.push(...sourceMappedOwners.slice(normalizedOffset));
    retainedSourceStarts.push(...sourceMappedText.sourceStarts.slice(normalizedOffset));
    retainedSourceEnds.push(...sourceMappedText.sourceEnds.slice(normalizedOffset));

    const text = collapseRepeatedPdfSearchPageText(joinedText);
    const finalOwners = retainedOwners.slice(0, text.length);
    const sourceOffsets = retainedSourceStarts.slice(0, text.length).map((startOffset, index) => ({
        startOffset,
        endOffset: retainedSourceEnds[index] ?? startOffset,
    }));
    const itemStarts = new Int32Array(items.length).fill(-1);
    const itemEnds = new Int32Array(items.length).fill(-1);
    for (let offset = 0; offset < finalOwners.length; offset += 1) {
        const owner = finalOwners[offset];
        if (owner === undefined || owner < 0 || owner >= items.length) {
            continue;
        }
        if (itemStarts[owner] === -1) {
            itemStarts[owner] = offset;
        }
        itemEnds[owner] = offset + 1;
    }
    const itemOffsets = items.map((_item, itemIndex): ISearchablePageTextItemOffset => {
        const startOffset = itemStarts[itemIndex] ?? -1;
        const endOffset = itemEnds[itemIndex] ?? -1;
        return {
            itemIndex,
            startOffset: startOffset < 0 ? 0 : startOffset,
            endOffset: endOffset < 0 ? 0 : endOffset,
        };
    });

    return {
        text,
        itemOffsets,
        sourceOffsets,
    };
}

export function mapAssembledSearchablePageTextRange(
    assembled: IAssembledSearchablePageText,
    range: IPdfSearchUtf16Range,
): IPdfSearchUtf16Range | null {
    if (
        range.startOffset < 0
        || range.endOffset <= range.startOffset
        || range.endOffset > assembled.text.length
    ) {
        return null;
    }
    const start = assembled.sourceOffsets[range.startOffset];
    const end = assembled.sourceOffsets[range.endOffset - 1];
    return start && end
        ? {
            startOffset: start.startOffset,
            endOffset: end.endOffset,
        }
        : null;
}

export function escapeSearchRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SEARCH_WORD_CHARACTER_CLASS = '\\p{L}\\p{N}\\p{M}_\'’';
const SEARCH_CJK_SCRIPT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function applyWholeWordBoundary(pattern: string) {
    return `(?<![${SEARCH_WORD_CHARACTER_CLASS}])(?:${pattern})(?![${SEARCH_WORD_CHARACTER_CLASS}])`;
}

export function buildPdfSearchRegex(
    query: string,
    options: IResolvedSearchMatchOptions,
) {
    if (options.useRegex) {
        assertSafePdfSearchRegex(query, options);
    }
    const basePattern = options.useRegex ? query : escapeSearchRegex(query);
    // CJK scripts normally have no whitespace-delimited word boundaries. For
    // literal CJK queries, wholeWord therefore intentionally means substring.
    const useBoundary = options.wholeWord
        && (options.useRegex || !SEARCH_CJK_SCRIPT_PATTERN.test(query));
    const pattern = useBoundary
        ? applyWholeWordBoundary(basePattern)
        : basePattern;
    const flags = options.matchCase ? 'gu' : 'giu';
    return new RegExp(pattern, flags);
}

interface IRegexGroupSafety {
    hasAlternation: boolean;
    hasQuantifier: boolean;
}

interface IClosedRegexGroupSafety extends IRegexGroupSafety {endIndex: number;}

function isRegexQuantifierAt(pattern: string, index: number) {
    const char = pattern[index];
    if (char === '*' || char === '+' || char === '?') {
        return true;
    }

    if (char !== '{') {
        return false;
    }

    const closeIndex = pattern.indexOf('}', index + 1);
    if (closeIndex < 0) {
        return false;
    }

    return /^\{\d*(?:,\d*)?\}$/u.test(pattern.slice(index, closeIndex + 1));
}

function isUnsafeSearchRegexPattern(pattern: string) {
    if (/\\(?:[1-9]\d*|k<[^>]+>)/u.test(pattern)) {
        return true;
    }

    if (/\(\?(?:[=!]|<[=!])/u.test(pattern)) {
        return true;
    }

    const stack: IRegexGroupSafety[] = [];
    let lastClosedGroup: IClosedRegexGroupSafety | null = null;
    let escaped = false;
    let inCharacterClass = false;

    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index];

        if (escaped) {
            escaped = false;
            lastClosedGroup = null;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            lastClosedGroup = null;
            continue;
        }

        if (inCharacterClass) {
            if (char === ']') {
                inCharacterClass = false;
            }
            continue;
        }

        if (char === '[') {
            inCharacterClass = true;
            lastClosedGroup = null;
            continue;
        }

        if (char === '(') {
            stack.push({
                hasAlternation: false,
                hasQuantifier: false,
            });
            lastClosedGroup = null;
            continue;
        }

        if (char === ')') {
            const closedGroup = stack.pop();
            if (closedGroup) {
                const parentGroup = stack.at(-1);
                if (parentGroup && closedGroup.hasQuantifier) {
                    parentGroup.hasQuantifier = true;
                }
                lastClosedGroup = {
                    ...closedGroup,
                    endIndex: index,
                };
            }
            continue;
        }

        if (char === '|') {
            const currentGroup = stack.at(-1);
            if (currentGroup) {
                currentGroup.hasAlternation = true;
            }
            lastClosedGroup = null;
            continue;
        }

        if (char === '?' && pattern[index - 1] === '(') {
            lastClosedGroup = null;
            continue;
        }

        if (isRegexQuantifierAt(pattern, index)) {
            if (lastClosedGroup && lastClosedGroup.endIndex === index - 1) {
                if (lastClosedGroup.hasAlternation || lastClosedGroup.hasQuantifier) {
                    return true;
                }
            }
            const currentGroup = stack.at(-1);
            if (currentGroup) {
                currentGroup.hasQuantifier = true;
            }
            lastClosedGroup = null;
            continue;
        }

        lastClosedGroup = null;
    }

    return false;
}

export function assertSafePdfSearchRegex(
    query: string,
    options: Pick<IResolvedSearchMatchOptions, 'matchCase' | 'wholeWord'>,
) {
    const pattern = options.wholeWord
        ? applyWholeWordBoundary(query)
        : query;
    try {
        new RegExp(pattern, options.matchCase ? 'gu' : 'giu');
    } catch (error) {
        throw new Error(`Invalid search regex: ${error instanceof Error ? error.message : 'pattern could not be compiled'}`);
    }

    if (isUnsafeSearchRegexPattern(query)) {
        throw new Error('Invalid search regex: pattern is too complex for document search');
    }
}

function assertSearchQueryWithinLimit(query: string, useRegex: boolean) {
    const maxLength = useRegex ? SEARCH_REGEX_QUERY_MAX_LENGTH : SEARCH_QUERY_MAX_LENGTH;
    if (query.length > maxLength) {
        throw new Error(`Invalid search query: maximum length is ${maxLength} characters`);
    }
}

export function validateSearchQuery(query: string, options: ISearchMatchOptions) {
    const useRegex = options.useRegex === true;
    assertSearchQueryWithinLimit(query, useRegex);
    if (useRegex && query.length > 0) {
        assertSafePdfSearchRegex(query, {
            matchCase: Boolean(options.matchCase),
            wholeWord: Boolean(options.wholeWord),
        });
    }
}

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

function normalizeOptionalSearchDocumentRevision(raw: unknown) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw === 'string' && raw.trim().length === 0) {
        return undefined;
    }
    if (typeof raw === 'string' && raw.trim().length > SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH) {
        throw new Error(`documentRevision exceeds maximum length (${SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH})`);
    }
    const documentRevision = parseDocumentRevisionToken(raw);
    if (documentRevision === null) {
        throw new Error('documentRevision must be a valid document revision token');
    }
    return documentRevision;
}

export interface INormalizedPdfSearchRequest extends IPdfSearchRequestOptions {
    pdfPath: string;
    query: string;
}

export interface INormalizedPdfSearchWarmIndexRequest extends IPdfSearchRequestOptions {pdfPath: string;}

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
    const documentRevision = normalizeOptionalSearchDocumentRevision(raw.documentRevision);
    const matchCase = normalizeSearchBooleanOption(raw.matchCase);
    const wholeWord = normalizeSearchBooleanOption(raw.wholeWord);
    const useRegex = normalizeSearchBooleanOption(raw.useRegex);
    validateSearchQuery(raw.query, {
        ...(matchCase === undefined ? {} : {matchCase}),
        ...(wholeWord === undefined ? {} : {wholeWord}),
        ...(useRegex === undefined ? {} : {useRegex}),
    });

    return {
        pdfPath: normalizeSearchPdfPath(raw.pdfPath),
        query: raw.query,
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
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
    const documentRevision = normalizeOptionalSearchDocumentRevision(raw.documentRevision);

    return {
        pdfPath: normalizeSearchPdfPath(raw.pdfPath),
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
    };
}

const MIN_REPEATED_PAGE_TEXT_SEGMENT_LENGTH = 48;
const MIN_TWO_COPY_PAGE_TEXT_SEGMENT_LENGTH = 160;
const MAX_REPEATED_PAGE_TEXT_COPIES = 16;

export function collapseRepeatedPdfSearchPageText(text: string) {
    const maxRepeatCount = Math.min(
        MAX_REPEATED_PAGE_TEXT_COPIES,
        Math.floor(text.length / MIN_REPEATED_PAGE_TEXT_SEGMENT_LENGTH),
    );

    for (let repeatCount = maxRepeatCount; repeatCount >= 2; repeatCount -= 1) {
        if (text.length % repeatCount !== 0) {
            continue;
        }

        const segmentLength = text.length / repeatCount;
        const minSegmentLength = repeatCount === 2
            ? MIN_TWO_COPY_PAGE_TEXT_SEGMENT_LENGTH
            : MIN_REPEATED_PAGE_TEXT_SEGMENT_LENGTH;
        if (segmentLength < minSegmentLength) {
            continue;
        }

        const firstSegment = text.slice(0, segmentLength);
        let isRepeated = true;
        for (let index = 1; index < repeatCount; index += 1) {
            if (text.slice(index * segmentLength, (index + 1) * segmentLength) !== firstSegment) {
                isRepeated = false;
                break;
            }
        }

        if (isRepeated) {
            return firstSegment;
        }
    }

    return text;
}

export function findPdfSearchMatches(
    text: string,
    matcherOrQuery: RegExp | string,
    options?: ISearchMatchOptions,
) {
    return Array.from(iteratePdfSearchMatches(text, matcherOrQuery, options));
}

export function* iteratePdfSearchMatches(
    text: string,
    matcherOrQuery: RegExp | string,
    options?: ISearchMatchOptions,
) {
    const normalizedText = typeof matcherOrQuery === 'string'
        ? normalizeSearchTextWithOffsets(text)
        : null;
    const sourceMatcher = typeof matcherOrQuery === 'string'
        ? buildPdfSearchRegex(normalizeSearchText(matcherOrQuery), {
            matchCase: Boolean(options?.matchCase),
            wholeWord: Boolean(options?.wholeWord),
            useRegex: Boolean(options?.useRegex),
        })
        : matcherOrQuery;
    const flags = sourceMatcher.flags.includes('g')
        ? sourceMatcher.flags
        : `${sourceMatcher.flags}g`;
    const matcher = new RegExp(sourceMatcher.source, flags);

    let match: RegExpExecArray | null;
    const matchedText = normalizedText?.text ?? text;
    while ((match = matcher.exec(matchedText)) !== null) {
        const value = match[0] ?? '';
        if (value.length === 0) {
            matcher.lastIndex += 1;
            continue;
        }
        const normalizedEndOffset = match.index + value.length;
        yield {
            startOffset: normalizedText?.sourceStarts[match.index] ?? match.index,
            endOffset: normalizedText?.sourceEnds[normalizedEndOffset - 1] ?? normalizedEndOffset,
        } satisfies IPdfSearchUtf16Range;
    }
}

export function buildPdfSearchExcerpt(
    text: string,
    startOffset: TPdfSearchUtf16Offset,
    endOffset: TPdfSearchUtf16Offset,
    contextChars: number,
) {
    const excerptStart = Math.max(0, startOffset - contextChars);
    const excerptEnd = Math.min(text.length, endOffset + contextChars);
    return {
        prefix: excerptStart > 0,
        suffix: excerptEnd < text.length,
        before: text.slice(excerptStart, startOffset).replace(/\s+/g, ' ').trimStart(),
        match: text.slice(startOffset, endOffset),
        after: text.slice(endOffset, excerptEnd).replace(/\s+/g, ' ').trimEnd(),
    };
}

export interface ISearchPreloadClient {
    run: (
        pdfPath: string,
        query: string,
        options?: IPdfSearchRequestOptions,
    ) => Promise<IPdfSearchResponse>;
    warmIndex: (
        pdfPath: string,
        options?: IPdfSearchRequestOptions,
    ) => Promise<boolean>;
    cancel: (requestId?: string) => Promise<{ canceled: boolean }>;
    onProgress: (callback: (progress: IPdfSearchProgress) => void) => (() => void);
    resetCache: () => Promise<boolean>;
}
