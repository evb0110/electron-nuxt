import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeOcrPage,
    parseOcrIndexV3Manifest,
} from '@contracts/ocrIndex';
import {requireDocumentRevisionToken} from '@contracts';

const revision = requireDocumentRevisionToken('drt1:test');

function createPage(overrides: Record<string, unknown> = {}) {
    return {
        pageNumber: 1,
        documentRevision: {token: revision},
        rotation: 0,
        render: {
            dpi: 300,
            imagePx: {
                w: 1200,
                h: 1600,
            },
        },
        text: 'hello',
        words: [],
        ...overrides,
    };
}

describe('OCR index codecs', () => {
    it('reconstructs a strict manifest and rejects malformed page mappings', () => {
        const manifest = {
            version: 3,
            documentRevision: {token: revision},
            createdAt: 1,
            source: {pdfPath: '/tmp/work.pdf'},
            pageCount: 1,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {1: {path: 'page-1.json'}},
        };

        expect(parseOcrIndexV3Manifest(manifest)).toEqual(manifest);
        expect(parseOcrIndexV3Manifest({
            ...manifest,
            pages: {'1junk': {path: 'page-1.json'}},
        })).toBeNull();
    });

    it('repairs a legacy missing page number contextually without accepting mismatches', () => {
        const {
            pageNumber: _pageNumber,
            ...legacyPage
        } = createPage();

        expect(decodeOcrPage(legacyPage, 1, revision, 'strict')).toBeNull();
        expect(decodeOcrPage(legacyPage, 1, revision, 'repair-legacy')).toMatchObject({
            pageNumber: 1,
            text: 'hello',
        });
        expect(decodeOcrPage(createPage({pageNumber: 2}), 1, revision, 'repair-legacy')).toBeNull();
    });

    it('rejects stale revisions and malformed OCR words', () => {
        expect(decodeOcrPage(createPage({documentRevision: {token: requireDocumentRevisionToken('stale')}}), 1, revision)).toBeNull();
        expect(decodeOcrPage(createPage({words: [{text: 'bad'}]}), 1, revision)).toBeNull();
    });

    it('rejects zero-sized geometry and zero DPI in strict mode', () => {
        expect(decodeOcrPage(createPage({render: {
            dpi: 300,
            imagePx: {
                w: 0,
                h: 1600,
            },
        }}), 1, revision)).toBeNull();
        expect(decodeOcrPage(createPage({render: {
            dpi: 0,
            imagePx: {
                w: 1200,
                h: 1600,
            },
        }}), 1, revision)).toBeNull();
    });
});
