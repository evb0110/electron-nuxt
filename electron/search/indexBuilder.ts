import { existsSync } from 'fs';
import {
    rm,
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import {
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'path';
import { sortBy } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import { isOcrWord } from '@contracts/shared';
import { isRecord } from '@contracts/runtimeGuards';
import type { IOcrWord } from '@contracts/shared';
import type {
    IOcrIndexV2Manifest,
    IOcrIndexV2Page,
} from '@contracts/ocrIndex';
import {
    OCR_TEXT_LAYER_INDEX_SOURCE,
    OCR_TEXT_LAYER_INDEX_VERSION,
    buildOcrTextLayerIndexText,
} from '@contracts/ocrText';
import { extractTextFromPdf } from '@electron/search/extractTextFromPdf';
import { extractTextWithPdfjs } from '@electron/search/extractTextWithPdfjs';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    loadCompactSearchIndex,
    persistCompactSearchIndexBestEffort,
} from '@electron/search/searchIndexSidecar';
import { ensureNativeSearchIndexBestEffort } from '@electron/search/nativeSearchIndex';

export interface IPageIndex {
    pageNumber: number;
    text: string;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

export interface IPdfSearchIndex {
    schemaVersion?: number;
    pdfPath: string;
    createdAt: number;
    pages: IPageIndex[];
    pageCount?: number;
    textSource?: {
        kind: string;
        version: number;
    };
}

const log = createLogger('indexBuilder');

const STORE_WORD_BOXES = false;
export const SEARCH_INDEX_SCHEMA_VERSION = 4;
const SEARCH_PDFJS_FIRST_MAX_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_PDFJS_FIRST_MAX_MB ?? '96', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 96 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();

interface IBuildSearchIndexOptions {
    pageCount?: number;
    signal?: AbortSignal;
    onPageIndexed?: (page: IPageIndex) => void;
}

interface IExtractedPageText {
    pageNumber: number;
    text: string;
}

interface IPageDataInput {
    pageNumber: number;
    words: IOcrWord[];
    text?: string;
    pageWidth?: number;
    pageHeight?: number;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isExpectedPageNumber(
    pageNumber: number,
    expectedCount: number | undefined,
) {
    return pageNumber >= 1 && (!isPositiveInteger(expectedCount) || pageNumber <= expectedCount);
}

function finiteNumberOrUndefined(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function ocrWordsOrUndefined(value: unknown) {
    return Array.isArray(value) && value.every(isOcrWord)
        ? value
        : undefined;
}

async function statMtimeMs(filePath: string) {
    try {
        const fileStat = await stat(filePath);
        return finiteNumberOrUndefined(fileStat.mtimeMs);
    } catch {
        return undefined;
    }
}

function resolveManifestPagePath(
    ocrDir: string,
    relativePath: unknown,
) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        return null;
    }

    const resolvedOcrDir = resolve(ocrDir);
    const resolvedPath = resolve(resolvedOcrDir, relativePath);
    const relativePathFromDir = relative(resolvedOcrDir, resolvedPath);
    if (
        relativePathFromDir === ''
        || relativePathFromDir === '..'
        || relativePathFromDir.startsWith(`..${sep}`)
        || isAbsolute(relativePathFromDir)
    ) {
        return null;
    }

    return resolvedPath;
}

function parseOcrManifestPayload(payload: unknown): IOcrIndexV2Manifest | null {
    if (!isRecord(payload) || !isRecord(payload.source) || !isRecord(payload.pages)) {
        return null;
    }
    if (
        typeof payload.version !== 'number'
        || payload.version < 2
        || typeof payload.source.pdfPath !== 'string'
        || !isPositiveInteger(payload.pageCount)
    ) {
        return null;
    }
    const pages: IOcrIndexV2Manifest['pages'] = {};
    for (const [
        rawPageNumber,
        rawPageMapping,
    ] of Object.entries(payload.pages)) {
        const pageNumber = Number.parseInt(rawPageNumber, 10);
        if (
            Number.isInteger(pageNumber)
            && pageNumber > 0
            && isRecord(rawPageMapping)
            && typeof rawPageMapping.path === 'string'
        ) {
            pages[pageNumber] = { path: rawPageMapping.path };
        }
    }
    return {
        version: 2,
        createdAt: finiteNumberOrUndefined(payload.createdAt) ?? Date.now(),
        source: { pdfPath: payload.source.pdfPath },
        pageCount: payload.pageCount,
        pageBox: 'crop',
        ocr: isRecord(payload.ocr)
            ? {
                engine: 'tesseract',
                languages: Array.isArray(payload.ocr.languages) && payload.ocr.languages.every(item => typeof item === 'string')
                    ? payload.ocr.languages
                    : [],
                renderDpi: finiteNumberOrUndefined(payload.ocr.renderDpi) ?? 0,
            }
            : {
                engine: 'tesseract',
                languages: [],
                renderDpi: 0,
            },
        pages,
    };
}

function parseOcrPagePayload(payload: unknown): IOcrIndexV2Page | null {
    if (!isRecord(payload)) {
        return null;
    }
    if (
        payload.pageNumber !== undefined
        && !isPositiveInteger(payload.pageNumber)
    ) {
        return null;
    }
    if (payload.text !== undefined && typeof payload.text !== 'string') {
        return null;
    }
    const page: IOcrIndexV2Page = {
        pageNumber: isPositiveInteger(payload.pageNumber) ? payload.pageNumber : 0,
        rotation: 0,
        render: {
            dpi: 0,
            imagePx: {
                w: 0,
                h: 0,
            },
        },
        text: typeof payload.text === 'string' ? payload.text : '',
        words: ocrWordsOrUndefined(payload.words) ?? [],
    };
    return page;
}

function getManifestPageNumbers(
    manifest: IOcrIndexV2Manifest,
    expectedCount: number | undefined,
) {
    return Object.keys(manifest.pages)
        .map(rawPageNumber => Number.parseInt(rawPageNumber, 10))
        .filter(pageNumber => (
            Number.isInteger(pageNumber)
            && isExpectedPageNumber(pageNumber, expectedCount)
        ))
        .sort((a, b) => a - b);
}

async function loadCompactOcrIndexText(
    pdfPath: string,
    manifest: IOcrIndexV2Manifest,
    manifestMtimeMs: number | undefined,
    expectedCount: number | undefined,
    onPageIndexed?: (page: IPageIndex) => void,
    signal?: AbortSignal,
) {
    const manifestPageNumbers = getManifestPageNumbers(manifest, expectedCount);
    if (manifestPageNumbers.length === 0) {
        return null;
    }

    const expectedPageCount = isPositiveInteger(expectedCount)
        ? expectedCount
        : manifest.pageCount;
    const loadOptions: Parameters<typeof loadCompactSearchIndex>[1] = { expectedPageCount };
    if (manifestMtimeMs !== undefined) {
        loadOptions.minSourceMtimeMs = manifestMtimeMs;
    }
    loadOptions.requiredTextSource = {
        kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
        version: OCR_TEXT_LAYER_INDEX_VERSION,
    };
    if (signal !== undefined) {
        loadOptions.signal = signal;
    }

    const compactIndex = await loadCompactSearchIndex(pdfPath, loadOptions);
    if (!compactIndex || compactIndex.pageCount !== manifest.pageCount) {
        return null;
    }

    const expectedPageSet = new Set(manifestPageNumbers);
    const pageTexts = new Map<number, string>();
    for (const page of compactIndex.pages) {
        throwIfAborted(signal);
        if (expectedPageSet.has(page.pageNumber)) {
            pageTexts.set(page.pageNumber, page.text);
        }
    }

    if (pageTexts.size !== manifestPageNumbers.length) {
        return null;
    }

    for (const pageNumber of manifestPageNumbers) {
        const text = pageTexts.get(pageNumber) ?? '';
        onPageIndexed?.({
            pageNumber,
            text,
        });
    }

    log.debug(`Loaded compact OCR search index with ${pageTexts.size} pages for ${pdfPath}`);
    return pageTexts;
}

/**
 * Load OCR v2 index text for all pages.
 * Returns a Map of pageNumber -> text, or null if no v2 index exists.
 */
async function loadOcrIndexText(
    pdfPath: string,
    expectedCount?: number,
    onPageIndexed?: (page: IPageIndex) => void,
    signal?: AbortSignal,
): Promise<Map<number, string> | null> {
    throwIfAborted(signal);
    const ocrDir = `${pdfPath}.ocr`;
    const manifestPath = join(ocrDir, 'manifest.json');

    if (!existsSync(manifestPath)) {
        return null;
    }

    try {
        throwIfAborted(signal);
        const manifestJson = await readFile(manifestPath, 'utf-8');
        throwIfAborted(signal);
        const manifest = parseOcrManifestPayload(JSON.parse(manifestJson));

        if (!manifest) {
            log.debug('OCR v2 manifest is invalid, skipping');
            return null;
        }

        const compactPageTexts = await loadCompactOcrIndexText(
            pdfPath,
            manifest,
            await statMtimeMs(manifestPath),
            expectedCount,
            onPageIndexed,
            signal,
        );
        if (compactPageTexts) {
            return compactPageTexts;
        }

        const pageTexts = new Map<number, string>();

        for (const [
            pageNumStr,
            pageInfo,
        ] of Object.entries(manifest.pages)) {
            throwIfAborted(signal);
            const pageNum = parseInt(pageNumStr, 10);
            if (!Number.isInteger(pageNum) || !isExpectedPageNumber(pageNum, expectedCount)) {
                log.warn(`Skipping OCR page with invalid page number "${pageNumStr}" in manifest`);
                continue;
            }
            const pagePath = resolveManifestPagePath(ocrDir, pageInfo.path);
            if (!pagePath) {
                log.warn(`Skipping OCR page ${pageNum} with invalid manifest path`);
                continue;
            }

            if (existsSync(pagePath)) {
                let pageJson = '';
                try {
                    pageJson = await readFile(pagePath, 'utf-8');
                } catch (pageReadError) {
                    if (isAbortError(pageReadError)) {
                        throw pageReadError;
                    }
                    log.warn(`Skipping OCR page ${pageNum} with unreadable page data`);
                    continue;
                }
                throwIfAborted(signal);
                let pagePayload: unknown;
                try {
                    pagePayload = JSON.parse(pageJson);
                } catch {
                    log.warn(`Skipping OCR page ${pageNum} with invalid page JSON`);
                    continue;
                }
                const pageData = parseOcrPagePayload(pagePayload);
                if (!pageData) {
                    log.warn(`Skipping OCR page ${pageNum} with invalid page data`);
                    continue;
                }
                if (pageData.pageNumber !== undefined && pageData.pageNumber !== pageNum) {
                    log.warn(`Skipping OCR page ${pageNum} with mismatched page data ${pageData.pageNumber}`);
                    continue;
                }
                const words = Array.isArray(pageData.words) ? pageData.words : [];
                const text = words.length > 0
                    ? buildOcrTextLayerIndexText(words)
                    : pageData.text || '';
                pageTexts.set(pageNum, text);
                onPageIndexed?.({
                    pageNumber: pageNum,
                    text,
                });
            }
        }

        log.debug(`Loaded OCR v2 index with ${pageTexts.size} pages from ${ocrDir}`);
        return pageTexts;
    } catch (err) {
        if (isAbortError(err)) {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log.debug(`Failed to load OCR v2 index: ${errMsg}`);
        return null;
    }
}

function getIndexPath(pdfPath: string) {
    return `${pdfPath}.index.json`;
}

function parseSearchIndexPage(page: unknown): IPageIndex | null {
    if (!isRecord(page)) {
        return null;
    }
    if (!isPositiveInteger(page.pageNumber)) {
        return null;
    }
    if (typeof page.text !== 'string') {
        return null;
    }

    const normalizedPage: IPageIndex = {
        pageNumber: page.pageNumber,
        text: page.text,
    };
    const words = ocrWordsOrUndefined(page.words);
    if (words) {
        normalizedPage.words = words;
    }
    const pageWidth = finiteNumberOrUndefined(page.pageWidth);
    if (pageWidth !== undefined) {
        normalizedPage.pageWidth = pageWidth;
    }
    const pageHeight = finiteNumberOrUndefined(page.pageHeight);
    if (pageHeight !== undefined) {
        normalizedPage.pageHeight = pageHeight;
    }
    return normalizedPage;
}

function parseSearchIndexPages(pages: unknown[]): IPageIndex[] | null {
    const normalizedPages: IPageIndex[] = [];
    for (const page of pages) {
        const normalizedPage = parseSearchIndexPage(page);
        if (!normalizedPage) {
            return null;
        }
        normalizedPages.push(normalizedPage);
    }
    return sortBy(normalizedPages, ['pageNumber']);
}

function parseSearchIndexPayload(payload: unknown): IPdfSearchIndex | null {
    if (!isRecord(payload) || !Array.isArray(payload.pages)) {
        return null;
    }
    if (typeof payload.pdfPath !== 'string' || payload.pdfPath.length === 0) {
        return null;
    }

    const normalizedPages = parseSearchIndexPages(payload.pages);
    if (!normalizedPages) {
        return null;
    }

    const createdAt = finiteNumberOrUndefined(payload.createdAt);

    const normalizedIndex: IPdfSearchIndex = {
        pdfPath: payload.pdfPath,
        createdAt: createdAt ?? Date.now(),
        pages: normalizedPages,
    };
    if (isPositiveInteger(payload.schemaVersion)) {
        normalizedIndex.schemaVersion = payload.schemaVersion;
    }
    if (isPositiveInteger(payload.pageCount)) {
        normalizedIndex.pageCount = payload.pageCount;
    }
    if (
        isRecord(payload.textSource)
        && typeof payload.textSource.kind === 'string'
        && typeof payload.textSource.version === 'number'
    ) {
        normalizedIndex.textSource = {
            kind: payload.textSource.kind,
            version: payload.textSource.version,
        };
    }
    return normalizedIndex;
}

function pagesFromOcrTexts(
    ocrTexts: Map<number, string>,
    signal?: AbortSignal,
): IPageIndex[] {
    const pages: IPageIndex[] = [];
    for (const [
        pageNumber,
        text,
    ] of ocrTexts) {
        throwIfAborted(signal);
        pages.push({
            pageNumber,
            text,
        });
    }
    return sortBy(pages, ['pageNumber']);
}

async function persistIndex(
    pdfPath: string,
    index: IPdfSearchIndex,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const indexPath = getIndexPath(pdfPath);
    const tempPath = makeSiblingTempPath(indexPath);
    try {
        await writeFile(tempPath, JSON.stringify(index), 'utf-8');
        throwIfAborted(signal);
        await atomicReplace(tempPath, indexPath);
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
    log.debug(`Index saved successfully: ${indexPath}`);
}

async function persistIndexBestEffort(
    pdfPath: string,
    index: IPdfSearchIndex,
    signal?: AbortSignal,
) {
    try {
        await persistIndex(pdfPath, index, signal);
    } catch (err) {
        if (isAbortError(err)) {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log.debug(`Warning: Failed to save OCR-based index: ${errMsg}`);
    }
}

async function buildIndexFromOcrTexts(
    pdfPath: string,
    ocrTexts: Map<number, string>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
): Promise<IPdfSearchIndex> {
    log.debug(`Using OCR v2 index with ${ocrTexts.size} pages`);
    const pages = pagesFromOcrTexts(ocrTexts, signal);

    const index: IPdfSearchIndex = {
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        pdfPath,
        createdAt: Date.now(),
        pages,
        pageCount: isPositiveInteger(expectedCount) ? expectedCount : pages.length,
        textSource: {
            kind: OCR_TEXT_LAYER_INDEX_SOURCE,
            version: OCR_TEXT_LAYER_INDEX_VERSION,
        },
    };

    await persistIndexBestEffort(pdfPath, index, signal);
    await persistCompactSearchIndexBestEffort(pdfPath, {
        pageCount: index.pageCount ?? pages.length,
        pages,
        textSource: {
            kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
            version: OCR_TEXT_LAYER_INDEX_VERSION,
        },
    }, signal);
    return index;
}

function seedFromExistingIndex(
    existing: IPdfSearchIndex | null,
): Map<number, IPageIndex> {
    if (!existing?.pages?.length) {
        return new Map();
    }
    return new Map(existing.pages.map((page) => [
        page.pageNumber,
        {
            pageNumber: page.pageNumber,
            text: page.text ?? '',
            ...(page.pageWidth !== undefined ? { pageWidth: page.pageWidth } : {}),
            ...(page.pageHeight !== undefined ? { pageHeight: page.pageHeight } : {}),
            ...(STORE_WORD_BOXES && page.words !== undefined ? { words: page.words } : {}),
        },
    ]));
}

function shouldExtractPdfText(
    pagesByNumber: Map<number, IPageIndex>,
    existing: IPdfSearchIndex | null,
    expectedCount: number | undefined,
) {
    if (!existing) {
        return true;
    }
    const hasAnyText = Array.from(pagesByNumber.values()).some(p => (p.text ?? '').length > 0);
    if (!hasAnyText) {
        return true;
    }
    if (isPositiveInteger(expectedCount) && pagesByNumber.size < expectedCount) {
        return true;
    }
    return false;
}

function applyExtractedTexts(
    pagesByNumber: Map<number, IPageIndex>,
    pageTexts: IExtractedPageText[],
    signal?: AbortSignal,
): Map<number, IPageIndex> {
    const nextPages = new Map(pagesByNumber);
    for (const pt of pageTexts) {
        throwIfAborted(signal);
        const entry = nextPages.get(pt.pageNumber);
        if (!entry) {
            nextPages.set(pt.pageNumber, {
                pageNumber: pt.pageNumber,
                text: pt.text,
            });
            continue;
        }

        if (!entry.text && pt.text) {
            nextPages.set(pt.pageNumber, {
                ...entry,
                text: pt.text,
            });
        }
    }
    return nextPages;
}

async function seedFromPdfjs(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
): Promise<{
    pagesByNumber: Map<number, IPageIndex>;
    hasText: boolean;
}> {
    try {
        log.debug(`Seeding index with pdfjs-dist (pageCount=${expectedCount ?? 'unknown'})`);
        let hasText = false;
        let nextPagesByNumber = pagesByNumber;
        const extractOptions: Parameters<typeof extractTextWithPdfjs>[1] = {
            collectPages: false,
            onPageText: (pageText) => {
                hasText ||= pageText.text.length > 0;
                nextPagesByNumber = applyExtractedTexts(nextPagesByNumber, [pageText], signal);
                const page = nextPagesByNumber.get(pageText.pageNumber);
                if (page) {
                    onPageIndexed?.(page);
                }
            },
        };
        if (signal !== undefined) {
            extractOptions.signal = signal;
        }
        await extractTextWithPdfjs(pdfPath, extractOptions);
        return {
            pagesByNumber: nextPagesByNumber,
            hasText,
        };
    } catch (pdfjsErr) {
        if (isAbortError(pdfjsErr)) {
            throw pdfjsErr;
        }
        const errMsg = getErrorMessage(pdfjsErr);
        log.warn(`Failed to extract text with pdfjs-dist: ${errMsg}`);
        return {
            pagesByNumber,
            hasText: false,
        };
    }
}

async function seedFromPdftotext(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
): Promise<{
    pagesByNumber: Map<number, IPageIndex>;
    hasText: boolean;
}> {
    try {
        log.debug(`Falling back to pdftotext (pageCount=${expectedCount ?? 'unknown'})`);
        const extractOptions: Parameters<typeof extractTextFromPdf>[1] = {};
        if (expectedCount !== undefined) {
            extractOptions.pageCount = expectedCount;
        }
        if (signal !== undefined) {
            extractOptions.signal = signal;
        }
        const pageTexts = await extractTextFromPdf(pdfPath, extractOptions);
        const hasText = pageTexts.some(pageText => pageText.text.length > 0);
        const nextPagesByNumber = applyExtractedTexts(pagesByNumber, pageTexts, signal);
        pageTexts.forEach((pageText) => {
            const page = nextPagesByNumber.get(pageText.pageNumber);
            if (page) {
                onPageIndexed?.(page);
            }
        });
        return {
            pagesByNumber: nextPagesByNumber,
            hasText,
        };
    } catch (pdfTextErr) {
        if (isAbortError(pdfTextErr)) {
            throw pdfTextErr;
        }
        const errMsg = getErrorMessage(pdfTextErr);
        log.warn(`Failed to extract text with pdftotext: ${errMsg}`);
        return {
            pagesByNumber,
            hasText: false,
        };
    }
}

async function shouldPreferPdftotextFirst(pdfPath: string) {
    try {
        const fileStat = await stat(pdfPath);
        return fileStat.size > SEARCH_PDFJS_FIRST_MAX_BYTES;
    } catch (err) {
        const errMsg = getErrorMessage(err);
        log.debug(`Unable to stat PDF before choosing text extractor: ${errMsg}`);
        return false;
    }
}

async function seedPagesFromPdfText(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
): Promise<Map<number, IPageIndex>> {
    if (await shouldPreferPdftotextFirst(pdfPath)) {
        const seeded = await seedFromPdftotext(pdfPath, pagesByNumber, expectedCount, signal, onPageIndexed);
        if (seeded.hasText) {
            return seeded.pagesByNumber;
        }
        return (await seedFromPdfjs(
            pdfPath,
            seeded.pagesByNumber,
            expectedCount,
            signal,
            onPageIndexed,
        )).pagesByNumber;
    }

    const seeded = await seedFromPdfjs(pdfPath, pagesByNumber, expectedCount, signal, onPageIndexed);
    if (seeded.hasText) {
        return seeded.pagesByNumber;
    }
    return (await seedFromPdftotext(
        pdfPath,
        seeded.pagesByNumber,
        expectedCount,
        signal,
        onPageIndexed,
    )).pagesByNumber;
}

function padMissingPages(
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
): Map<number, IPageIndex> {
    if (!isPositiveInteger(expectedCount)) {
        return pagesByNumber;
    }
    const nextPages = new Map(pagesByNumber);
    for (const pageNumber of range(1, expectedCount + 1)) {
        throwIfAborted(signal);
        if (nextPages.has(pageNumber)) {
            continue;
        }
        nextPages.set(pageNumber, {
            pageNumber,
            text: '',
        });
    }
    return nextPages;
}

function mergePageData(
    pagesByNumber: Map<number, IPageIndex>,
    pageData: IPageDataInput[] | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
): Map<number, IPageIndex> {
    if (!pageData?.length) {
        return pagesByNumber;
    }
    const nextPages = new Map(pagesByNumber);
    for (const page of pageData) {
        throwIfAborted(signal);
        const textFromWords = page.words.length > 0
            ? buildOcrTextLayerIndexText(page.words)
            : '';
        const textFromOcr = page.text?.trim() ?? '';
        const text = textFromWords || textFromOcr;
        const previous = nextPages.get(page.pageNumber);
        const indexedPage: IPageIndex = {
            pageNumber: page.pageNumber,
            text: text.length > 0
                ? text
                : previous?.text ?? '',
        };
        if (page.pageWidth !== undefined) {
            indexedPage.pageWidth = page.pageWidth;
        }
        if (page.pageHeight !== undefined) {
            indexedPage.pageHeight = page.pageHeight;
        }
        if (STORE_WORD_BOXES) {
            indexedPage.words = page.words;
        }
        onPageIndexed?.(indexedPage);
        nextPages.set(page.pageNumber, indexedPage);
    }
    return nextPages;
}

function assembleIndex(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    existing: IPdfSearchIndex | null,
): IPdfSearchIndex {
    const pages = sortBy(Array.from(pagesByNumber.values()), ['pageNumber']);
    const index: IPdfSearchIndex = {
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        pdfPath,
        createdAt: Date.now(),
        pages,
    };
    if (isPositiveInteger(expectedCount)) {
        index.pageCount = expectedCount;
    } else if (existing?.pageCount !== undefined) {
        index.pageCount = existing.pageCount;
    }
    return index;
}

/**
 * Build and save a search index from OCR page data
 * Index is saved as {pdfPath}.index.json for quick access on future searches
 */
export async function buildSearchIndex(
    pdfPath: string,
    pageData: IPageDataInput[],
    options: IBuildSearchIndexOptions = {},
): Promise<IPdfSearchIndex> {
    log.debug(`Building search index for ${pdfPath}`);

    const {
        pageCount: expectedCount,
        signal,
        onPageIndexed,
    } = options;
    throwIfAborted(signal);

    // Try OCR v2 index first - this is the preferred source for OCR'd PDFs
    // as it matches the text layer that PDF.js will display
    const ocrTexts = await loadOcrIndexText(pdfPath, expectedCount, onPageIndexed, signal);
    if (ocrTexts && ocrTexts.size > 0) {
        return buildIndexFromOcrTexts(pdfPath, ocrTexts, expectedCount, signal);
    }

    throwIfAborted(signal);
    const existing = await loadSearchIndex(pdfPath);
    throwIfAborted(signal);

    let pagesByNumber = seedFromExistingIndex(existing);

    if (shouldExtractPdfText(pagesByNumber, existing, expectedCount)) {
        pagesByNumber = await seedPagesFromPdfText(pdfPath, pagesByNumber, expectedCount, signal, onPageIndexed);
    }

    pagesByNumber = padMissingPages(pagesByNumber, expectedCount, signal);
    pagesByNumber = mergePageData(pagesByNumber, pageData, signal, onPageIndexed);

    if (pagesByNumber.size === 0) {
        throw new Error('No pages available to build search index');
    }

    const index = assembleIndex(pdfPath, pagesByNumber, expectedCount, existing);

    log.debug(`Saving index to ${getIndexPath(pdfPath)}`);
    try {
        await persistIndex(pdfPath, index, signal);
        await ensureNativeSearchIndexBestEffort(pdfPath, index, signal);
        return index;
    } catch (err) {
        if (isAbortError(err)) {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log.debug(`Failed to save index: ${errMsg}`);
        throw err;
    }
}

/**
 * Load a cached search index from disk
 */
export async function loadSearchIndex(pdfPath: string): Promise<IPdfSearchIndex | null> {
    const indexPath = getIndexPath(pdfPath);

    try {
        const content = await readFile(indexPath, 'utf-8');
        const index = parseSearchIndexPayload(JSON.parse(content));
        if (!index) {
            log.warn(`Invalid search index schema at ${indexPath}; ignoring cached index`);
            return null;
        }
        log.debug(`Loaded index from ${indexPath}`);
        return index;
    } catch {
        log.debug(`Index not found or invalid: ${indexPath}`);
        return null;
    }
}
