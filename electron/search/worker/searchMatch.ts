import type {
    IPdfSearchExcerpt,
    IResolvedSearchMatchOptions,
} from '@contracts/search';
import { buildPdfSearchRegex } from '@contracts/search';
import { EXCERPT_CONTEXT_CHARS } from '@electron/config/constants';

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

export function findPageMatches(
    pageText: string,
    query: string,
    options: IResolvedSearchMatchOptions,
): IPageSearchMatch[] {
    return Array.from(iteratePageMatches(pageText, query, options));
}

export function* iteratePageMatches(
    pageText: string,
    query: string,
    options: IResolvedSearchMatchOptions,
): Generator<IPageSearchMatch> {
    const matcher = buildPdfSearchRegex(query, options);

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
