import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    IPdfSearchResult,
} from '@contracts/search';
import type { ISearchCapability } from '@contracts/platform-api';
import { browserDocumentStore } from '@app/platform/browser-document-store';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
    createPdfjsDocumentInit,
    getPdfjsLib,
} from '@app/platform/browser-api/common';

interface IPreparedSearchPage {
    pageNumber: number;
    text: string;
}

interface ICreateBrowserSearchCapabilityResult {
    capability: ISearchCapability;
    clearSearchCaches: () => void;
}

type TSearchListener = (progress: IPdfSearchProgress) => void;

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex(
    query: string,
    options: {
        matchCase: boolean;
        wholeWord: boolean;
        useRegex: boolean;
    },
) {
    const basePattern = options.useRegex ? query : escapeRegex(query);
    const pattern = options.wholeWord
        ? `(?<![\\p{L}\\p{N}_])(?:${basePattern})(?![\\p{L}\\p{N}_])`
        : basePattern;
    const flags = options.matchCase ? 'gu' : 'giu';
    return new RegExp(pattern, flags);
}

function buildSearchExcerpt(
    text: string,
    startOffset: number,
    endOffset: number,
) {
    const excerptStart = Math.max(0, startOffset - SEARCH_EXCERPT_CONTEXT_CHARS);
    const excerptEnd = Math.min(
        text.length,
        endOffset + SEARCH_EXCERPT_CONTEXT_CHARS,
    );
    const before = text
        .slice(excerptStart, startOffset)
        .replace(/\s+/g, ' ')
        .trimStart();
    const after = text
        .slice(endOffset, excerptEnd)
        .replace(/\s+/g, ' ')
        .trimEnd();

    return {
        prefix: excerptStart > 0,
        suffix: excerptEnd < text.length,
        before,
        match: text.slice(startOffset, endOffset),
        after,
    };
}

export function createBrowserSearchCapability(): ICreateBrowserSearchCapabilityResult {
    const searchProgressListeners = new Set<TSearchListener>();
    const searchPreparedPagesCache = new Map<
        string,
        Promise<IPreparedSearchPage[]>
    >();
    const canceledSearchRequests = new Set<string>();

    function clearSearchCaches() {
        searchPreparedPagesCache.clear();
    }

    async function prepareSearchPages(pdfPath: string) {
        let prepared = searchPreparedPagesCache.get(pdfPath);
        if (prepared) {
            return prepared;
        }

        prepared = (async () => {
            const pdfBytes = await browserDocumentStore.read(pdfPath);
            const pdfjsLib = await getPdfjsLib();
            const loadingTask = pdfjsLib.getDocument(
                createPdfjsDocumentInit(pdfjsLib, pdfBytes),
            );
            const pdfDocument = await loadingTask.promise;
            const pages: IPreparedSearchPage[] = [];

            try {
                for (
                    let pageNumber = 1;
                    pageNumber <= pdfDocument.numPages;
                    pageNumber += 1
                ) {
                    const page = await pdfDocument.getPage(pageNumber);
                    const content = await page.getTextContent();
                    const text = content.items
                        .map((item) => ('str' in item ? item.str : ''))
                        .join(' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    pages.push({
                        pageNumber,
                        text,
                    });
                }
            } finally {
                await pdfDocument.destroy();
            }

            return pages;
        })();

        searchPreparedPagesCache.set(pdfPath, prepared);
        try {
            return prepared;
        } catch (error) {
            searchPreparedPagesCache.delete(pdfPath);
            throw error;
        }
    }

    const capability: ISearchCapability = {
        async run(pdfPath, query, options = {}) {
            const preparedPages = await prepareSearchPages(pdfPath);
            const matcher = buildSearchRegex(query, {
                matchCase: Boolean(options.matchCase),
                wholeWord: Boolean(options.wholeWord),
                useRegex: Boolean(options.useRegex),
            });
            const results: IPdfSearchResult[] = [];
            const requestId = options.requestId ?? crypto.randomUUID();

            for (let index = 0; index < preparedPages.length; index += 1) {
                if (canceledSearchRequests.has(requestId)) {
                    canceledSearchRequests.delete(requestId);
                    return {
                        results: [],
                        truncated: false,
                    };
                }

                const page = preparedPages[index]!;
                let match = matcher.exec(page.text);
                let pageMatchIndex = 0;

                while (match) {
                    const matchedText = match[0] ?? '';
                    if (matchedText.length === 0) {
                        matcher.lastIndex = match.index + 1;
                        match = matcher.exec(page.text);
                        continue;
                    }

                    results.push({
                        pageNumber: page.pageNumber,
                        pageMatchIndex,
                        matchIndex: results.length,
                        startOffset: match.index,
                        endOffset: match.index + matchedText.length,
                        excerpt: buildSearchExcerpt(
                            page.text,
                            match.index,
                            match.index + matchedText.length,
                        ),
                    });
                    pageMatchIndex += 1;

                    if (results.length >= SEARCH_RESULT_LIMIT) {
                        return {
                            results,
                            truncated: true,
                        };
                    }

                    match = matcher.exec(page.text);
                }

                const progress: IPdfSearchProgress = {
                    requestId,
                    processed: index + 1,
                    total: preparedPages.length,
                };
                searchProgressListeners.forEach((listener) => listener(progress));
            }

            return {
                results,
                truncated: false,
            } satisfies IPdfSearchResponse;
        },
        async warmIndex(pdfPath) {
            await prepareSearchPages(pdfPath);
            return true;
        },
        cancel(requestId) {
            if (requestId) {
                canceledSearchRequests.add(requestId);
            }
            return Promise.resolve({ canceled: true });
        },
        onProgress(callback) {
            searchProgressListeners.add(callback);
            return () => {
                searchProgressListeners.delete(callback);
            };
        },
        resetCache() {
            clearSearchCaches();
            return Promise.resolve(true);
        },
    };

    return {
        capability,
        clearSearchCaches,
    };
}
