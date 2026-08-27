import {
    open,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    randomUUID,
    createHash,
} from 'node:crypto';
import {
    dirname,
    join,
} from 'node:path';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IOcrIndexV3Manifest,
    TOcrPageArtifact,
} from '@contracts/ocrIndex';
import type {
    IDocumentOcrAvailability,
    IDocumentOcrPageRange,
    IDocumentOcrPageSnapshot,
    IDocumentTextCatalogPage,
    IDocumentTextSnapshot,
    IDocumentTextCatalogWindow,
} from '@contracts/documentTextCatalog';
import {
    MAX_DOCUMENT_OCR_AVAILABILITY_RANGES,
    MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH,
    MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS,
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH,
    MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH,
} from '@contracts/documentTextCatalog';
import {
    OCR_MAX_WINDOW_PAGES,
    OCR_SCALAR_PAGE_LIMIT,
} from '@contracts/ocrIndex';
import {assembleSearchablePageText} from '@contracts/search';
import {buildOcrTextLayerIndexText} from '@contracts/ocrText';
import {extractTextFromPdf} from '@electron/search/extractTextFromPdf';
import type {IPageTextWithWordBoxes} from '@electron/search/extractTextWithPdfjs';
import {loadPdfjsTextExtractor} from '@electron/search/loadPdfjsTextExtractor';
import {assertWorkingCopyRevisionSidecarCurrent} from '@electron/file-access/documentRevisionSidecar';
import {
    OcrCatalogTooLargeError,
    openCatalog,
    type IOcrCatalogHandle,
} from '@electron/ocr/ocrCatalogV4';
import {
    migrateOcrIndexV3ToV4,
    remapOcrCatalogV4,
} from '@electron/ocr/worker/indexWriterV4';
import {
    readOcrIndexV3ManifestMetadata,
    streamOcrIndexV3ManifestMappings,
} from '@electron/ocr/ocrIndexV3Stream';

interface IVisitDocumentOcrCatalogOptions {
    signal?: AbortSignal;
    onPage: (page: IDocumentTextCatalogPage) => void;
}

interface IVisitDocumentTextCatalogPagesOptions {
    pageCount?: number;
    firstPage?: number;
    lastPage?: number;
    pageWindow?: number;
    sourcePdfPath?: string;
    signal?: AbortSignal;
    onPage: (page: IDocumentTextCatalogPage) => void | Promise<void>;
}

export interface IResolveDocumentTextCatalogOptions {
    pageWindow?: number;
    signal?: AbortSignal;
    sourcePdfPath?: string;
}

const DOCUMENT_TEXT_EXPORT_PAGE_WINDOW = MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES;
const DOCUMENT_TEXT_EXPORT_PDFJS_MAX_PAGES = 200;
const DOCUMENT_TEXT_EXPORT_PDFJS_MAX_BYTES = 16 * 1024 * 1024;
const OCR_V3_COMPATIBILITY_PAGE_LIMIT = 1_024;

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('The operation was aborted.', 'AbortError');
    }
}

function temporaryPath(path: string) {
    return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

async function syncDirectory(path: string) {
    const directory = await open(path, 'r');
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

async function writeJsonAtomic(path: string, value: unknown) {
    const tempPath = temporaryPath(path);
    try {
        await writeFile(tempPath, JSON.stringify(value), 'utf8');
        const file = await open(tempPath, 'r');
        try {
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(tempPath, path);
        await syncDirectory(dirname(path));
    } catch (error) {
        const errors: unknown[] = [error];
        try {
            await rm(tempPath, {force: true});
            await syncDirectory(dirname(path));
        } catch (cleanupError) {
            errors.push(cleanupError);
        }
        if (errors.length > 1) {
            throw new AggregateError(errors, 'OCR document text catalog cleanup failed');
        }
        throw error;
    }
}

async function rebindV4CatalogRevision(
    catalogRoot: string,
    workingCopyPath: string,
    expectedRevision: TDocumentRevisionToken,
    nextRevision: TDocumentRevisionToken,
    pageCount: number,
) {
    const ranges = pageCount === 0
        ? []
        : [{
            kind: 'retain' as const,
            fromPageNumber: 1,
            toPageNumber: 1,
            count: pageCount,
        }];
    const result = await remapOcrCatalogV4({
        catalogRoot,
        delta: {
            previousPageCount: pageCount,
            nextPageCount: pageCount,
            ranges,
        },
        nextRevision,
        sourcePdfPath: workingCopyPath,
    });
    if (result === null) {
        throw new Error('OCR DocumentTextCatalog is missing or stale');
    }
}

/** Re-keys the canonical text catalog during the OCR PDF revision transition. */
export async function rebindDocumentTextCatalogRevision(
    workingCopyPath: string,
    expectedRevision: TDocumentRevisionToken,
    nextRevision: TDocumentRevisionToken,
) {
    const catalogRoot = `${workingCopyPath}.ocr`;
    let catalog: IOcrCatalogHandle | null;
    try {
        catalog = await openCatalog(catalogRoot, {expectedDocumentRevision: expectedRevision});
    } catch {
        throw new Error('OCR DocumentTextCatalog is missing or stale');
    }
    if (!catalog) {
        throw new Error('OCR DocumentTextCatalog is missing or stale');
    }
    try {
        if (catalog.header.version === 4) {
            await rebindV4CatalogRevision(
                catalogRoot,
                workingCopyPath,
                expectedRevision,
                nextRevision,
                catalog.header.pageCount,
            );
            return;
        }
        const manifestPath = join(catalogRoot, 'manifest.json');
        const metadata = await readOcrIndexV3ManifestMetadata(manifestPath);
        if (!metadata || metadata.documentRevision.token !== expectedRevision) {
            throw new Error('OCR DocumentTextCatalog is missing or stale');
        }
        if (metadata.pageCount > OCR_V3_COMPATIBILITY_PAGE_LIMIT) {
            const migrated = await migrateOcrIndexV3ToV4({
                catalogRoot,
                sourcePdfPath: workingCopyPath,
                documentRevision: expectedRevision,
            });
            if (migrated === null) {
                throw new Error('OCR DocumentTextCatalog is missing or stale');
            }
            const rebound = await remapOcrCatalogV4({
                catalogRoot,
                delta: {
                    previousPageCount: metadata.pageCount,
                    nextPageCount: metadata.pageCount,
                    ranges: [{
                        kind: 'retain',
                        fromPageNumber: 1,
                        toPageNumber: 1,
                        count: metadata.pageCount,
                    }],
                },
                nextRevision,
                sourcePdfPath: workingCopyPath,
            });
            if (rebound === null) {
                throw new Error('OCR DocumentTextCatalog is missing or stale');
            }
            return;
        }
        const pages: IOcrIndexV3Manifest['pages'] = {};
        const streamedMetadata = await streamOcrIndexV3ManifestMappings(manifestPath, mapping => {
            pages[mapping.pageNumber] = {
                path: mapping.path,
                ...(mapping.generation === undefined ? {} : {generation: mapping.generation}),
            };
        });
        if (
            streamedMetadata === null
            || streamedMetadata.documentRevision.token !== expectedRevision
            || streamedMetadata.pageCount !== metadata.pageCount
        ) {
            throw new Error('OCR DocumentTextCatalog is missing or stale');
        }
        const manifest: IOcrIndexV3Manifest = {
            version: 3,
            documentRevision: {token: nextRevision},
            createdAt: metadata.createdAt,
            source: {pdfPath: workingCopyPath},
            pageCount: metadata.pageCount,
            pageBox: metadata.pageBox,
            ocr: metadata.ocr,
            pages,
        };
        await writeJsonAtomic(manifestPath, manifest);
    } finally {
        await closeOcrCatalog(catalog);
    }
}

function digestCanonicalPage(page: Omit<IDocumentTextCatalogPage, 'contentDigest'>) {
    return createHash('sha256').update(JSON.stringify(page)).digest('hex');
}

async function loadCurrentOcrManifest(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
) {
    const catalogDir = `${workingCopyPath}.ocr`;
    const manifest = await readOcrIndexV3ManifestMetadata(join(catalogDir, 'manifest.json'))
        .catch(() => null);
    return manifest?.documentRevision.token === documentRevision ? manifest : null;
}

async function openCurrentOcrCatalog(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
): Promise<IOcrCatalogHandle | null> {
    return openCatalog(
        `${workingCopyPath}.ocr`,
        {expectedDocumentRevision: documentRevision},
    ).catch(() => null);
}

async function closeOcrCatalog(catalog: IOcrCatalogHandle | null) {
    await catalog?.close?.();
}

async function loadLegacyOcrLanguages(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    catalog: IOcrCatalogHandle | null,
) {
    if (catalog?.header.version !== 3) {
        return undefined;
    }
    const manifest = await loadCurrentOcrManifest(workingCopyPath, documentRevision);
    return manifest ? [...manifest.ocr.languages] : undefined;
}

function createOcrCatalogPage(
    pageNumber: number,
    ocrPage: TOcrPageArtifact,
    languages?: readonly string[],
): IDocumentTextCatalogPage | null {
    if (
        ocrPage.words.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS
        || ocrPage.text.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH
    ) {
        return null;
    }
    const page: IDocumentTextCatalogPage = {
        pageNumber,
        text: ocrPage.words.length > 0
            ? buildOcrTextLayerIndexText(ocrPage.words)
            : assembleSearchablePageText([{text: ocrPage.text}]).text,
        words: ocrPage.words,
        source: 'evb-ocr',
        ...(ocrPage.canonicalText?.generation ? {generation: ocrPage.canonicalText.generation} : {}),
        render: ocrPage.render,
        ...(languages === undefined ? {} : {languages: [...languages]}),
        contentDigest: ocrPage.canonicalText?.contentDigest ?? '',
    };
    page.contentDigest ||= digestCanonicalPage(page);
    return page;
}

type TEmbeddedTextPage = Awaited<ReturnType<typeof extractTextFromPdf>>[number] | IPageTextWithWordBoxes;

function createEmbeddedCatalogPage(embedded: TEmbeddedTextPage): IDocumentTextCatalogPage | null {
    if (!embedded.text.trim()) {
        return null;
    }
    const page: IDocumentTextCatalogPage = {
        pageNumber: embedded.pageNumber,
        text: 'words' in embedded
            ? buildOcrTextLayerIndexText(embedded.words)
            : embedded.text,
        ...('words' in embedded ? {words: embedded.words} : {}),
        source: 'hasInvisibleText' in embedded && embedded.hasInvisibleText
            ? 'foreign-ocr'
            : 'pdf-native',
        contentDigest: '',
    };
    page.contentDigest = digestCanonicalPage(page);
    return page;
}

function asTextOnlyCatalogPage(page: IDocumentTextCatalogPage): IDocumentTextCatalogPage {
    const {
        words: _words,
        ...textOnlyPage
    } = page;
    return textOnlyPage;
}

function appendPageToRanges(
    ranges: IDocumentOcrPageRange[],
    pageNumber: number,
): boolean {
    const lastRange = ranges.at(-1);
    if (lastRange?.lastPage === pageNumber - 1) {
        lastRange.lastPage = pageNumber;
        return true;
    }
    if (ranges.length >= MAX_DOCUMENT_OCR_AVAILABILITY_RANGES) {
        return false;
    }
    ranges.push({
        firstPage: pageNumber,
        lastPage: pageNumber,
    });
    return true;
}

async function resolveCatalogAvailability(catalog: IOcrCatalogHandle): Promise<{
    mappedPageCount: number;
    pageRanges: IDocumentOcrPageRange[];
    rangesComplete: boolean;
}> {
    const {
        pageCount,
        mappedPageCount,
        version,
        complete,
    } = catalog.header;
    if (pageCount === 0 || mappedPageCount === 0) {
        return {
            mappedPageCount,
            pageRanges: [],
            rangesComplete: true,
        };
    }
    if (version === 4 && complete) {
        return {
            mappedPageCount,
            pageRanges: [{
                firstPage: 1,
                lastPage: pageCount,
            }],
            rangesComplete: true,
        };
    }

    const pageRanges: IDocumentOcrPageRange[] = [];
    let rangesComplete = true;
    for (let firstPage = 1; firstPage <= pageCount; firstPage += OCR_MAX_WINDOW_PAGES) {
        const count = Math.min(OCR_MAX_WINDOW_PAGES, pageCount - firstPage + 1);
        const availability = await catalog.windowAvailability(firstPage, count);
        for (let index = 0; index < availability.length; index += 1) {
            if (availability[index] === 0) {
                continue;
            }
            if (!appendPageToRanges(pageRanges, firstPage + index)) {
                rangesComplete = false;
                break;
            }
        }
        if (!rangesComplete) {
            break;
        }
    }
    return {
        mappedPageCount,
        pageRanges,
        rangesComplete,
    };
}

export async function resolveDocumentOcrAvailability(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
): Promise<IDocumentOcrAvailability> {
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    if (!catalog) {
        return {
            documentRevision,
            pageCount: 0,
            mappedPageCount: 0,
            pageRanges: [],
            rangesComplete: true,
        };
    }
    try {
        const availability = await resolveCatalogAvailability(catalog);
        return {
            documentRevision,
            pageCount: catalog.header.pageCount,
            ...availability,
        };
    } finally {
        await closeOcrCatalog(catalog);
    }
}

export async function resolveDocumentOcrPage(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageNumber: number,
): Promise<IDocumentOcrPageSnapshot> {
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    if (!catalog) {
        return {
            documentRevision,
            pageCount: 0,
            page: null,
        };
    }
    try {
        const languages = await loadLegacyOcrLanguages(workingCopyPath, documentRevision, catalog);
        const page = Number.isSafeInteger(pageNumber)
            && pageNumber >= 1
            && pageNumber <= catalog.header.pageCount
            ? await catalog.readPage(pageNumber)
            : null;
        return {
            documentRevision,
            pageCount: catalog.header.pageCount,
            page: page === null
                ? null
                : createOcrCatalogPage(pageNumber, page, languages),
        };
    } catch {
        return {
            documentRevision,
            pageCount: catalog.header.pageCount,
            page: null,
        };
    } finally {
        await closeOcrCatalog(catalog);
    }
}

/**
 * Visits OCR sidecar pages without repeatedly parsing the manifest or creating
 * one all-document payload. This is the bounded internal projection used by
 * search indexing; renderer IPC remains page-scoped through resolveDocumentOcrPage.
 */
export async function visitDocumentOcrCatalogPages(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    options: IVisitDocumentOcrCatalogOptions,
) {
    throwIfAborted(options.signal);
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    if (!catalog) {
        return {
            pageCount: 0,
            visitedPages: 0,
        };
    }

    try {
        const languages = await loadLegacyOcrLanguages(workingCopyPath, documentRevision, catalog);
        let visitedPages = 0;
        for await (const {
            pageNumber,
            artifact,
        } of catalog.iterateMappedPages()) {
            throwIfAborted(options.signal);
            const page = createOcrCatalogPage(pageNumber, artifact, languages);
            if (!page) {
                continue;
            }
            options.onPage(page);
            visitedPages += 1;
        }
        return {
            pageCount: catalog.header.pageCount,
            visitedPages,
        };
    } finally {
        await closeOcrCatalog(catalog);
    }
}

/**
 * Visits canonical text pages in bounded PDF windows. Each window is released
 * before the next one starts, so desktop exports do not build an all-document
 * page array or apply the snapshot aggregate text budget.
 */
async function visitDocumentTextCatalogPages(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    options: IVisitDocumentTextCatalogPagesOptions,
) {
    throwIfAborted(options.signal);
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    const catalogPageCount = catalog?.header.pageCount;
    const resolvedPageCount = options.pageCount ?? catalogPageCount;
    if (!resolvedPageCount || !Number.isSafeInteger(resolvedPageCount) || resolvedPageCount < 1) {
        await closeOcrCatalog(catalog);
        throw new Error('Document text catalog window traversal requires a positive page count');
    }
    if (catalogPageCount !== undefined && resolvedPageCount > catalogPageCount) {
        await closeOcrCatalog(catalog);
        throw new RangeError('Document text catalog page count exceeds the OCR catalog page count');
    }
    const firstPage = options.firstPage ?? 1;
    const lastPage = options.lastPage ?? resolvedPageCount;
    const pageWindow = options.pageWindow ?? DOCUMENT_TEXT_EXPORT_PAGE_WINDOW;
    if (
        !Number.isSafeInteger(firstPage)
        || firstPage < 1
        || !Number.isSafeInteger(lastPage)
        || lastPage < firstPage
        || lastPage > resolvedPageCount
        || lastPage - firstPage + 1 > DOCUMENT_TEXT_EXPORT_PAGE_WINDOW
        || !Number.isSafeInteger(pageWindow)
        || pageWindow < 1
        || pageWindow > DOCUMENT_TEXT_EXPORT_PAGE_WINDOW
    ) {
        await closeOcrCatalog(catalog);
        throw new RangeError('Invalid document text catalog window');
    }

    try {
        const languages = await loadLegacyOcrLanguages(workingCopyPath, documentRevision, catalog);
        let visitedPages = 0;
        for (let windowFirst = firstPage; windowFirst <= lastPage; windowFirst += pageWindow) {
            throwIfAborted(options.signal);
            const windowLast = Math.min(lastPage, windowFirst + pageWindow - 1);
            const embeddedPages = await extractTextFromPdf(options.sourcePdfPath ?? workingCopyPath, {
                pageCount: resolvedPageCount,
                pages: Array.from(
                    {length: windowLast - windowFirst + 1},
                    (_value, index) => windowFirst + index,
                ),
                ...(options.signal === undefined ? {} : {signal: options.signal}),
            });
            const canonicalByPage = new Map<number, IDocumentTextCatalogPage>();
            for (const embedded of embeddedPages) {
                const page = createEmbeddedCatalogPage(embedded);
                if (
                    page
                    && page.pageNumber >= windowFirst
                    && page.pageNumber <= windowLast
                ) {
                    canonicalByPage.set(page.pageNumber, page);
                }
            }

            if (catalog) {
                const ocrPages = await catalog.readWindow(
                    windowFirst,
                    windowLast - windowFirst + 1,
                );
                for (const {
                    pageNumber,
                    artifact,
                } of ocrPages) {
                    if (!artifact) {
                        continue;
                    }
                    const page = createOcrCatalogPage(pageNumber, artifact, languages);
                    if (page) {
                        canonicalByPage.set(pageNumber, asTextOnlyCatalogPage(page));
                    }
                }
            }

            const pages = Array.from(canonicalByPage.values())
                .sort((left, right) => left.pageNumber - right.pageNumber);
            let windowTextLength = 0;
            for (const page of pages) {
                windowTextLength += page.text.length;
                if (windowTextLength > MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH) {
                    throw new RangeError('Document text catalog window exceeds its bounded text budget');
                }
                throwIfAborted(options.signal);
                await options.onPage(page);
                visitedPages += 1;
            }
        }
        return {
            documentRevision,
            pageCount: resolvedPageCount,
            firstPage,
            lastPage,
            visitedPages,
        };
    } finally {
        await closeOcrCatalog(catalog);
    }
}

export async function resolveDocumentTextCatalogWindow(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    firstPage: number,
    lastPage: number,
    pageCount?: number,
    options: IResolveDocumentTextCatalogOptions = {},
): Promise<IDocumentTextCatalogWindow> {
    const pages: IDocumentTextCatalogPage[] = [];
    const result = await visitDocumentTextCatalogPages(
        workingCopyPath,
        documentRevision,
        {
            firstPage,
            lastPage,
            ...(pageCount === undefined ? {} : {pageCount}),
            ...(options.pageWindow === undefined ? {} : {pageWindow: options.pageWindow}),
            ...(options.sourcePdfPath === undefined ? {} : {sourcePdfPath: options.sourcePdfPath}),
            ...(options.signal === undefined ? {} : {signal: options.signal}),
            onPage: page => {
                pages.push(page);
            },
        },
    );
    return {
        documentRevision,
        pageCount: result.pageCount,
        firstPage: result.firstPage,
        lastPage: result.lastPage,
        pages,
        contentDigest: createHash('sha256').update(JSON.stringify(
            pages.map(page => [
                page.pageNumber,
                page.contentDigest,
            ]),
        )).digest('hex'),
    };
}

/** Main-process canonical per-page text authority for viewer/search/export projections. */
export async function resolveDocumentTextCatalogSnapshot(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount?: number,
    options: IResolveDocumentTextCatalogOptions = {},
): Promise<IDocumentTextSnapshot> {
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    const catalogPageCount = catalog?.header.pageCount;
    if (catalogPageCount !== undefined && catalogPageCount > OCR_SCALAR_PAGE_LIMIT) {
        await closeOcrCatalog(catalog);
        throw new OcrCatalogTooLargeError(catalogPageCount);
    }
    if (pageCount !== undefined && pageCount > OCR_SCALAR_PAGE_LIMIT) {
        await closeOcrCatalog(catalog);
        throw new OcrCatalogTooLargeError(pageCount);
    }
    if (catalogPageCount === undefined && pageCount === undefined) {
        await closeOcrCatalog(catalog);
        throw new RangeError('Document text catalog snapshot requires a bounded page count');
    }
    const sourcePdfPath = options.sourcePdfPath ?? workingCopyPath;
    try {
        const shouldUseBoundedTextOnlyExtraction = Boolean(
            pageCount && pageCount > DOCUMENT_TEXT_EXPORT_PDFJS_MAX_PAGES,
        ) || await stat(sourcePdfPath).then(
            fileStat => fileStat.size > DOCUMENT_TEXT_EXPORT_PDFJS_MAX_BYTES,
            () => false,
        );
        const embeddedPages: Array<
            Awaited<ReturnType<typeof extractTextFromPdf>>[number]
            | IPageTextWithWordBoxes
        > = [];
        if (!shouldUseBoundedTextOnlyExtraction) {
            const {extractTextWithPdfjsWordBoxes} = await loadPdfjsTextExtractor();
            embeddedPages.push(...await extractTextWithPdfjsWordBoxes(sourcePdfPath));
        } else if (pageCount) {
            for (let firstPage = 1; firstPage <= pageCount; firstPage += DOCUMENT_TEXT_EXPORT_PAGE_WINDOW) {
                const lastPage = Math.min(pageCount, firstPage + DOCUMENT_TEXT_EXPORT_PAGE_WINDOW - 1);
                embeddedPages.push(...await extractTextFromPdf(sourcePdfPath, {
                    pageCount,
                    pages: Array.from({length: lastPage - firstPage + 1}, (_, index) => firstPage + index),
                }));
            }
        } else {
            embeddedPages.push(...await extractTextFromPdf(sourcePdfPath));
        }
        const languages = await loadLegacyOcrLanguages(workingCopyPath, documentRevision, catalog);
        const resolvedPageCount = pageCount ?? Math.max(embeddedPages.length, catalogPageCount ?? 0);
        const canonicalByPage = new Map<number, IDocumentTextCatalogPage>();

        for (const embedded of embeddedPages) {
            if (embedded.pageNumber > resolvedPageCount || !embedded.text.trim()) {
                continue;
            }
            const page = createEmbeddedCatalogPage(embedded);
            if (page) {
                canonicalByPage.set(page.pageNumber, page);
            }
        }

        if (catalog) {
            const snapshot = await catalog.readSnapshot();
            for (const {
                pageNumber,
                artifact,
            } of snapshot.pages) {
                const page = createOcrCatalogPage(pageNumber, artifact, languages);
                if (page) {
                    canonicalByPage.set(pageNumber, asTextOnlyCatalogPage(page));
                }
            }
        }

        const pages = Array.from(canonicalByPage.values()).sort((left, right) => left.pageNumber - right.pageNumber);
        let totalTextLength = 0;
        for (const page of pages) {
            totalTextLength += page.text.length;
            if (totalTextLength > MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH) {
                throw new RangeError('Document text export exceeds the 8 MiB aggregate text budget');
            }
        }
        return {
            documentRevision,
            pageCount: resolvedPageCount,
            pages,
            contentDigest: createHash('sha256').update(JSON.stringify(
                pages.map(page => [
                    page.pageNumber,
                    page.contentDigest,
                ]),
            )).digest('hex'),
        };
    } finally {
        await closeOcrCatalog(catalog);
    }
}
