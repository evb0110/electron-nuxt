import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    IPdfSearchResult,
} from '@contracts/search';
import type { ISearchCapability } from '@contracts/platform-api';
import type { PDFPageProxy } from 'pdfjs-dist';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/common';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';
import { browserDocumentStore } from '@app/platform/browser-document-store';

interface IPreparedSearchDocumentCache {
    pageCount: number | null;
    pageTexts: Map<number, string>;
    pageTextBytes: number;
    canCacheWholeDocumentText: boolean;
}

interface ICreateBrowserSearchCapabilityResult {
    capability: ISearchCapability;
    clearSearchCaches: () => void;
}

type TSearchListener = (progress: IPdfSearchProgress) => void;

const SEARCH_PAGE_CACHE_LIMIT = 24;
const SEARCH_DOCUMENT_CACHE_LIMIT = 4;
const SEARCH_YIELD_INTERVAL = 1;
const BROWSER_SEARCH_MAX_BYTES = 64 * 1024 * 1024;
const SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES = 16 * 1024 * 1024;

function createBrowserSearchTooLargeError() {
    return new Error('ERR_BROWSER_SEARCH_TOO_LARGE');
}

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

function isRecordCacheReady(cache: IPreparedSearchDocumentCache) {
    return typeof cache.pageCount === 'number'
        && cache.pageCount > 0
        && cache.canCacheWholeDocumentText
        && cache.pageTexts.size >= cache.pageCount;
}

function createDocumentCache(): IPreparedSearchDocumentCache {
    return {
        pageCount: null,
        pageTexts: new Map<number, string>(),
        pageTextBytes: 0,
        canCacheWholeDocumentText: true,
    };
}

function yieldAfterSearchPage(pageNumber: number) {
    return pageNumber % SEARCH_YIELD_INTERVAL === 0 ? yieldToBrowser() : Promise.resolve();
}

function rememberPageText(
    cache: IPreparedSearchDocumentCache,
    pageNumber: number,
    text: string,
) {
    const existing = cache.pageTexts.get(pageNumber);
    if (typeof existing === 'string') {
        cache.pageTextBytes -= existing.length * 2;
        cache.pageTexts.delete(pageNumber);
    }
    cache.pageTexts.set(pageNumber, text);
    cache.pageTextBytes += text.length * 2;

    if (
        cache.canCacheWholeDocumentText
        && cache.pageTextBytes <= SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES
    ) {
        return;
    }

    cache.canCacheWholeDocumentText = false;
    while (cache.pageTexts.size > SEARCH_PAGE_CACHE_LIMIT) {
        const oldestPage = cache.pageTexts.keys().next().value;
        if (typeof oldestPage !== 'number') {
            break;
        }
        const oldestText = cache.pageTexts.get(oldestPage);
        if (typeof oldestText === 'string') {
            cache.pageTextBytes -= oldestText.length * 2;
        }
        cache.pageTexts.delete(oldestPage);
    }
}

function getCachedPageText(
    cache: IPreparedSearchDocumentCache,
    pageNumber: number,
) {
    const cached = cache.pageTexts.get(pageNumber);
    if (typeof cached !== 'string') {
        return null;
    }

    cache.pageTexts.delete(pageNumber);
    cache.pageTexts.set(pageNumber, cached);
    return cached;
}

async function extractPageText(page: {
    getTextContent: PDFPageProxy['getTextContent'];
    cleanup?: PDFPageProxy['cleanup'];
}) {
    const content = await page.getTextContent();
    const textChunks: string[] = [];

    for (let index = 0; index < content.items.length; index += 128) {
        const chunk = content.items.slice(index, index + 128);
        const normalizedChunk = chunk
            .map((item) => ('str' in item ? String(item.str ?? '') : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (normalizedChunk) {
            textChunks.push(normalizedChunk);
        }

        if (index + 128 < content.items.length) {
            await yieldToBrowser();
        }
    }

    const text = textChunks.join(' ').trim();

    try {
        await Promise.resolve(page.cleanup?.());
    } catch {
        // Page cleanup is a best-effort memory hint.
    }

    return text;
}

export function createBrowserSearchCapability(): ICreateBrowserSearchCapabilityResult {
    const searchProgressListeners = new Set<TSearchListener>();
    const searchDocumentCache = new Map<string, IPreparedSearchDocumentCache>();
    const canceledSearchRequests = new Set<string>();

    function getDocumentCache(pdfPath: string) {
        let cache = searchDocumentCache.get(pdfPath);
        if (!cache) {
            while (searchDocumentCache.size >= SEARCH_DOCUMENT_CACHE_LIMIT) {
                const oldestKey = searchDocumentCache.keys().next().value;
                if (typeof oldestKey !== 'string') {
                    break;
                }
                searchDocumentCache.delete(oldestKey);
            }
            cache = createDocumentCache();
            searchDocumentCache.set(pdfPath, cache);
        }
        return cache;
    }

    function clearSearchCaches() {
        searchDocumentCache.clear();
    }

    async function assertSearchWithinBrowserBudget(pdfPath: string) {
        const { size } = await browserDocumentStore.stat(pdfPath);
        if (size > BROWSER_SEARCH_MAX_BYTES) {
            throw createBrowserSearchTooLargeError();
        }
    }

    async function loadSearchDocument(pdfPath: string) {
        const pdfjsLib = await getPdfjsLib();
        const loadingTask = pdfjsLib.getDocument(
            await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, pdfPath),
        );
        const pdfDocument = await loadingTask.promise;

        return {
            pdfDocument,
            pageCount: pdfDocument.numPages,
            destroy: async () => {
                await pdfDocument.destroy();
            },
        };
    }

    async function iterateSearchPages(
        pdfPath: string,
        options: {
            onPage: (pageNumber: number, text: string, pageCount: number) => Promise<unknown> | unknown;
            requestId?: string;
        },
    ) {
        const cache = getDocumentCache(pdfPath);
        const cachedPageCount = cache.pageCount;

        if (isRecordCacheReady(cache) && cachedPageCount) {
            for (let pageNumber = 1; pageNumber <= cachedPageCount; pageNumber += 1) {
                if (options.requestId && canceledSearchRequests.has(options.requestId)) {
                    canceledSearchRequests.delete(options.requestId);
                    return false;
                }

                const cachedText = getCachedPageText(cache, pageNumber) ?? '';
                if (await options.onPage(pageNumber, cachedText, cachedPageCount) === false) {
                    return false;
                }

                if (options.requestId) {
                    const progress: IPdfSearchProgress = {
                        requestId: options.requestId,
                        processed: pageNumber,
                        total: cachedPageCount,
                    };
                    searchProgressListeners.forEach((listener) => listener(progress));
                }
                await yieldAfterSearchPage(pageNumber);
            }
            return true;
        }

        const document = await loadSearchDocument(pdfPath);
        cache.pageCount = document.pageCount;

        try {
            for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
                if (options.requestId && canceledSearchRequests.has(options.requestId)) {
                    canceledSearchRequests.delete(options.requestId);
                    return false;
                }

                const cachedText = getCachedPageText(cache, pageNumber);
                if (typeof cachedText === 'string') {
                    if (await options.onPage(pageNumber, cachedText, document.pageCount) === false) {
                        return false;
                    }
                } else {
                    const page = await document.pdfDocument.getPage(pageNumber);
                    const text = await extractPageText(page);
                    rememberPageText(cache, pageNumber, text);
                    if (await options.onPage(pageNumber, text, document.pageCount) === false) {
                        return false;
                    }
                }

                await yieldAfterSearchPage(pageNumber);
            }

            return true;
        } finally {
            await document.destroy();
        }
    }

    const capability: ISearchCapability = {
        async run(pdfPath, query, options = {}) {
            await assertSearchWithinBrowserBudget(pdfPath);
            const requestId = options.requestId ?? crypto.randomUUID();
            const results: IPdfSearchResult[] = [];
            const matcher = buildSearchRegex(query, {
                matchCase: Boolean(options.matchCase),
                wholeWord: Boolean(options.wholeWord),
                useRegex: Boolean(options.useRegex),
            });

            const completed = await iterateSearchPages(pdfPath, {
                requestId,
                onPage: async (pageNumber, text, pageCount) => {
                    if (canceledSearchRequests.has(requestId)) {
                        canceledSearchRequests.delete(requestId);
                        return false;
                    }

                    matcher.lastIndex = 0;
                    let match = matcher.exec(text);
                    let pageMatchIndex = 0;

                    while (match) {
                        const matchedText = match[0] ?? '';
                        if (matchedText.length === 0) {
                            matcher.lastIndex = match.index + 1;
                            match = matcher.exec(text);
                            continue;
                        }

                        results.push({
                            pageNumber,
                            pageMatchIndex,
                            matchIndex: results.length,
                            startOffset: match.index,
                            endOffset: match.index + matchedText.length,
                            excerpt: buildSearchExcerpt(
                                text,
                                match.index,
                                match.index + matchedText.length,
                            ),
                        });
                        pageMatchIndex += 1;

                        if (results.length >= SEARCH_RESULT_LIMIT) {
                            return false;
                        }

                        match = matcher.exec(text);
                    }

                    const progress: IPdfSearchProgress = {
                        requestId,
                        processed: pageNumber,
                        total: pageCount,
                    };
                    searchProgressListeners.forEach((listener) => listener(progress));
                    await yieldToBrowser();
                    return true;
                },
            });

            if (!completed && canceledSearchRequests.has(requestId)) {
                canceledSearchRequests.delete(requestId);
                return {
                    results: [],
                    truncated: false,
                };
            }

            return {
                results,
                truncated: results.length >= SEARCH_RESULT_LIMIT,
            } satisfies IPdfSearchResponse;
        },
        async warmIndex(pdfPath) {
            await assertSearchWithinBrowserBudget(pdfPath);
            await iterateSearchPages(pdfPath, {onPage: async () => {
                await yieldToBrowser();
            }});
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
