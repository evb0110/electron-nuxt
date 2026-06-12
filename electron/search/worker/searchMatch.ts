import type { IPdfSearchExcerpt } from '@contracts/search';
import { EXCERPT_CONTEXT_CHARS } from '@electron/config/constants';

export interface ISearchMatchOptions {
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}

export interface IPageSearchMatch {
    startOffset: number;
    endOffset: number;
}

export function buildExcerpt(
    text: string,
    startOffset: number,
    endOffset: number,
): IPdfSearchExcerpt {
    const excerptStart = Math.max(0, startOffset - EXCERPT_CONTEXT_CHARS);
    const excerptEnd = Math.min(text.length, endOffset + EXCERPT_CONTEXT_CHARS);

    const beforeRaw = text.slice(excerptStart, startOffset);
    const match = text.slice(startOffset, endOffset);
    const afterRaw = text.slice(endOffset, excerptEnd);

    const before = beforeRaw.replace(/\s+/g, ' ').trimStart();
    const after = afterRaw.replace(/\s+/g, ' ').trimEnd();

    return {
        prefix: excerptStart > 0,
        suffix: excerptEnd < text.length,
        before,
        match,
        after,
    };
}

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex(
    query: string,
    options: ISearchMatchOptions,
) {
    const basePattern = options.useRegex ? query : escapeRegex(query);
    const pattern = options.wholeWord
        ? `(?<![\\p{L}\\p{N}_])(?:${basePattern})(?![\\p{L}\\p{N}_])`
        : basePattern;
    const flags = options.matchCase ? 'gu' : 'giu';
    return new RegExp(pattern, flags);
}

export function findPageMatches(
    pageText: string,
    query: string,
    options: ISearchMatchOptions,
): IPageSearchMatch[] {
    return Array.from(iteratePageMatches(pageText, query, options));
}

export function* iteratePageMatches(
    pageText: string,
    query: string,
    options: ISearchMatchOptions,
): Generator<IPageSearchMatch> {
    const matcher = buildSearchRegex(query, options);

    let match = matcher.exec(pageText);
    while (match) {
        const matchedText = match[0] ?? '';

        if (matchedText.length === 0) {
            matcher.lastIndex = match.index + 1;
            match = matcher.exec(pageText);
            continue;
        }

        yield {
            startOffset: match.index,
            endOffset: match.index + matchedText.length,
        };

        match = matcher.exec(pageText);
    }
}
