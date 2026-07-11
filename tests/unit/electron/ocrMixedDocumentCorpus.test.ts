import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    MIXED_OCR_CORPUS_PATH,
    MIXED_OCR_CORPUS_REVISION,
    mixedEmbeddedTextPages,
    mixedEvbPage,
    mixedOcrCorpusExpectedSources,
    mixedOcrManifest,
} from '@tests/fixtures/ocr/mixedDocumentCorpus';

vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(async (path: string) => {
        if (path.endsWith('manifest.json')) {
            return JSON.stringify(mixedOcrManifest);
        }
        if (path.endsWith('page-0004.json')) {
            return JSON.stringify(mixedEvbPage);
        }
        throw new Error('ENOENT');
    }),
    rename: vi.fn(),
    writeFile: vi.fn(),
}));
vi.mock('@electron/search/extractTextWithPdfjs', () => ({extractTextWithPdfjsWordBoxes: vi.fn(async () => mixedEmbeddedTextPages)}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: vi.fn(async () => undefined)}));

const {resolveDocumentTextCatalogSnapshot} = await import('@electron/ocr/documentTextCatalog');

describe('mixed native/scanned/foreign/EVB OCR corpus', () => {
    it('selects exactly one canonical source per text-bearing page', async () => {
        const snapshot = await resolveDocumentTextCatalogSnapshot(
            MIXED_OCR_CORPUS_PATH,
            MIXED_OCR_CORPUS_REVISION,
            4,
        );

        expect(snapshot.pageCount).toBe(4);
        expect(snapshot.pages.map(page => ({
            pageNumber: page.pageNumber,
            source: page.source,
        })))
            .toEqual(mixedOcrCorpusExpectedSources);
        expect(snapshot.pages.find(page => page.pageNumber === 2)).toBeUndefined();
        expect(snapshot.pages.find(page => page.pageNumber === 4)).toMatchObject({
            generation: 'generation-2',
            text: mixedEvbPage.text,
        });
    });
});
