import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {requireDocumentRevisionToken} from '@contracts';
import type {IDocxExportFileCapability} from '@contracts/docxExport';
import type {TDocxTextPageSource} from '@app/utils/docxStreaming';

type TDocxChunkBuilder = (
    pages: TDocxTextPageSource,
    isRtl?: boolean,
) => AsyncIterable<Uint8Array>;

const trackMock = vi.hoisted(() => vi.fn());
const toastAddMock = vi.hoisted(() => vi.fn());
const createDocxFromTextAsyncMock = vi.hoisted(() => vi.fn(async () => new Uint8Array([
    1,
    2,
    3,
])));
const createDocxFromTextChunksMock = vi.hoisted(() => vi.fn<TDocxChunkBuilder>(() => (async function* () {
    yield new Uint8Array([
        4,
        5,
        6,
    ]);
})()));
const loadDocumentTextCatalogPagesMock = vi.hoisted(() => vi.fn<() => Promise<Array<{
    pageNumber: number;
    text: string;
}> | null>>(async () => null));
const documentFilesMock = vi.hoisted(() => ({
    saveDocxAs: vi.fn(async () => '/tmp/export.docx'),
    writeDocxFile: vi.fn(async () => {}),
    writeDocxFileChunks: vi.fn<IDocxExportFileCapability['writeDocxFileChunks']>(async () => true),
}));
const documentWorkingCopyMock = vi.hoisted(() => ({cleanupFile: vi.fn(async () => {})}));
const TEST_DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');
interface IActualDocxStreamingModule {
    createDocxFromTextChunks: (
        pages: Iterable<string> | AsyncIterable<string>,
        isRtl?: boolean,
    ) => AsyncIterable<Uint8Array>;
    DOCX_STREAM_CHUNK_BYTES: number;
}

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => documentFilesMock,
    getDocumentWorkingCopyCapability: () => documentWorkingCopyMock,
}));
vi.mock('@app/composables/useAnalytics', () => ({useAnalytics: () => ({track: trackMock})}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));
vi.mock('@app/utils/ocr/loadOcrText', () => ({loadDocumentTextCatalogPages: loadDocumentTextCatalogPagesMock}));
vi.mock('@app/utils/docx', () => ({createDocxFromTextAsync: createDocxFromTextAsyncMock}));
vi.mock('@app/utils/docxStreaming', () => ({createDocxFromTextChunks: createDocxFromTextChunksMock}));
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

beforeEach(() => {
    vi.clearAllMocks();
});

describe('useDocxExport', () => {
    it('uses the async docx builder without cleaning filesystem output paths', async () => {
        const callOrder: string[] = [];
        documentFilesMock.saveDocxAs.mockImplementationOnce(async () => {
            callOrder.push('save');
            return '/tmp/export.docx';
        });
        loadDocumentTextCatalogPagesMock.mockImplementationOnce(async () => {
            callOrder.push('loadCatalog');
            return [{
                pageNumber: 1,
                text: 'catalog text',
            }];
        });
        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: '/tmp/work.pdf',
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as PDFDocumentProxy,
            selectedLanguages: ['heb'],
        });

        expect(result).toBe(true);
        expect(callOrder).toEqual([
            'save',
            'loadCatalog',
        ]);
        expect(loadDocumentTextCatalogPagesMock).toHaveBeenCalledWith('/tmp/work.pdf', TEST_DOCUMENT_REVISION, undefined);
        expect(createDocxFromTextChunksMock).toHaveBeenCalledWith(expect.anything(), true);
        expect(documentFilesMock.saveDocxAs).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(documentFilesMock.writeDocxFileChunks).toHaveBeenCalledWith(
            '/tmp/export.docx',
            expect.anything(),
        );
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentWorkingCopyMock.cleanupFile).not.toHaveBeenCalled();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'success',
            title: expect.any(String),
            description: expect.any(String),
        }));
        expect(trackMock).toHaveBeenCalledWith('export_completed', expect.objectContaining({
            format: 'docx',
            hasRtl: true,
            selectedLanguageCount: 1,
            status: 'success',
        }));
    });

    it('streams desktop DOCX output beyond the legacy budgets in bounded chunks', async () => {
        const {
            createDocxFromTextChunks: actualCreateDocxFromTextChunks,
            DOCX_STREAM_CHUNK_BYTES,
        } = await vi.importActual<IActualDocxStreamingModule>('@app/utils/docxStreaming');
        const chunks: Uint8Array[] = [];
        createDocxFromTextChunksMock.mockImplementationOnce(actualCreateDocxFromTextChunks);
        documentFilesMock.writeDocxFileChunks.mockImplementationOnce(async (_path, stream) => {
            for await (const chunk of stream) {
                expect(chunk.byteLength).toBeLessThanOrEqual(DOCX_STREAM_CHUNK_BYTES);
                chunks.push(chunk);
            }
            return true;
        });
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce(
            Array.from({length: 4}, (_, index) => ({
                pageNumber: index + 1,
                text: 'x'.repeat(1024 * 1024),
            })),
        );

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();
        const result = await exportState.exportDocx({
            workingCopyPath: '/tmp/work.pdf',
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as PDFDocumentProxy,
        });

        expect(result).toBe(true);
        expect(chunks.length).toBeGreaterThan(4);
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentFilesMock.writeDocxFileChunks).toHaveBeenCalledOnce();
    });

    it('does not cleanup filesystem output paths when no DOCX text is available', async () => {
        documentFilesMock.saveDocxAs.mockResolvedValueOnce('/tmp/empty.docx');
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce(null);

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: '/tmp/work.pdf',
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as PDFDocumentProxy,
        });

        expect(result).toBe(false);
        expect(exportState.docxExportError.value).toBe('errors.ocr.noText');
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentFilesMock.writeDocxFileChunks).not.toHaveBeenCalled();
        expect(documentWorkingCopyMock.cleanupFile).not.toHaveBeenCalled();
        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('cleans up browser output refs when no DOCX text is available', async () => {
        documentFilesMock.saveDocxAs.mockResolvedValueOnce('browser://documents/output/empty.docx');
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce(null);

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: 'browser://documents/working/work.pdf',
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as PDFDocumentProxy,
        });

        expect(result).toBe(false);
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentFilesMock.writeDocxFileChunks).not.toHaveBeenCalled();
        expect(documentWorkingCopyMock.cleanupFile).toHaveBeenCalledWith('browser://documents/output/empty.docx');
    });
});
