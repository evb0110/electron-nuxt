import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const loggerError = vi.fn();
const loggerDebug = vi.fn();

vi.mock('@app/utils/browser-logger', () => ({BrowserLogger: {
    error: loggerError,
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: loggerDebug,
}}));

interface ILoadingTask {
    promise: Promise<unknown>;
    destroy: ReturnType<typeof vi.fn>;
}

interface IPdfjsDataRangeTransport {
    onDataRange: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    requestDataRange: ((begin: number, end: number) => Promise<void>) | null;
}

class MockPdfDataRangeTransport implements IPdfjsDataRangeTransport {
    public onDataRange = vi.fn();
    public abort = vi.fn();
    public requestDataRange: ((begin: number, end: number) => Promise<void>) | null = null;

    constructor(length: number, initialData: Uint8Array) {
        void length;
        void initialData;
    }
}

const pdfjsState: {
    GlobalWorkerOptions: { workerSrc: string };
    VerbosityLevel: { ERRORS: number };
    getDocument: ReturnType<typeof vi.fn>;
    PDFDataRangeTransport?: typeof MockPdfDataRangeTransport;
} = {
    GlobalWorkerOptions: { workerSrc: '' },
    VerbosityLevel: { ERRORS: 0 },
    getDocument: vi.fn(),
    PDFDataRangeTransport: MockPdfDataRangeTransport,
};

vi.mock('pdfjs-dist', () => pdfjsState);

const electronApi = {documents: {readFileRange: vi.fn()}};

vi.mock('@app/utils/platform', () => ({getElectronAPI: () => electronApi}));

const { usePdfDocument } = await import('@app/composables/pdf/usePdfDocument');

describe('usePdfDocument range loading', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        pdfjsState.PDFDataRangeTransport = MockPdfDataRangeTransport;
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage: vi.fn(async () => ({getViewport: vi.fn(() => ({
                    width: 100,
                    height: 200,
                }))})),
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        } as ILoadingTask);
    });

    it('loads a PDF through range transport and populates document state', async () => {
        const size = (1024 * 1024 * 2) + 13;
        electronApi.documents.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = usePdfDocument();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/success.pdf',
            size,
        });

        expect(result).not.toBeNull();
        expect(documentState.pdfDocument.value).not.toBeNull();
        expect(documentState.pdfDocument.value).toBe(result?.document ?? null);
        expect(documentState.numPages.value).toBe(1);
        expect(documentState.basePageWidth.value).toBe(100);
        expect(documentState.basePageHeight.value).toBe(200);
        expect(documentState.pageMetrics.value).toEqual([{
            width: 100,
            height: 200,
        }]);
        expect(documentState.isLoading.value).toBe(false);

        expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        expect(pdfjsState.getDocument).toHaveBeenCalledWith(expect.objectContaining({
            range: expect.any(MockPdfDataRangeTransport),
            length: size,
            rangeChunkSize: 1024 * 1024,
            verbosity: pdfjsState.VerbosityLevel.ERRORS,
            standardFontDataUrl: '/pdf/standard_fonts/',
            cMapUrl: '/pdf/cmaps/',
            cMapPacked: true,
            wasmUrl: '/pdf/wasm/',
            iccUrl: '/pdf/iccs/',
            useSystemFonts: false,
        }));
    });

    it('uses the largest measured page as the fit baseline when page sizes differ', async () => {
        const getPage = vi.fn(async (pageNumber: number) => {
            const metrics = [
                {
                    width: 180,
                    height: 240,
                },
                {
                    width: 612,
                    height: 792,
                },
                {
                    width: 320,
                    height: 640,
                },
            ];
            const metric = metrics[pageNumber - 1]!;
            return { getViewport: vi.fn(() => metric) };
        });
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 3,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        } as ILoadingTask);
        electronApi.documents.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = usePdfDocument();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/mixed-sizes.pdf',
            size: 1024,
        });

        expect(result).not.toBeNull();
        expect(documentState.basePageWidth.value).toBe(180);
        expect(documentState.basePageHeight.value).toBe(240);
        expect(documentState.pageMetrics.value).toEqual([{
            width: 180,
            height: 240,
        }]);
        expect(getPage).toHaveBeenCalledTimes(1);

        await expect(documentState.ensurePageMetricsInRange(2, 3)).resolves.toBe(true);

        expect(documentState.basePageWidth.value).toBe(612);
        expect(documentState.basePageHeight.value).toBe(792);
        expect(documentState.pageMetrics.value).toEqual([
            {
                width: 180,
                height: 240,
            },
            {
                width: 612,
                height: 792,
            },
            {
                width: 320,
                height: 640,
            },
        ]);
        expect(getPage).toHaveBeenCalledTimes(3);
    });

    it('hydrates only the requested metric range after the initial page', async () => {
        const getPage = vi.fn(async (pageNumber: number) => ({ getViewport: vi.fn(() => ({
            width: 200 + pageNumber,
            height: 400 + pageNumber,
        })) }));
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 5,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        } as ILoadingTask);
        electronApi.documents.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = usePdfDocument();
        await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/lazy-metrics.pdf',
            size: 2048,
        });

        expect(getPage).toHaveBeenCalledTimes(1);
        expect(documentState.pageMetrics.value[0]).toEqual({
            width: 201,
            height: 401,
        });
        expect(documentState.pageMetrics.value[3]).toBeUndefined();

        await expect(documentState.ensurePageMetricsInRange(4, 5)).resolves.toBe(true);

        expect(getPage).toHaveBeenCalledTimes(3);
        expect(documentState.pageMetrics.value[3]).toEqual({
            width: 204,
            height: 404,
        });
        expect(documentState.pageMetrics.value[4]).toEqual({
            width: 205,
            height: 405,
        });
        expect(documentState.pageMetrics.value[1]).toBeUndefined();
    });

    it('returns null and clears loading when PDF.js range transport API is unavailable', async () => {
        pdfjsState.PDFDataRangeTransport = undefined;
        electronApi.documents.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const documentState = usePdfDocument();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/a.pdf',
            size: 3,
        });

        expect(result).toBeNull();
        expect(documentState.isLoading.value).toBe(false);
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-document',
            'Failed to load PDF',
            expect.any(Error),
        );
    });

    it('returns null and clears loading when initial range read fails', async () => {
        electronApi.documents.readFileRange.mockRejectedValue(new Error('read failed'));

        const documentState = usePdfDocument();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/b.pdf',
            size: 7,
        });

        expect(result).toBeNull();
        expect(documentState.isLoading.value).toBe(false);
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-document',
            'Failed to load PDF',
            expect.any(Error),
        );
    });

    it('fails the load instead of hanging when a later range read rejects', async () => {
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => {
            deferred.reject(new Error('range load aborted'));
            return Promise.resolve();
        });

        pdfjsState.getDocument.mockReturnValue({
            promise: deferred.promise,
            destroy,
        } as ILoadingTask);

        electronApi.documents.readFileRange
            .mockResolvedValueOnce(new Uint8Array([
                1,
                2,
                3,
                4,
            ]))
            .mockRejectedValueOnce(new Error('late range read failed'));

        const documentState = usePdfDocument();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/late-failure.pdf',
            size: 1024 * 1024 * 3,
        });

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        const getDocumentArg = pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined;
        expect(getDocumentArg?.range).toBeInstanceOf(MockPdfDataRangeTransport);

        await getDocumentArg?.range?.requestDataRange?.(1024 * 1024, (1024 * 1024) + 512);

        await expect(loadPromise).resolves.toBeNull();
        expect(documentState.isLoading.value).toBe(false);
        expect(documentState.pdfDocument.value).toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-document',
            'Failed to read PDF range chunk',
            expect.any(Error),
        );
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-document',
            'Failed to load PDF',
            expect.any(Error),
        );
    });
});
