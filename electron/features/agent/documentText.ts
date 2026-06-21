import type {
    BrowserWindow,
    IpcMainInvokeEvent,
} from 'electron';
import type {
    IPdfSearchResponse,
    ISearchMatchOptions,
} from '@contracts/search';
import type { IAgentTabSnapshot } from '@contracts/agent';
import { createLogger } from '@electron/utils/createLogger';
import {
    parseOptionalSearchPageCount,
    resolveSearchablePdfPath,
    resolveSearchWorkerPath,
    SearchWorkerService,
    validateSearchQuery,
} from '@electron/features/search/public';
import { loadSearchIndex } from '@electron/search/indexBuilder';

export interface IAgentDocumentSearchOptions extends ISearchMatchOptions {
    query: string;
    maxResults?: number;
}

export interface IAgentDocumentPageReadOptions {
    pages: number[];
    maxCharsPerPage?: number;
}

export interface IAgentDocumentTextOperationInput<TOptions> {
    tab: IAgentTabSnapshot;
    options: TOptions;
}

const logger = createLogger('agent-document-text');
const agentSearchWorkerService = new SearchWorkerService(resolveSearchWorkerPath);
const DEFAULT_SEARCH_RESULT_LIMIT = 25;
const MAX_SEARCH_RESULT_LIMIT = 100;
const DEFAULT_PAGE_TEXT_CHARS = 6000;
const MAX_PAGE_TEXT_CHARS = 30000;
const MAX_MISSING_PAGE_SAMPLE = 80;

function createSearchEvent(window: BrowserWindow) {
    return {sender: window.webContents} as IpcMainInvokeEvent;
}

function normalizePositiveInteger(value: number | null | undefined, fallback: number, max: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(1, Math.trunc(value)));
}

function getValidatedSearchPageCount(tab: IAgentTabSnapshot) {
    if (typeof tab.totalPages !== 'number' || tab.totalPages < 1) {
        return undefined;
    }
    return parseOptionalSearchPageCount(tab.totalPages);
}

function getAgentTabPdfPath(tab: IAgentTabSnapshot) {
    if (tab.kind !== 'pdf') {
        throw new Error(`Tab ${tab.tabId} is a ${tab.kind} document. Convert it to PDF before text search.`);
    }

    const path = tab.originalPath?.trim();
    if (!path) {
        throw new Error(`Tab ${tab.tabId} does not expose a readable PDF path.`);
    }
    return path;
}

async function resolveAgentSearchPath(window: BrowserWindow, tab: IAgentTabSnapshot) {
    const requestedPath = getAgentTabPdfPath(tab);
    const resolvedPdfPath = await resolveSearchablePdfPath(requestedPath, window.webContents.id);
    if (!resolvedPdfPath) {
        throw new Error('The PDF is not available to the EVB search index yet.');
    }

    return {
        requestedPath,
        resolvedPdfPath,
    };
}

async function warmAgentSearchIndex(
    window: BrowserWindow,
    tab: IAgentTabSnapshot,
) {
    const {
        requestedPath,
        resolvedPdfPath,
    } = await resolveAgentSearchPath(window, tab);
    const pageCount = getValidatedSearchPageCount(tab);
    await agentSearchWorkerService.dispatchSearchRequest(
        createSearchEvent(window),
        {
            resolvedPdfPath,
            query: '',
            warmup: true,
            requestIdPrefix: 'agent-warm',
            ...(pageCount === undefined ? {} : { pageCount }),
        },
    );

    const index = await loadSearchIndex(resolvedPdfPath);
    return {
        requestedPath,
        resolvedPdfPath,
        index,
    };
}

function resolvePageCount(tab: IAgentTabSnapshot, indexPageCount: number | undefined, indexedPages: number) {
    if (typeof tab.totalPages === 'number' && tab.totalPages > 0) {
        return Math.trunc(tab.totalPages);
    }
    if (typeof indexPageCount === 'number' && indexPageCount > 0) {
        return Math.trunc(indexPageCount);
    }
    return indexedPages;
}

function buildTextStatus(tab: IAgentTabSnapshot, index: Awaited<ReturnType<typeof loadSearchIndex>>) {
    if (!index) {
        return {
            status: 'unknown' as const,
            pageCount: tab.totalPages ?? 0,
            textPageCount: 0,
            missingTextPages: [],
            missingTextPageSample: [],
            coverage: 0,
        };
    }

    const pageCount = resolvePageCount(tab, index.pageCount, index.pages.length);
    const textPages = new Set(
        index.pages
            .filter(page => page.pageNumber >= 1 && page.pageNumber <= pageCount && page.text.trim().length > 0)
            .map(page => page.pageNumber),
    );
    const missingTextPages: number[] = [];
    for (let page = 1; page <= pageCount; page += 1) {
        if (!textPages.has(page)) {
            missingTextPages.push(page);
        }
    }

    const textPageCount = textPages.size;
    const coverage = pageCount > 0 ? textPageCount / pageCount : 0;
    const status = pageCount <= 0
        ? 'unknown'
        : textPageCount === pageCount
            ? 'complete'
            : textPageCount === 0
                ? 'none'
                : 'partial';

    return {
        status,
        pageCount,
        textPageCount,
        missingTextPages,
        missingTextPageSample: missingTextPages.slice(0, MAX_MISSING_PAGE_SAMPLE),
        coverage,
    };
}

function createTextRecommendations(textStatus: ReturnType<typeof buildTextStatus>) {
    if (textStatus.status === 'complete') {
        return [];
    }

    if (textStatus.status === 'partial' || textStatus.status === 'none') {
        return [{
            id: 'ocr_all_pages',
            title: 'OCR all pages',
            reason: textStatus.status === 'none'
                ? 'No searchable page text was found, so document search and page reading will be unreliable until OCR is run.'
                : 'Some pages lack searchable text; OCRing all pages gives agents consistent page text.',
            toolName: 'ocr.start',
        }];
    }

    return [{
        id: 'ocr_all_pages',
        title: 'OCR all pages',
        reason: 'If important pages have no searchable text, OCR all pages before deeper agent analysis.',
        toolName: 'ocr.start',
    }];
}

export async function inspectAgentDocumentText(
    window: BrowserWindow,
    input: IAgentDocumentTextOperationInput<Record<never, never>>,
) {
    const {
        requestedPath,
        resolvedPdfPath,
        index,
    } = await warmAgentSearchIndex(window, input.tab);
    const textStatus = buildTextStatus(input.tab, index);

    return {
        tabId: input.tab.tabId,
        fileName: input.tab.fileName,
        originalPath: input.tab.originalPath,
        requestedPath,
        resolvedPdfPath,
        textStatus,
        recommendations: createTextRecommendations(textStatus),
    };
}

export async function searchAgentDocument(
    window: BrowserWindow,
    input: IAgentDocumentTextOperationInput<IAgentDocumentSearchOptions>,
) {
    const query = input.options.query.trim();
    if (!query) {
        throw new Error('query is required.');
    }
    validateSearchQuery(query, {
        matchCase: input.options.matchCase,
        wholeWord: input.options.wholeWord,
        useRegex: input.options.useRegex,
    });

    const {
        requestedPath,
        resolvedPdfPath,
    } = await resolveAgentSearchPath(window, input.tab);
    const pageCount = getValidatedSearchPageCount(input.tab);
    const response: IPdfSearchResponse = await agentSearchWorkerService.dispatchSearchRequest(
        createSearchEvent(window),
        {
            resolvedPdfPath,
            query,
            requestIdPrefix: 'agent-search',
            ...(pageCount === undefined ? {} : { pageCount }),
            ...(input.options.matchCase === undefined ? {} : { matchCase: input.options.matchCase }),
            ...(input.options.wholeWord === undefined ? {} : { wholeWord: input.options.wholeWord }),
            ...(input.options.useRegex === undefined ? {} : { useRegex: input.options.useRegex }),
        },
    );
    const maxResults = normalizePositiveInteger(
        input.options.maxResults,
        DEFAULT_SEARCH_RESULT_LIMIT,
        MAX_SEARCH_RESULT_LIMIT,
    );
    const results = response.results.slice(0, maxResults);
    const index = await loadSearchIndex(resolvedPdfPath).catch((error) => {
        logger.debug(`Failed to load search index after agent search: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    });

    return {
        tabId: input.tab.tabId,
        fileName: input.tab.fileName,
        originalPath: input.tab.originalPath,
        requestedPath,
        resolvedPdfPath,
        query,
        options: {
            matchCase: Boolean(input.options.matchCase),
            wholeWord: Boolean(input.options.wholeWord),
            useRegex: Boolean(input.options.useRegex),
        },
        results,
        returnedResults: results.length,
        totalAvailableResults: response.results.length,
        truncated: response.truncated || response.results.length > results.length,
        searchTruncated: response.truncated,
        toolTruncated: response.results.length > results.length,
        textStatus: buildTextStatus(input.tab, index),
    };
}

function buildPageTextResponse(
    pageNumber: number,
    text: string,
    maxCharsPerPage: number,
) {
    const normalizedText = text.replace(/\r\n?/g, '\n').trim();
    const truncated = normalizedText.length > maxCharsPerPage;
    return {
        page: pageNumber,
        hasText: normalizedText.length > 0,
        textLength: normalizedText.length,
        truncated,
        text: truncated ? normalizedText.slice(0, maxCharsPerPage) : normalizedText,
    };
}

export async function readAgentDocumentPages(
    window: BrowserWindow,
    input: IAgentDocumentTextOperationInput<IAgentDocumentPageReadOptions>,
) {
    const {
        requestedPath,
        resolvedPdfPath,
        index,
    } = await warmAgentSearchIndex(window, input.tab);
    if (!index) {
        throw new Error('Search index was not available after warmup.');
    }

    const pageCount = resolvePageCount(input.tab, index.pageCount, index.pages.length);
    const maxCharsPerPage = normalizePositiveInteger(
        input.options.maxCharsPerPage,
        DEFAULT_PAGE_TEXT_CHARS,
        MAX_PAGE_TEXT_CHARS,
    );
    const uniquePages = Array.from(new Set(
        input.options.pages
            .map(page => Math.trunc(page))
            .filter(page => page >= 1 && page <= pageCount),
    )).sort((left, right) => left - right);
    if (uniquePages.length === 0) {
        throw new Error(`No requested pages are within the document's 1-${pageCount} page range.`);
    }

    const pageTextByNumber = new Map(index.pages.map(page => [
        page.pageNumber,
        page.text,
    ]));
    const pages = uniquePages.map(pageNumber => buildPageTextResponse(
        pageNumber,
        pageTextByNumber.get(pageNumber) ?? '',
        maxCharsPerPage,
    ));

    return {
        tabId: input.tab.tabId,
        fileName: input.tab.fileName,
        originalPath: input.tab.originalPath,
        requestedPath,
        resolvedPdfPath,
        pageCount,
        pages,
        textStatus: buildTextStatus(input.tab, index),
    };
}
