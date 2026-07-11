import { createHash } from 'node:crypto';
import type {
    IOcrIndexV3Manifest,
    IOcrIndexV3Page,
} from '@contracts/ocrIndex';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';

export const OCR_CATALOG_FIXTURE_PATH = '/tmp/evb-ocr-catalog-agreement.pdf';
export const OCR_CATALOG_FIXTURE_REVISION = requireDocumentRevisionToken('ocr-catalog-agreement-r1');

export interface IOcrCatalogFixturePage {
    pageNumber: number;
    text: string;
}

export function createOcrDocumentTextCatalogFixture(
    pages: readonly IOcrCatalogFixturePage[],
    options: {revision?: string} = {},
) {
    const revision = requireDocumentRevisionToken(options.revision ?? OCR_CATALOG_FIXTURE_REVISION);
    const manifestPages: IOcrIndexV3Manifest['pages'] = {};
    const artifacts = new Map<string, unknown>();

    for (const page of pages) {
        const path = `page-${String(page.pageNumber).padStart(4, '0')}.json`;
        manifestPages[page.pageNumber] = {path};
        const pageArtifact: IOcrIndexV3Page = {
            pageNumber: page.pageNumber,
            documentRevision: {token: revision},
            rotation: 0,
            render: {
                dpi: 300,
                imagePx: {
                    w: 1200,
                    h: 1600,
                },
            },
            text: page.text,
            words: page.text.split(/\s+/u).filter(Boolean).map((text, index) => ({
                text,
                x: 20 + index * 80,
                y: 30,
                width: 70,
                height: 24,
            })),
            canonicalText: {
                source: 'evb-ocr',
                generation: 'fixture-generation',
                contentDigest: createHash('sha256').update(page.text).digest('hex'),
            },
        };
        artifacts.set(path, pageArtifact);
    }

    const manifest: IOcrIndexV3Manifest = {
        version: 3,
        documentRevision: {token: revision},
        createdAt: 1,
        source: {pdfPath: OCR_CATALOG_FIXTURE_PATH},
        pageCount: Math.max(1, ...pages.map(page => page.pageNumber)),
        pageBox: 'crop',
        ocr: {
            engine: 'tesseract',
            languages: ['eng'],
            renderDpi: 300,
        },
        pages: manifestPages,
    };
    artifacts.set('manifest.json', manifest);

    return {
        artifacts,
        manifest,
        path: OCR_CATALOG_FIXTURE_PATH,
        revision,
    };
}
