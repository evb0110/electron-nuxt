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

export interface ISearchMatchOptions {
    matchCase?: boolean | undefined;
    wholeWord?: boolean | undefined;
    useRegex?: boolean | undefined;
}

export interface IResolvedSearchMatchOptions {
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}

export const PDF_SEARCH_QUERY_MAX_LENGTH = 2_048;
export const PDF_SEARCH_REGEX_QUERY_MAX_LENGTH = 512;

export function escapeSearchRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPdfSearchRegex(
    query: string,
    options: IResolvedSearchMatchOptions,
) {
    if (options.useRegex) {
        assertSafePdfSearchRegex(query, options);
    }
    const basePattern = options.useRegex ? query : escapeSearchRegex(query);
    const pattern = options.wholeWord
        ? `(?<![\\p{L}\\p{N}_])(?:${basePattern})(?![\\p{L}\\p{N}_])`
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
        ? `(?<![\\p{L}\\p{N}_])(?:${query})(?![\\p{L}\\p{N}_])`
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
    const maxLength = useRegex ? PDF_SEARCH_REGEX_QUERY_MAX_LENGTH : PDF_SEARCH_QUERY_MAX_LENGTH;
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
    const sourceMatcher = typeof matcherOrQuery === 'string'
        ? buildPdfSearchRegex(matcherOrQuery, {
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
    while ((match = matcher.exec(text)) !== null) {
        const value = match[0] ?? '';
        if (value.length === 0) {
            matcher.lastIndex += 1;
            continue;
        }
        yield {
            startOffset: match.index,
            endOffset: match.index + value.length,
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
