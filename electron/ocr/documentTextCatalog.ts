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
    IDocumentTextCatalogPage,
    IDocumentTextSnapshot,
} from '@contracts/documentTextCatalog';
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

/** Main-process canonical per-page text authority for viewer/search/export projections. */
export async function resolveDocumentTextCatalogSnapshot(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount?: number,
): Promise<IDocumentTextSnapshot> {
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const embeddedPages = await extractTextWithPdfjsWordBoxes(workingCopyPath);
    const catalogDir = `${workingCopyPath}.ocr`;
    const manifest = await readFile(join(catalogDir, 'manifest.json'), 'utf8')
        .then(raw => parseOcrIndexV3Manifest(JSON.parse(raw), 'strict'))
        .catch(() => null);
    const currentManifest = manifest?.documentRevision.token === documentRevision ? manifest : null;
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
        for (const [
            rawPageNumber,
            mapping,
        ] of Object.entries(currentManifest.pages)) {
            const pageNumber = Number(rawPageNumber);
            if (pageNumber > resolvedPageCount) {
                continue;
            }
            const ocrPage = await readFile(join(catalogDir, mapping.path), 'utf8')
                .then(raw => decodeOcrPage(JSON.parse(raw), pageNumber, documentRevision, 'strict'))
                .catch(() => null);
            if (!ocrPage) {
                continue;
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
                languages: [...currentManifest.ocr.languages],
                contentDigest: ocrPage.canonicalText?.contentDigest ?? '',
            };
            page.contentDigest ||= digestCanonicalPage(page);
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
