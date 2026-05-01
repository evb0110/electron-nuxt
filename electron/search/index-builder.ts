import { existsSync } from 'fs';
import {
    readFile,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import type { IOcrWord } from '@contracts/shared';
import { extractTextFromPdf } from '@electron/search/pdf-text-extractor';
import { extractTextWithPdfjs } from '@electron/search/pdfjs-text-extractor';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

export interface IPageIndex {
    pageNumber: number;
    text: string;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

export interface IPdfSearchIndex {
    pdfPath: string;
    createdAt: number;
    pages: IPageIndex[];
    pageCount?: number;
}

const log = createLogger('index-builder');

const STORE_WORD_BOXES = false;

interface IOcrIndexV2Manifest {
    version: number;
    createdAt: number;
    source: { pdfPath: string };
    pageCount: number;
    pageBox: string;
    ocr: {
        engine: string;
        languages: string[];
        renderDpi: number;
    };
    pages: Record<number, { path: string }>;
}

interface IOcrIndexV2Page {
    pageNumber: number;
    text: string;
}

interface IBuildSearchIndexOptions {
    pageCount?: number;
    signal?: AbortSignal;
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function finiteNumberOrUndefined(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

/**
 * Load OCR v2 index text for all pages.
 * Returns a Map of pageNumber -> text, or null if no v2 index exists.
 */
async function loadOcrIndexText(
    pdfPath: string,
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
        const manifest = JSON.parse(manifestJson) as IOcrIndexV2Manifest;

        if (manifest.version < 2) {
            log.debug(`OCR index version ${manifest.version} < 2, skipping`);
            return null;
        }

        const pageTexts = new Map<number, string>();

        for (const [
            pageNumStr,
            pageInfo,
        ] of Object.entries(manifest.pages)) {
            throwIfAborted(signal);
            const pageNum = parseInt(pageNumStr, 10);
            if (!Number.isInteger(pageNum) || pageNum < 1) {
                log.warn(`Skipping OCR page with invalid page number "${pageNumStr}" in manifest`);
                continue;
            }
            const pagePath = join(ocrDir, pageInfo.path);

            if (existsSync(pagePath)) {
                const pageJson = await readFile(pagePath, 'utf-8');
                throwIfAborted(signal);
                const pageData = JSON.parse(pageJson) as IOcrIndexV2Page;
                pageTexts.set(pageNum, pageData.text || '');
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

    return {
        pageNumber: page.pageNumber,
        text: page.text,
        words: Array.isArray(page.words) ? page.words as IOcrWord[] : undefined,
        pageWidth: finiteNumberOrUndefined(page.pageWidth),
        pageHeight: finiteNumberOrUndefined(page.pageHeight),
    };
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
    normalizedPages.sort((a, b) => a.pageNumber - b.pageNumber);
    return normalizedPages;
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

    return {
        pdfPath: payload.pdfPath,
        createdAt: createdAt ?? Date.now(),
        pages: normalizedPages,
        pageCount: isPositiveInteger(payload.pageCount) ? payload.pageCount : undefined,
    };
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
    pages.sort((a, b) => a.pageNumber - b.pageNumber);
    return pages;
}

async function persistIndex(
    pdfPath: string,
    index: IPdfSearchIndex,
    signal?: AbortSignal,
): Promise<void> {
    throwIfAborted(signal);
    const indexPath = getIndexPath(pdfPath);
    await writeFile(indexPath, JSON.stringify(index), 'utf-8');
    log.debug(`Index saved successfully: ${indexPath}`);
}

async function persistIndexBestEffort(
    pdfPath: string,
    index: IPdfSearchIndex,
    signal?: AbortSignal,
): Promise<void> {
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
        pdfPath,
        createdAt: Date.now(),
        pages,
        pageCount: isPositiveInteger(expectedCount) ? expectedCount : pages.length,
    };

    await persistIndexBestEffort(pdfPath, index, signal);
    return index;
}

function seedFromExistingIndex(
    pagesByNumber: Map<number, IPageIndex>,
    existing: IPdfSearchIndex | null,
): void {
    if (!existing?.pages?.length) {
        return;
    }
    existing.pages.forEach((page) => {
        pagesByNumber.set(page.pageNumber, {
            pageNumber: page.pageNumber,
            text: page.text ?? '',
            pageWidth: page.pageWidth,
            pageHeight: page.pageHeight,
            words: STORE_WORD_BOXES ? page.words : undefined,
        });
    });
}

function shouldExtractPdfText(
    pagesByNumber: Map<number, IPageIndex>,
    existing: IPdfSearchIndex | null,
    expectedCount: number | undefined,
): boolean {
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
): void {
    for (const pt of pageTexts) {
        throwIfAborted(signal);
        const entry = pagesByNumber.get(pt.pageNumber);
        if (!entry) {
            pagesByNumber.set(pt.pageNumber, {
                pageNumber: pt.pageNumber,
                text: pt.text,
                words: undefined,
            });
            continue;
        }

        if (!entry.text && pt.text) {
            entry.text = pt.text;
        }
    }
}

async function seedFromPdfjs(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
): Promise<boolean> {
    try {
        log.debug(`Seeding index with pdfjs-dist (pageCount=${expectedCount ?? 'unknown'})`);
        const pageTexts = await extractTextWithPdfjs(pdfPath, { signal });
        applyExtractedTexts(pagesByNumber, pageTexts, signal);
        return pageTexts.some(pt => pt.text.length > 0);
    } catch (pdfjsErr) {
        if (isAbortError(pdfjsErr)) {
            throw pdfjsErr;
        }
        const errMsg = getErrorMessage(pdfjsErr);
        log.warn(`Failed to extract text with pdfjs-dist: ${errMsg}`);
        return false;
    }
}

async function seedFromPdftotext(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
): Promise<void> {
    try {
        log.debug(`Falling back to pdftotext (pageCount=${expectedCount ?? 'unknown'})`);
        const pageTexts = await extractTextFromPdf(pdfPath, {
            pageCount: expectedCount,
            signal,
        });
        applyExtractedTexts(pagesByNumber, pageTexts, signal);
    } catch (pdfTextErr) {
        if (isAbortError(pdfTextErr)) {
            throw pdfTextErr;
        }
        const errMsg = getErrorMessage(pdfTextErr);
        log.warn(`Failed to extract text with pdftotext: ${errMsg}`);
    }
}

async function seedPagesFromPdfText(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
): Promise<void> {
    const seeded = await seedFromPdfjs(pdfPath, pagesByNumber, expectedCount, signal);
    if (seeded) {
        return;
    }
    await seedFromPdftotext(pdfPath, pagesByNumber, expectedCount, signal);
}

function padMissingPages(
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
): void {
    if (!isPositiveInteger(expectedCount)) {
        return;
    }
    for (let pageNumber = 1; pageNumber <= expectedCount; pageNumber += 1) {
        throwIfAborted(signal);
        if (!pagesByNumber.has(pageNumber)) {
            pagesByNumber.set(pageNumber, {
                pageNumber,
                text: '',
                words: undefined,
            });
        }
    }
}

function mergePageData(
    pagesByNumber: Map<number, IPageIndex>,
    pageData: IPageDataInput[] | undefined,
    signal?: AbortSignal,
): void {
    if (!pageData?.length) {
        return;
    }
    pageData.forEach((page) => {
        throwIfAborted(signal);
        const textFromOcr = page.text?.trim() ?? '';
        const textFromWords = textFromOcr
            ? ''
            : page.words.map(w => w.text).join(' ').trim();
        const text = textFromOcr || textFromWords;
        const previous = pagesByNumber.get(page.pageNumber);
        pagesByNumber.set(page.pageNumber, {
            pageNumber: page.pageNumber,
            text: text || previous?.text || '',
            pageWidth: page.pageWidth,
            pageHeight: page.pageHeight,
            words: STORE_WORD_BOXES ? page.words : undefined,
        });
    });
}

function assembleIndex(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    existing: IPdfSearchIndex | null,
): IPdfSearchIndex {
    const pages = Array.from(pagesByNumber.values()).sort((a, b) => a.pageNumber - b.pageNumber);
    return {
        pdfPath,
        createdAt: Date.now(),
        pages,
        pageCount: isPositiveInteger(expectedCount) ? expectedCount : existing?.pageCount,
    };
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
    } = options;
    throwIfAborted(signal);

    // Try OCR v2 index first - this is the preferred source for OCR'd PDFs
    // as it matches the text layer that PDF.js will display
    const ocrTexts = await loadOcrIndexText(pdfPath, signal);
    if (ocrTexts && ocrTexts.size > 0) {
        return buildIndexFromOcrTexts(pdfPath, ocrTexts, expectedCount, signal);
    }

    const pagesByNumber = new Map<number, IPageIndex>();
    throwIfAborted(signal);
    const existing = await loadSearchIndex(pdfPath);
    throwIfAborted(signal);

    seedFromExistingIndex(pagesByNumber, existing);

    if (shouldExtractPdfText(pagesByNumber, existing, expectedCount)) {
        await seedPagesFromPdfText(pdfPath, pagesByNumber, expectedCount, signal);
    }

    padMissingPages(pagesByNumber, expectedCount, signal);
    mergePageData(pagesByNumber, pageData, signal);

    if (pagesByNumber.size === 0) {
        throw new Error('No pages available to build search index');
    }

    const index = assembleIndex(pdfPath, pagesByNumber, expectedCount, existing);

    log.debug(`Saving index to ${getIndexPath(pdfPath)}`);
    try {
        await persistIndex(pdfPath, index, signal);
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
