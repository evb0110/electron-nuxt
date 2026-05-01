export interface IPdfSearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

export interface IPdfSearchResult {
    pageNumber: number;
    pageMatchIndex: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: IPdfSearchExcerpt;
}

export interface IPdfSearchResponse {
    results: IPdfSearchResult[];
    truncated: boolean;
}

export interface IPdfSearchProgress {
    requestId: string;
    processed: number;
    total: number;
}

export interface IPdfSearchRequestOptions {
    requestId?: string;
    pageCount?: number;
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
}

export function escapeSearchRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPdfSearchRegex(
    query: string,
    options: {
        matchCase: boolean;
        wholeWord: boolean;
        useRegex: boolean;
    },
) {
    const basePattern = options.useRegex ? query : escapeSearchRegex(query);
    const pattern = options.wholeWord
        ? `(?<![\\p{L}\\p{N}_])(?:${basePattern})(?![\\p{L}\\p{N}_])`
        : basePattern;
    const flags = options.matchCase ? 'gu' : 'giu';
    return new RegExp(pattern, flags);
}

export function findPdfSearchMatches(
    text: string,
    matcherOrQuery: RegExp | string,
    options?: {
        matchCase: boolean;
        wholeWord: boolean;
        useRegex: boolean;
    },
) {
    const matcher = typeof matcherOrQuery === 'string'
        ? buildPdfSearchRegex(matcherOrQuery, options ?? {
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        })
        : matcherOrQuery;
    const results: Array<{
        startOffset: number;
        endOffset: number;
    }> = [];
    let match = matcher.exec(text);
    while (match) {
        const matchedText = match[0] ?? '';
        if (matchedText.length === 0) {
            matcher.lastIndex = match.index + 1;
            match = matcher.exec(text);
            continue;
        }
        results.push({
            startOffset: match.index,
            endOffset: match.index + matchedText.length,
        });
        match = matcher.exec(text);
    }
    return results;
}

export function buildPdfSearchExcerpt(text: string, startOffset: number, endOffset: number, contextChars: number) {
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
