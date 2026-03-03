import { existsSync } from 'fs';
import {
    readFile,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import type { IOcrWord } from '@contracts/shared';
import { extractTextFromPdf } from '@electron/search/pdf-text-extractor';
import { extractTextWithPdfjs } from '@electron/search/pdfjs-text-extractor';
import { createLogger } from '@electron/utils/logger';

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

function isAbortError(error: unknown) {
    return error instanceof Error && (
        error.name === 'AbortError'
        || error.message.toLowerCase().includes('aborted')
    );
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
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to load OCR v2 index: ${errMsg}`);
        return null;
    }
}

function getIndexPath(pdfPath: string) {
    return `${pdfPath}.index.json`;
}

function parseSearchIndexPayload(payload: unknown): IPdfSearchIndex | null {
    if (!isRecord(payload) || !Array.isArray(payload.pages)) {
        return null;
    }
    if (typeof payload.pdfPath !== 'string' || payload.pdfPath.length === 0) {
        return null;
    }

    const normalizedPages: IPageIndex[] = [];
    for (const page of payload.pages) {
        if (!isRecord(page)) {
            return null;
        }
        if (
            typeof page.pageNumber !== 'number'
            || !Number.isInteger(page.pageNumber)
            || page.pageNumber < 1
        ) {
            return null;
        }
        if (typeof page.text !== 'string') {
            return null;
        }

        normalizedPages.push({
            pageNumber: page.pageNumber,
            text: page.text,
            words: Array.isArray(page.words) ? page.words as IOcrWord[] : undefined,
            pageWidth: typeof page.pageWidth === 'number' && Number.isFinite(page.pageWidth)
                ? page.pageWidth
                : undefined,
            pageHeight: typeof page.pageHeight === 'number' && Number.isFinite(page.pageHeight)
                ? page.pageHeight
                : undefined,
        });
    }
    normalizedPages.sort((a, b) => a.pageNumber - b.pageNumber);

    return {
        pdfPath: payload.pdfPath,
        createdAt: typeof payload.createdAt === 'number' && Number.isFinite(payload.createdAt)
            ? payload.createdAt
            : Date.now(),
        pages: normalizedPages,
        pageCount: typeof payload.pageCount === 'number' && Number.isInteger(payload.pageCount) && payload.pageCount > 0
            ? payload.pageCount
            : undefined,
    };
}

/**
 * Build and save a search index from OCR page data
 * Index is saved as {pdfPath}.index.json for quick access on future searches
 */
export async function buildSearchIndex(
    pdfPath: string,
    pageData: Array<{
        pageNumber: number;
        words: IOcrWord[];
        text?: string;
        pageWidth?: number;
        pageHeight?: number;
    }>,
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
        log.debug(`Using OCR v2 index with ${ocrTexts.size} pages`);
        const pages: IPageIndex[] = [];
        for (const [
            pageNum,
            text,
        ] of ocrTexts) {
            throwIfAborted(signal);
            pages.push({
                pageNumber: pageNum,
                text,
            });
        }
        pages.sort((a, b) => a.pageNumber - b.pageNumber);

        const index: IPdfSearchIndex = {
            pdfPath,
            createdAt: Date.now(),
            pages,
            pageCount: typeof expectedCount === 'number' && expectedCount > 0
                ? expectedCount
                : pages.length,
        };

        // Save index for future use
        const indexPath = getIndexPath(pdfPath);
        try {
            throwIfAborted(signal);
            await writeFile(indexPath, JSON.stringify(index), 'utf-8');
            log.debug(`Saved OCR-based index to ${indexPath}`);
        } catch (err) {
            if (isAbortError(err)) {
                throw err;
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            log.debug(`Warning: Failed to save OCR-based index: ${errMsg}`);
        }

        return index;
    }

    // Fall back to existing index or pdftotext
    const pagesByNumber = new Map<number, IPageIndex>();
    throwIfAborted(signal);
    const existing = await loadSearchIndex(pdfPath);
    throwIfAborted(signal);

    if (existing?.pages?.length) {
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

    const hasAnyText = Array.from(pagesByNumber.values()).some(p => (p.text ?? '').length > 0);
    const needsPdfText = !existing
        || !hasAnyText
        || (typeof expectedCount === 'number' && expectedCount > 0 && pagesByNumber.size < expectedCount);

    if (needsPdfText) {
        let seeded = false;

        // Primary: pdfjs-dist — matches the text layer exactly
        try {
            log.debug(`Seeding index with pdfjs-dist (pageCount=${expectedCount ?? 'unknown'})`);
            const pageTexts = await extractTextWithPdfjs(pdfPath, { signal });
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
            seeded = pageTexts.some(pt => pt.text.length > 0);
        } catch (pdfjsErr) {
            if (isAbortError(pdfjsErr)) {
                throw pdfjsErr;
            }
            const errMsg = pdfjsErr instanceof Error ? pdfjsErr.message : String(pdfjsErr);
            log.warn(`Failed to extract text with pdfjs-dist: ${errMsg}`);
        }

        // Fallback: pdftotext (Poppler CLI) for edge cases
        if (!seeded) {
            try {
                log.debug(`Falling back to pdftotext (pageCount=${expectedCount ?? 'unknown'})`);
                const pageTexts = await extractTextFromPdf(pdfPath, {
                    pageCount: expectedCount,
                    signal,
                });
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
            } catch (pdfTextErr) {
                if (isAbortError(pdfTextErr)) {
                    throw pdfTextErr;
                }
                const errMsg = pdfTextErr instanceof Error ? pdfTextErr.message : String(pdfTextErr);
                log.warn(`Failed to extract text with pdftotext: ${errMsg}`);
            }
        }
    }

    if (typeof expectedCount === 'number' && expectedCount > 0) {
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

    if (pageData?.length) {
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

    if (pagesByNumber.size === 0) {
        throw new Error('No pages available to build search index');
    }

    const pages: IPageIndex[] = Array.from(pagesByNumber.values()).sort((a, b) => a.pageNumber - b.pageNumber);

    const index: IPdfSearchIndex = {
        pdfPath,
        createdAt: Date.now(),
        pages,
        pageCount: typeof expectedCount === 'number' && expectedCount > 0 ? expectedCount : existing?.pageCount,
    };

    const indexPath = getIndexPath(pdfPath);
    log.debug(`Saving index to ${indexPath}`);

    try {
        throwIfAborted(signal);
        await writeFile(indexPath, JSON.stringify(index), 'utf-8');
        log.debug(`Index saved successfully: ${indexPath}`);
        return index;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
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
