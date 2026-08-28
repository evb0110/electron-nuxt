import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import type {TOcrPageArtifact} from '@contracts/ocrIndex';

const state = vi.hoisted(() => {
    const page: TOcrPageArtifact = {
        rotation: 0,
        render: {
            dpi: 300,
            imagePx: {
                w: 1200,
                h: 1600,
            },
        },
        text: 'sparse page',
        words: [],
    };
    const handle = {
        header: {
            version: 4 as const,
            catalogId: '123e4567-e89b-42d3-a456-426614174000',
            source: {pdfPath: '/tmp/large.pdf'},
            documentRevision: {token: 'drt1:v4-consumer'},
            pageCount: 1_000_001,
            generation: 7,
            mappedPageCount: 1,
            complete: false,
        },
        readPage: vi.fn(async (pageNumber: number) => pageNumber === 900_000 ? page : null),
        readWindow: vi.fn(async (start: number, count: number) => Array.from(
            {length: count},
            (_value, index) => ({
                pageNumber: start + index,
                artifact: start + index === 900_000 ? page : null,
            }),
        )),
        readWindowMappings: vi.fn(async (start: number, count: number) => Array.from(
            {length: count},
            (_value, index) => ({
                pageNumber: start + index,
                mapping: null,
            }),
        )),
        windowAvailability: vi.fn(async (start: number, count: number) => {
            const value = new Uint8Array(count);
            if (900_000 >= start && 900_000 < start + count) {
                value[900_000 - start] = 1;
            }
            return value;
        }),
        iterateMappedPages: vi.fn(async function* () {
            yield {
                pageNumber: 900_000,
                artifact: page,
            };
        }),
        findFirstUnmapped: vi.fn(async () => 1),
        readSnapshot: vi.fn(async () => ({
            header: handle.header,
            pages: [],
        })),
        close: vi.fn(async () => undefined),
    };
    const openCatalog = vi.fn<() => Promise<typeof handle | null>>(async () => handle);
    return {
        handle,
        openCatalog,
        extractTextFromPdf: vi.fn(async () => []),
        extractTextWithPdfjsWordBoxes: vi.fn(async () => []),
        assertWorkingCopyRevisionSidecarCurrent: vi.fn(async () => undefined),
    };
});

vi.mock('@electron/ocr/ocrCatalogV4', async () => {
    const actual = await vi.importActual('@electron/ocr/ocrCatalogV4') as Record<string, unknown>;
    return {
        ...actual,
        openCatalog: state.openCatalog,
    };
});
vi.mock('@electron/search/extractTextFromPdf', () => ({extractTextFromPdf: state.extractTextFromPdf}));
vi.mock('@electron/search/loadPdfjsTextExtractor', () => ({loadPdfjsTextExtractor: async () => ({extractTextWithPdfjsWordBoxes: state.extractTextWithPdfjsWordBoxes})}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: state.assertWorkingCopyRevisionSidecarCurrent}));

const {
    resolveDocumentOcrAvailability,
    resolveDocumentOcrPage,
    resolveDocumentTextCatalogSnapshot,
    resolveDocumentTextCatalogWindow,
} = await import('@electron/ocr/documentTextCatalog');

const DOCUMENT_REVISION = requireDocumentRevisionToken('drt1:v4-consumer');

describe('DocumentTextCatalog v4 consumers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps million-page sparse availability range-based and bounded', async () => {
        const availability = await resolveDocumentOcrAvailability('/tmp/large.pdf', DOCUMENT_REVISION);

        expect(availability).toEqual({
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1_000_001,
            mappedPageCount: 1,
            pageRanges: [{
                firstPage: 900_000,
                lastPage: 900_000,
            }],
            rangesComplete: true,
        });
        expect('pageNumbers' in availability).toBe(false);
        expect(state.handle.windowAvailability).toHaveBeenCalled();
        expect(state.handle.windowAvailability.mock.calls.every(([
            _start,
            count,
        ]) => count <= 256)).toBe(true);
    });

    it('addresses one v4 page and one v4 window without a snapshot', async () => {
        await expect(resolveDocumentOcrPage('/tmp/large.pdf', DOCUMENT_REVISION, 900_000))
            .resolves.toMatchObject({
                pageCount: 1_000_001,
                page: {
                    pageNumber: 900_000,
                    source: 'evb-ocr',
                    text: 'sparse page',
                },
            });
        await expect(resolveDocumentTextCatalogWindow(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            900_000,
            900_000,
            1_000_001,
        )).resolves.toMatchObject({
            pageCount: 1_000_001,
            pages: [{
                pageNumber: 900_000,
                source: 'evb-ocr',
            }],
        });
        expect(state.handle.readPage).toHaveBeenCalledWith(900_000);
        expect(state.handle.readWindow).toHaveBeenCalledWith(900_000, 1);
        expect(state.handle.readSnapshot).not.toHaveBeenCalled();
    });

    it('rejects an oversized text window before traversing an xlarge catalog', async () => {
        await expect(resolveDocumentTextCatalogWindow(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            1,
            65,
            1_000_001,
        )).rejects.toThrow('Invalid document text catalog window');
        expect(state.handle.readWindow).not.toHaveBeenCalled();
        expect(state.extractTextFromPdf).not.toHaveBeenCalled();
    });

    it('rejects a whole-document snapshot before allocating xlarge PDF text', async () => {
        await expect(resolveDocumentTextCatalogSnapshot(
            '/tmp/large.pdf',
            DOCUMENT_REVISION,
            1_000_001,
        )).rejects.toMatchObject({
            code: 'OCR_CATALOG_TOO_LARGE',
            pageCount: 1_000_001,
        });
        expect(state.extractTextFromPdf).not.toHaveBeenCalled();
        expect(state.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
        expect(state.handle.readSnapshot).not.toHaveBeenCalled();
    });

    it('rejects an unbounded snapshot when no catalog supplies a page count', async () => {
        state.openCatalog.mockResolvedValueOnce(null);

        await expect(resolveDocumentTextCatalogSnapshot(
            '/tmp/unknown.pdf',
            DOCUMENT_REVISION,
        )).rejects.toThrow('requires a bounded page count');
        expect(state.extractTextFromPdf).not.toHaveBeenCalled();
        expect(state.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
    });
});

describe('DocumentTextCatalog availability validation (SRCH-004)', () => {
    it('does not trust a complete header over per-page artifact availability', async () => {
        const header = state.handle.header;
        const originalMappedPageCount = header.mappedPageCount;
        header.complete = true;
        header.mappedPageCount = header.pageCount;
        try {
            const availability = await resolveDocumentOcrAvailability('/tmp/large.pdf', DOCUMENT_REVISION);

            expect(availability).toEqual({
                documentRevision: DOCUMENT_REVISION,
                pageCount: 1_000_001,
                mappedPageCount: 1,
                pageRanges: [{
                    firstPage: 900_000,
                    lastPage: 900_000,
                }],
                rangesComplete: true,
            });
            expect(state.handle.windowAvailability).toHaveBeenCalled();
        } finally {
            header.complete = false;
            header.mappedPageCount = originalMappedPageCount;
        }
    });
});
