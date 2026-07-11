import {createHash} from 'node:crypto';
import type {
    IOcrIndexV3Manifest,
    IOcrIndexV3Page,
} from '@contracts/ocrIndex';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

export const MIXED_OCR_CORPUS_PATH = '/tmp/evb-mixed-ocr-corpus.pdf';
export const MIXED_OCR_CORPUS_REVISION = requireDocumentRevisionToken('mixed-ocr-corpus-r1');

export const mixedEmbeddedTextPages = [
    {
        pageNumber: 1,
        text: 'visible native source',
        words: [],
        hasInvisibleText: false,
    },
    // Page 2 deliberately has no embedded text: it represents a scanned page.
    {
        pageNumber: 3,
        text: 'third party hidden text',
        words: [],
        hasInvisibleText: true,
    },
] as const;

const evbText = 'EVB generated text generation two';
export const mixedEvbPage: IOcrIndexV3Page = {
    pageNumber: 4,
    documentRevision: {token: MIXED_OCR_CORPUS_REVISION},
    rotation: 0,
    render: {
        dpi: 300,
        imagePx: {
            w: 1200,
            h: 1600,
        },
    },
    text: evbText,
    words: [],
    canonicalText: {
        source: 'evb-ocr',
        generation: 'generation-2',
        contentDigest: createHash('sha256').update(evbText).digest('hex'),
    },
};

export const mixedOcrManifest: IOcrIndexV3Manifest = {
    version: 3,
    documentRevision: {token: MIXED_OCR_CORPUS_REVISION},
    createdAt: 1,
    source: {pdfPath: MIXED_OCR_CORPUS_PATH},
    pageCount: 4,
    pageBox: 'crop',
    ocr: {
        engine: 'tesseract',
        languages: ['eng'],
        renderDpi: 300,
    },
    pages: {4: {path: 'page-0004.json'}},
};

export const mixedOcrCorpusExpectedSources = [
    {
        pageNumber: 1,
        source: 'pdf-native',
    },
    {
        pageNumber: 3,
        source: 'foreign-ocr',
    },
    {
        pageNumber: 4,
        source: 'evb-ocr',
    },
] as const;
