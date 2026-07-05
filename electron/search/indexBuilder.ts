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
    IOcrIndexV3Manifest,
    IOcrIndexV3Page,
    TOcrIndexRotation,
} from '@contracts/ocrIndex';
import type {
    IDocumentRevisionStamp,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    OCR_TEXT_LAYER_INDEX_SOURCE,
    OCR_TEXT_LAYER_INDEX_VERSION,
    buildOcrTextLayerIndexText,
} from '@contracts/ocrText';
import { extractTextFromPdf } from '@electron/search/extractTextFromPdf';
import {
    extractTextWithPdfjs,
    extractTextWithPdfjsWordBoxes,
} from '@electron/search/extractTextWithPdfjs';
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
    persistCompactSearchIndexBestEffort,
} from '@electron/search/searchIndexSidecar';
import { ensureNativeSearchIndexBestEffort } from '@electron/search/nativeSearchIndex';
import { stringifyLegacyJsonSearchIndex } from '@electron/search/stringifyLegacyJsonSearchIndex';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import { assertWorkingCopyRevisionCurrent } from '@electron/file-access/documentRevisionSidecar';

export interface IPageIndex {
    pageNumber: number;
    text: string;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
    rotation?: TOcrIndexRotation;
}

export interface IPdfSearchIndex {
    schemaVersion?: number;
    documentRevision: IDocumentRevisionStamp;
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

export const SEARCH_INDEX_SCHEMA_VERSION = 7;
const SEARCH_PDFJS_FIRST_MAX_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_PDFJS_FIRST_MAX_MB ?? '96', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 96 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();
interface IBuildSearchIndexOptions {
    documentRevision: TDocumentRevisionToken;
    pageCount?: number;
    signal?: AbortSignal;
    onPageIndexed?: (page: IPageIndex) => void;
    validateBeforePersist?: (index: IPdfSearchIndex) => void;
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
    rotation?: TOcrIndexRotation;
}

interface ILoadedOcrIndexPages {
    pagesByNumber: Map<number, IPageIndex>;
    pageCount: number;
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

function ocrRotationOrUndefined(value: unknown): TOcrIndexRotation | undefined {
    return value === 0 || value === 90 || value === 180 || value === 270
        ? value
        : undefined;
}

function ocrWordsOrUndefined(value: unknown) {
    return Array.isArray(value) && value.every(isOcrWord)
        ? value
        : undefined;
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

function hasDocumentRevisionStamp(value: unknown): value is { token: string } {
    return isRecord(value)
        && typeof value.token === 'string'
        && value.token.length > 0;
}

function parseOcrManifestPayload(payload: unknown): IOcrIndexV3Manifest | null {
    if (!isRecord(payload) || !isRecord(payload.source) || !isRecord(payload.pages)) {
        return null;
    }
    if (
        payload.version !== 3
        || !hasDocumentRevisionStamp(payload.documentRevision)
        || typeof payload.source.pdfPath !== 'string'
        || !isPositiveInteger(payload.pageCount)
    ) {
        return null;
    }
    const pages: IOcrIndexV3Manifest['pages'] = {};
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
        version: 3,
        documentRevision: {token: payload.documentRevision.token},
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

function parseOcrPagePayload(payload: unknown): IOcrIndexV3Page | null {
    if (!isRecord(payload)) {
        return null;
    }
    if (
        !hasDocumentRevisionStamp(payload.documentRevision)
        || (payload.pageNumber !== undefined && !isPositiveInteger(payload.pageNumber))
    ) {
        return null;
    }
    if (payload.text !== undefined && typeof payload.text !== 'string') {
        return null;
    }
    const page: IOcrIndexV3Page = {
        pageNumber: isPositiveInteger(payload.pageNumber) ? payload.pageNumber : 0,
        documentRevision: {token: payload.documentRevision.token},
        rotation: ocrRotationOrUndefined(payload.rotation) ?? 0,
        render: {
            dpi: isRecord(payload.render)
                ? finiteNumberOrUndefined(payload.render.dpi) ?? 0
                : 0,
            imagePx: {
                w: isRecord(payload.render) && isRecord(payload.render.imagePx)
                    ? finiteNumberOrUndefined(payload.render.imagePx.w) ?? 0
                    : 0,
                h: isRecord(payload.render) && isRecord(payload.render.imagePx)
                    ? finiteNumberOrUndefined(payload.render.imagePx.h) ?? 0
                    : 0,
            },
        },
        text: typeof payload.text === 'string' ? payload.text : '',
        words: ocrWordsOrUndefined(payload.words) ?? [],
    };
    return page;
}

async function loadOcrIndexPages(
    pdfPath: string,
    expectedCount?: number,
    onPageIndexed?: (page: IPageIndex) => void,
    signal?: AbortSignal,
): Promise<ILoadedOcrIndexPages | null> {
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
        const parsedManifest: unknown = JSON.parse(manifestJson);
        const manifest = parseOcrManifestPayload(parsedManifest);

        if (!manifest) {
            log.debug('OCR v3 manifest is invalid, skipping');
            return null;
        }

        const pagesByNumber = new Map<number, IPageIndex>();

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
                if (pageData.documentRevision.token !== manifest.documentRevision.token) {
                    log.warn(`Skipping OCR page ${pageNum} with stale document revision`);
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
                const indexedPage: IPageIndex = {
                    pageNumber: pageNum,
                    text,
                    ...(pageData.render.imagePx.w > 0 ? { pageWidth: pageData.render.imagePx.w } : {}),
                    ...(pageData.render.imagePx.h > 0 ? { pageHeight: pageData.render.imagePx.h } : {}),
                    rotation: pageData.rotation,
                    ...(words.length > 0 ? { words } : {}),
                };
                pagesByNumber.set(pageNum, indexedPage);
                onPageIndexed?.(indexedPage);
            }
        }

        log.debug(`Loaded OCR v3 index with ${pagesByNumber.size} pages from ${ocrDir}`);
        return {
            pagesByNumber,
            pageCount: manifest.pageCount,
        };
    } catch (err) {
        if (isAbortError(err)) {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log.debug(`Failed to load OCR v3 index: ${errMsg}`);
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
    const rotation = ocrRotationOrUndefined(page.rotation);
    if (rotation !== undefined) {
        normalizedPage.rotation = rotation;
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

function parseSearchIndexPayload(
    payload: unknown,
    expectedPdfPath: string,
    expectedRevision?: TDocumentRevisionToken,
): IPdfSearchIndex | null {
    if (!isRecord(payload) || !Array.isArray(payload.pages)) {
        return null;
    }
    if (
        payload.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION
        || !hasDocumentRevisionStamp(payload.documentRevision)
        || (
            expectedRevision !== undefined
            && payload.documentRevision.token !== expectedRevision
        )
    ) {
        return null;
    }
    if (typeof payload.pdfPath !== 'string' || payload.pdfPath.length === 0) {
        return null;
    }
    if (normalizePathForLookup(payload.pdfPath) !== normalizePathForLookup(expectedPdfPath)) {
        return null;
    }

    const normalizedPages = parseSearchIndexPages(payload.pages);
    if (!normalizedPages) {
        return null;
    }

    const createdAt = finiteNumberOrUndefined(payload.createdAt);

    const normalizedIndex: IPdfSearchIndex = {
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        documentRevision: {token: payload.documentRevision.token},
        pdfPath: payload.pdfPath,
        createdAt: createdAt ?? Date.now(),
        pages: normalizedPages,
    };
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

function pagesFromOcrIndexPages(
    ocrPages: Map<number, IPageIndex>,
    signal?: AbortSignal,
): IPageIndex[] {
    const pages: IPageIndex[] = [];
    for (const page of ocrPages.values()) {
        throwIfAborted(signal);
        pages.push(page);
    }
    return sortBy(pages, ['pageNumber']);
}

function hasCompleteExpectedCoverage(
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
) {
    if (!isPositiveInteger(expectedCount)) {
        return false;
    }
    for (const pageNumber of range(1, expectedCount + 1)) {
        throwIfAborted(signal);
        if (!pagesByNumber.has(pageNumber)) {
            return false;
        }
    }
    return true;
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
        await writeFile(tempPath, stringifyLegacyJsonSearchIndex(index, signal), 'utf-8');
        throwIfAborted(signal);
        await assertWorkingCopyRevisionCurrent(pdfPath, index.documentRevision.token);
        await atomicReplace(tempPath, indexPath);
        try {
            await assertWorkingCopyRevisionCurrent(pdfPath, index.documentRevision.token);
        } catch (error) {
            await rm(indexPath, { force: true }).catch(() => undefined);
            throw error;
        }
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
        if (err instanceof Error && err.message === 'Document revision is stale') {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log.debug(`Warning: Failed to save OCR-based index: ${errMsg}`);
    }
}

async function buildIndexFromOcrPages(
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    ocrPages: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    validateBeforePersist?: (index: IPdfSearchIndex) => void,
): Promise<IPdfSearchIndex> {
    log.debug(`Using OCR v3 index with ${ocrPages.size} pages`);
    const pages = pagesFromOcrIndexPages(ocrPages, signal);

    const index: IPdfSearchIndex = {
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        documentRevision: {token: documentRevision},
        pdfPath,
        createdAt: Date.now(),
        pages,
        pageCount: isPositiveInteger(expectedCount) ? expectedCount : pages.length,
        textSource: {
            kind: OCR_TEXT_LAYER_INDEX_SOURCE,
            version: OCR_TEXT_LAYER_INDEX_VERSION,
        },
    };

    validateBeforePersist?.(index);
    await persistIndexBestEffort(pdfPath, index, signal);
    await persistCompactSearchIndexBestEffort(pdfPath, {
        documentRevision,
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
            ...(page.rotation !== undefined ? { rotation: page.rotation } : {}),
            ...(page.words !== undefined ? { words: page.words } : {}),
        },
    ]));
}

function hasAnyWordGeometry(pagesByNumber: Map<number, IPageIndex>) {
    return Array.from(pagesByNumber.values()).some(page => (
        Array.isArray(page.words)
        && page.words.length > 0
        && typeof page.pageWidth === 'number'
        && Number.isFinite(page.pageWidth)
        && page.pageWidth > 0
        && typeof page.pageHeight === 'number'
        && Number.isFinite(page.pageHeight)
        && page.pageHeight > 0
    ));
}

function shouldExtractPdfText(
    pagesByNumber: Map<number, IPageIndex>,
    existing: IPdfSearchIndex | null,
    expectedCount: number | undefined,
) {
    if (!existing) {
        return true;
    }
    if (existing.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION) {
        return true;
    }
    const hasAnyText = Array.from(pagesByNumber.values()).some(p => (p.text ?? '').length > 0);
    if (!hasAnyText) {
        return true;
    }
    if (isPositiveInteger(expectedCount) && pagesByNumber.size < expectedCount) {
        return true;
    }
    if (!hasAnyWordGeometry(pagesByNumber)) {
        return true;
    }
    return false;
}

function applyExtractedTexts(
    pagesByNumber: Map<number, IPageIndex>,
    pageTexts: IExtractedPageText[],
    signal?: AbortSignal,
    preservePageNumbers: ReadonlySet<number> = new Set(),
): Map<number, IPageIndex> {
    const nextPages = new Map(pagesByNumber);
    for (const pt of pageTexts) {
        throwIfAborted(signal);
        const entry = nextPages.get(pt.pageNumber);
        if (entry && preservePageNumbers.has(pt.pageNumber)) {
            continue;
        }
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

function applyExtractedPages(
    pagesByNumber: Map<number, IPageIndex>,
    extractedPages: IPageIndex[],
    signal?: AbortSignal,
    preservePageNumbers: ReadonlySet<number> = new Set(),
): Map<number, IPageIndex> {
    const nextPages = new Map(pagesByNumber);
    for (const extractedPage of extractedPages) {
        throwIfAborted(signal);
        const previous = nextPages.get(extractedPage.pageNumber);
        if (previous && preservePageNumbers.has(extractedPage.pageNumber)) {
            continue;
        }
        const text = extractedPage.text.length > 0
            ? extractedPage.text
            : previous?.text ?? '';
        nextPages.set(extractedPage.pageNumber, {
            pageNumber: extractedPage.pageNumber,
            text,
            ...(extractedPage.pageWidth !== undefined ? { pageWidth: extractedPage.pageWidth } : {}),
            ...(extractedPage.pageHeight !== undefined ? { pageHeight: extractedPage.pageHeight } : {}),
            ...(extractedPage.rotation !== undefined ? { rotation: extractedPage.rotation } : {}),
            ...(extractedPage.words !== undefined ? { words: extractedPage.words } : {}),
        });
    }
    return nextPages;
}

async function seedFromPdfjsWordBoxes(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
    preservePageNumbers: ReadonlySet<number> = new Set(),
): Promise<{
    pagesByNumber: Map<number, IPageIndex>;
    hasText: boolean;
}> {
    try {
        log.debug(`Seeding index with pdfjs-dist word geometry (pageCount=${expectedCount ?? 'unknown'})`);
        let hasText = false;
        let nextPagesByNumber = pagesByNumber;
        const extractOptions: Parameters<typeof extractTextWithPdfjsWordBoxes>[1] = {
            collectPages: false,
            onPageText: (pageText) => {
                hasText ||= pageText.text.length > 0;
                nextPagesByNumber = applyExtractedPages(nextPagesByNumber, [pageText], signal, preservePageNumbers);
                const page = nextPagesByNumber.get(pageText.pageNumber);
                if (page && !preservePageNumbers.has(pageText.pageNumber)) {
                    onPageIndexed?.(page);
                }
            },
        };
        if (signal !== undefined) {
            extractOptions.signal = signal;
        }
        await extractTextWithPdfjsWordBoxes(pdfPath, extractOptions);
        return {
            pagesByNumber: nextPagesByNumber,
            hasText,
        };
    } catch (pdfjsErr) {
        if (isAbortError(pdfjsErr)) {
            throw pdfjsErr;
        }
        const errMsg = getErrorMessage(pdfjsErr);
        log.warn(`Failed to extract text geometry with pdfjs-dist: ${errMsg}`);
        return {
            pagesByNumber,
            hasText: false,
        };
    }
}

async function seedFromPdfjs(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
    preservePageNumbers: ReadonlySet<number> = new Set(),
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
                nextPagesByNumber = applyExtractedTexts(nextPagesByNumber, [pageText], signal, preservePageNumbers);
                const page = nextPagesByNumber.get(pageText.pageNumber);
                if (page && !preservePageNumbers.has(pageText.pageNumber)) {
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
    preservePageNumbers: ReadonlySet<number> = new Set(),
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
        const nextPagesByNumber = applyExtractedTexts(pagesByNumber, pageTexts, signal, preservePageNumbers);
        pageTexts.forEach((pageText) => {
            const page = nextPagesByNumber.get(pageText.pageNumber);
            if (page && !preservePageNumbers.has(pageText.pageNumber)) {
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
    preservePageNumbers: ReadonlySet<number> = new Set(),
): Promise<Map<number, IPageIndex>> {
    const seededWithWordBoxes = await seedFromPdfjsWordBoxes(
        pdfPath,
        pagesByNumber,
        expectedCount,
        signal,
        onPageIndexed,
        preservePageNumbers,
    );
    if (seededWithWordBoxes.hasText) {
        return seededWithWordBoxes.pagesByNumber;
    }

    if (await shouldPreferPdftotextFirst(pdfPath)) {
        const seeded = await seedFromPdftotext(pdfPath, seededWithWordBoxes.pagesByNumber, expectedCount, signal, onPageIndexed, preservePageNumbers);
        if (seeded.hasText) {
            return seeded.pagesByNumber;
        }
        return (await seedFromPdfjs(
            pdfPath,
            seeded.pagesByNumber,
            expectedCount,
            signal,
            onPageIndexed,
            preservePageNumbers,
        )).pagesByNumber;
    }

    const seeded = await seedFromPdfjs(pdfPath, seededWithWordBoxes.pagesByNumber, expectedCount, signal, onPageIndexed, preservePageNumbers);
    if (seeded.hasText) {
        return seeded.pagesByNumber;
    }
    return (await seedFromPdftotext(
        pdfPath,
        seeded.pagesByNumber,
        expectedCount,
        signal,
        onPageIndexed,
        preservePageNumbers,
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
        if (page.rotation !== undefined) {
            indexedPage.rotation = page.rotation;
        }
        if (page.words.length > 0) {
            indexedPage.words = page.words;
        }
        onPageIndexed?.(indexedPage);
        nextPages.set(page.pageNumber, indexedPage);
    }
    return nextPages;
}

function assembleIndex(
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    existing: IPdfSearchIndex | null,
): IPdfSearchIndex {
    const pages = sortBy(Array.from(pagesByNumber.values()), ['pageNumber']);
    const index: IPdfSearchIndex = {
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        documentRevision: {token: documentRevision},
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
    options: IBuildSearchIndexOptions,
): Promise<IPdfSearchIndex> {
    log.debug(`Building search index for ${pdfPath}`);

    const {
        documentRevision,
        pageCount: expectedCount,
        signal,
        onPageIndexed,
        validateBeforePersist,
    } = options;
    if (!documentRevision) {
        throw new Error('documentRevision is required to build a search index');
    }
    throwIfAborted(signal);

    const ocrIndex = await loadOcrIndexPages(pdfPath, expectedCount, onPageIndexed, signal);
    const ocrPages = ocrIndex?.pagesByNumber;
    const effectiveExpectedCount = isPositiveInteger(expectedCount)
        ? expectedCount
        : ocrIndex?.pageCount;
    if (ocrPages && ocrPages.size > 0 && hasCompleteExpectedCoverage(ocrPages, effectiveExpectedCount, signal)) {
        return buildIndexFromOcrPages(
            pdfPath,
            documentRevision,
            ocrPages,
            effectiveExpectedCount,
            signal,
            validateBeforePersist,
        );
    }

    throwIfAborted(signal);
    const existing = await loadSearchIndex(pdfPath, documentRevision);
    throwIfAborted(signal);

    let pagesByNumber = ocrPages && ocrPages.size > 0
        ? new Map(ocrPages)
        : seedFromExistingIndex(existing);
    const preservedOcrPages = new Set(ocrPages?.keys() ?? []);

    if (shouldExtractPdfText(pagesByNumber, existing, effectiveExpectedCount)) {
        pagesByNumber = await seedPagesFromPdfText(
            pdfPath,
            pagesByNumber,
            effectiveExpectedCount,
            signal,
            onPageIndexed,
            preservedOcrPages,
        );
    }

    pagesByNumber = padMissingPages(pagesByNumber, effectiveExpectedCount, signal);
    pagesByNumber = mergePageData(pagesByNumber, pageData, signal, onPageIndexed);

    if (pagesByNumber.size === 0) {
        throw new Error('No pages available to build search index');
    }

    const index = assembleIndex(pdfPath, documentRevision, pagesByNumber, effectiveExpectedCount, existing);

    log.debug(`Saving index to ${getIndexPath(pdfPath)}`);
    try {
        validateBeforePersist?.(index);
        await persistIndex(pdfPath, index, signal);
        await ensureNativeSearchIndexBestEffort(pdfPath, index, documentRevision, signal);
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
export async function loadSearchIndex(
    pdfPath: string,
    expectedRevision?: TDocumentRevisionToken,
): Promise<IPdfSearchIndex | null> {
    const indexPath = getIndexPath(pdfPath);

    try {
        const content = await readFile(indexPath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        const index = parseSearchIndexPayload(parsed, pdfPath, expectedRevision);
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
