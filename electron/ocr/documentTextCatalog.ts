import {
    readFile,
    rename,
    writeFile,
} from 'node:fs/promises';
import {
    randomUUID,
    createHash,
} from 'node:crypto';
import { join } from 'node:path';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    decodeOcrPage,
    parseOcrIndexV3Manifest,
} from '@contracts/ocrIndex';
import type {
    IDocumentOcrAvailability,
    IDocumentOcrPageSnapshot,
    IDocumentTextCatalogPage,
    IDocumentTextSnapshot,
} from '@contracts/documentTextCatalog';
import {
    MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH,
    MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS,
} from '@contracts/documentTextCatalog';
import type { IOcrIndexV3Manifest } from '@contracts/ocrIndex';
import {assembleSearchablePageText} from '@contracts/search';
import {buildOcrTextLayerIndexText} from '@contracts/ocrText';
import {extractTextWithPdfjsWordBoxes} from '@electron/search/extractTextWithPdfjs';
import {assertWorkingCopyRevisionSidecarCurrent} from '@electron/file-access/documentRevisionSidecar';

function temporaryPath(path: string) {
    return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

async function writeJsonAtomic(path: string, value: unknown) {
    const tempPath = temporaryPath(path);
    await writeFile(tempPath, JSON.stringify(value), 'utf8');
    await rename(tempPath, path);
}

/** Re-keys the canonical text catalog during the OCR PDF revision transition. */
export async function rebindDocumentTextCatalogRevision(
    workingCopyPath: string,
    expectedRevision: TDocumentRevisionToken,
    nextRevision: TDocumentRevisionToken,
) {
    const catalogDir = `${workingCopyPath}.ocr`;
    const manifestPath = join(catalogDir, 'manifest.json');
    const manifest = parseOcrIndexV3Manifest(JSON.parse(await readFile(manifestPath, 'utf8')), 'strict');
    if (!manifest || manifest.documentRevision.token !== expectedRevision) {
        throw new Error('OCR DocumentTextCatalog is missing or stale');
    }

    for (const [
        rawPageNumber,
        mapping,
    ] of Object.entries(manifest.pages)) {
        const pageNumber = Number(rawPageNumber);
        const pagePath = join(catalogDir, mapping.path);
        const page = decodeOcrPage(JSON.parse(await readFile(pagePath, 'utf8')), pageNumber, expectedRevision, 'strict');
        if (!page) {
            throw new Error(`OCR DocumentTextCatalog page ${pageNumber} is invalid`);
        }
        await writeJsonAtomic(pagePath, {
            ...page,
            documentRevision: {token: nextRevision},
        });
    }

    await writeJsonAtomic(manifestPath, {
        ...manifest,
        documentRevision: {token: nextRevision},
        source: {pdfPath: workingCopyPath},
    });
}

function digestCanonicalPage(page: Omit<IDocumentTextCatalogPage, 'contentDigest'>) {
    return createHash('sha256').update(JSON.stringify(page)).digest('hex');
}

async function loadCurrentOcrManifest(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
) {
    const catalogDir = `${workingCopyPath}.ocr`;
    const manifest = await readFile(join(catalogDir, 'manifest.json'), 'utf8')
        .then(raw => parseOcrIndexV3Manifest(JSON.parse(raw), 'strict'))
        .catch(() => null);
    return manifest?.documentRevision.token === documentRevision ? manifest : null;
}

async function loadEvbOcrCatalogPage(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    manifest: IOcrIndexV3Manifest,
    pageNumber: number,
): Promise<IDocumentTextCatalogPage | null> {
    const mapping = manifest.pages[pageNumber];
    if (!mapping) {
        return null;
    }
    const ocrPage = await readFile(join(`${workingCopyPath}.ocr`, mapping.path), 'utf8')
        .then(raw => decodeOcrPage(JSON.parse(raw), pageNumber, documentRevision, 'strict'))
        .catch(() => null);
    if (!ocrPage) {
        return null;
    }
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
        languages: [...manifest.ocr.languages],
        contentDigest: ocrPage.canonicalText?.contentDigest ?? '',
    };
    page.contentDigest ||= digestCanonicalPage(page);
    return page;
}

export async function resolveDocumentOcrAvailability(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
): Promise<IDocumentOcrAvailability> {
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const manifest = await loadCurrentOcrManifest(workingCopyPath, documentRevision);
    return {
        documentRevision,
        pageCount: manifest?.pageCount ?? 0,
        pageNumbers: manifest
            ? Object.keys(manifest.pages).map(Number).sort((left, right) => left - right)
            : [],
    };
}

export async function resolveDocumentOcrPage(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageNumber: number,
): Promise<IDocumentOcrPageSnapshot> {
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const manifest = await loadCurrentOcrManifest(workingCopyPath, documentRevision);
    return {
        documentRevision,
        pageCount: manifest?.pageCount ?? 0,
        page: manifest && pageNumber <= manifest.pageCount
            ? await loadEvbOcrCatalogPage(workingCopyPath, documentRevision, manifest, pageNumber)
            : null,
    };
}

/** Main-process canonical per-page text authority for viewer/search/export projections. */
export async function resolveDocumentTextCatalogSnapshot(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount?: number,
): Promise<IDocumentTextSnapshot> {
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const embeddedPages = await extractTextWithPdfjsWordBoxes(workingCopyPath);
    const currentManifest = await loadCurrentOcrManifest(workingCopyPath, documentRevision);
    const resolvedPageCount = pageCount ?? Math.max(embeddedPages.length, currentManifest?.pageCount ?? 0);
    const canonicalByPage = new Map<number, IDocumentTextCatalogPage>();

    for (const embedded of embeddedPages) {
        if (embedded.pageNumber > resolvedPageCount || !embedded.text.trim()) {
            continue;
        }
        const page: IDocumentTextCatalogPage = {
            pageNumber: embedded.pageNumber,
            text: buildOcrTextLayerIndexText(embedded.words),
            words: embedded.words,
            source: embedded.hasInvisibleText ? 'foreign-ocr' : 'pdf-native',
            contentDigest: '',
        };
        page.contentDigest = digestCanonicalPage(page);
        canonicalByPage.set(page.pageNumber, page);
    }

    if (currentManifest) {
        for (const [rawPageNumber] of Object.entries(currentManifest.pages)) {
            const pageNumber = Number(rawPageNumber);
            if (pageNumber > resolvedPageCount) {
                continue;
            }
            const page = await loadEvbOcrCatalogPage(
                workingCopyPath,
                documentRevision,
                currentManifest,
                pageNumber,
            );
            if (!page) {
                continue;
            }
            canonicalByPage.set(pageNumber, page);
        }
    }

    const pages = Array.from(canonicalByPage.values()).sort((left, right) => left.pageNumber - right.pageNumber);
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
}
