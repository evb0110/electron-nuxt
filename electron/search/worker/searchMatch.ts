import type {
    IPdfSearchExcerpt,
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
} from '@pdf-core';
import {
    buildPdfSearchExcerpt,
    iteratePdfSearchMatches,
} from '@pdf-core';
import { EXCERPT_CONTEXT_CHARS } from '@electron/config/constants';

export interface IPageSearchMatch extends IPdfSearchUtf16Range {}

export function buildExcerpt(
    text: string,
    startOffset: number,
    endOffset: number,
): IPdfSearchExcerpt {
    return buildPdfSearchExcerpt(text, startOffset, endOffset, EXCERPT_CONTEXT_CHARS);
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
    yield* iteratePdfSearchMatches(pageText, query, options);
}
