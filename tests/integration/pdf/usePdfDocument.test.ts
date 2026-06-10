import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const loggerError = vi.fn();
const loggerDebug = vi.fn();
const createObjectURLMock = vi.fn(() => 'blob:pdf-load');
const revokeObjectURLMock = vi.fn();

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    error: loggerError,
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: loggerDebug,
}}));

interface IPdfjsDataRangeTransport {
    onDataRange: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    requestDataRange: ((begin: number, end: number) => void) | null;
}

class MockPdfDataRangeTransport implements IPdfjsDataRangeTransport {
    public onDataRange = vi.fn();
    public abort = vi.fn();
    public requestDataRange: ((begin: number, end: number) => void) | null = null;

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

vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => electronApi}));

const {usePdfDocument} = await import('@app/composables/pdf/usePdfDocument');
const {maxCachedPdfPages} = await import('@app/utils/pdf-viewer/maxCachedPdfPages');

const rangePreloadTestTimeoutMs = 15_000;

describe('usePdfDocument range loading', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: createObjectURLMock,
            revokeObjectURL: revokeObjectURLMock,
        });
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
        });
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

        const { getPdfjsAssetDir } = await import('@app/utils/viewerAssets');
        expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        expect(pdfjsState.getDocument).toHaveBeenCalledWith(expect.objectContaining({
            range: expect.any(MockPdfDataRangeTransport),
            length: size,
            rangeChunkSize: 1024 * 1024,
            verbosity: pdfjsState.VerbosityLevel.ERRORS,
            standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
            cMapUrl: getPdfjsAssetDir('cmaps'),
            cMapPacked: true,
            wasmUrl: getPdfjsAssetDir('wasm'),
            iccUrl: getPdfjsAssetDir('iccs'),
            useSystemFonts: false,
        }));
    });

    it('keeps the preloaded tail cached until PDF.js requests it', async () => {
        const getDocumentCalled = Promise.withResolvers<MockPdfDataRangeTransport>();
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => Promise.resolve());
        const chunkLength = 1024 * 1024;
        const size = chunkLength * 3;
        const tailStart = size - chunkLength;
        const initialData = new Uint8Array(chunkLength);
        const tailData = new Uint8Array(chunkLength);
        initialData[0] = 1;
        tailData[0] = 9;
        tailData[chunkLength - 1] = 7;

        pdfjsState.getDocument.mockImplementation((options: { range?: MockPdfDataRangeTransport }) => {
            expect(options.range?.onDataRange).not.toHaveBeenCalled();
            if (options.range) {
                getDocumentCalled.resolve(options.range);
            } else {
                getDocumentCalled.reject(new Error('Expected PDF range transport'));
            }
            return {
                promise: deferred.promise,
                destroy,
            };
        });

        electronApi.documents.readFileRange.mockImplementation(async (
            _path: string,
            offset: number,
            length: number,
        ) => {
            if (offset === 0) {
                expect(length).toBe(chunkLength);
                return initialData;
            }
            if (offset === tailStart) {
                expect(length).toBe(chunkLength);
                return tailData;
            }
            throw new Error(`Unexpected PDF range read ${offset}..${offset + length}`);
        });

        const documentState = usePdfDocument();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/preloaded-tail.pdf',
            size,
        });

        const range = await getDocumentCalled.promise;

        expect(range.onDataRange).not.toHaveBeenCalled();

        const dataRangeDelivered = Promise.withResolvers<{
            begin: number;
            chunk: unknown;
        }>();
        range.onDataRange.mockImplementation((begin: number, chunk: unknown) => {
            dataRangeDelivered.resolve({
                begin,
                chunk,
            });
        });
        if (!range.requestDataRange) {
            throw new Error('Expected PDF range request handler');
        }

        range.requestDataRange(tailStart, size);
        const deliveredRange = await dataRangeDelivered.promise;

        expect(electronApi.documents.readFileRange).toHaveBeenCalledTimes(2);
        expect(range.onDataRange).toHaveBeenCalledTimes(1);
        const rangeChunk = deliveredRange.chunk as Uint8Array | undefined;
        expect(deliveredRange.begin).toBe(tailStart);
        expect(rangeChunk).toBeInstanceOf(Uint8Array);
        expect(rangeChunk).not.toBe(tailData);
        expect(rangeChunk).toHaveLength(chunkLength);
        expect(rangeChunk?.[0]).toBe(9);
        expect(rangeChunk?.[chunkLength - 1]).toBe(7);

        documentState.cleanup();
        deferred.reject(new Error('range cache test cancelled load'));

        await expect(loadPromise).resolves.toBeNull();
    }, rangePreloadTestTimeoutMs);

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
        });
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
        });
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

    it('keeps metric-loaded page proxies cached for the later render path', async () => {
        const pageCleanup = vi.fn();
        const page2 = {
            cleanup: pageCleanup,
            getViewport: vi.fn(() => ({
                width: 202,
                height: 402,
            })),
        };
        const pages = new Map<number, unknown>([
            [
                1,
                {
                    cleanup: vi.fn(),
                    getViewport: vi.fn(() => ({
                        width: 201,
                        height: 401,
                    })),
                },
            ],
            [
                2,
                page2,
            ],
        ]);
        const getPage = vi.fn(async (pageNumber: number) => pages.get(pageNumber));
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 2,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documents.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = usePdfDocument();
        await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/cache-metrics-for-render.pdf',
            size: 2048,
        });

        await expect(documentState.ensurePageMetricsInRange(2, 2)).resolves.toBe(true);
        await expect(documentState.getPage(2)).resolves.toBe(page2);

        expect(pageCleanup).not.toHaveBeenCalled();
        expect(getPage).toHaveBeenCalledTimes(2);
    });

    it('returns null and clears loading when PDF.js range transport API is unavailable', async () => {
        delete pdfjsState.PDFDataRangeTransport;
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
        });

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
            size: (1024 * 1024) + 512,
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
        expect(getDocumentArg?.range?.abort).toHaveBeenCalledTimes(1);
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

    it('fulfills a PDF.js range request with multiple platform reads when a read is short', async () => {
        const deferred = Promise.withResolvers<{
            numPages: number;
            getPage: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
        }>();
        const destroy = vi.fn(() => Promise.resolve());

        pdfjsState.getDocument.mockReturnValue({
            promise: deferred.promise,
            destroy,
        });

        const requestedStart = 5 * 1024 * 1024;
        const requestedEnd = requestedStart + 12;
        electronApi.documents.readFileRange.mockImplementation(async (
            _path: string,
            offset: number,
            length: number,
        ) => {
            if (offset === requestedStart) {
                expect(length).toBe(12);
                return new Uint8Array(8);
            }
            if (offset === requestedStart + 8) {
                expect(length).toBe(4);
                return new Uint8Array(4);
            }
            return new Uint8Array(Math.min(length, 4));
        });

        const documentState = usePdfDocument();
        const loadPromise = documentState.loadPdf({
            kind: 'path',
            path: '/tmp/short-range-read.pdf',
            size: 20 * 1024 * 1024,
        });

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        const getDocumentArg = pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined;
        const range = getDocumentArg?.range;
        expect(range).toBeInstanceOf(MockPdfDataRangeTransport);
        range?.onDataRange.mockClear();

        await range?.requestDataRange?.(requestedStart, requestedEnd);
        await vi.waitFor(() => {
            expect(range?.onDataRange).toHaveBeenCalledTimes(1);
        });

        expect(electronApi.documents.readFileRange).toHaveBeenCalledWith(
            '/tmp/short-range-read.pdf',
            requestedStart,
            12,
        );
        expect(electronApi.documents.readFileRange).toHaveBeenCalledWith(
            '/tmp/short-range-read.pdf',
            requestedStart + 8,
            4,
        );
        expect(range?.onDataRange.mock.calls[0]?.[0]).toBe(requestedStart);
        expect(range?.onDataRange.mock.calls[0]?.[1]).toHaveLength(12);

        deferred.resolve({
            numPages: 1,
            getPage: vi.fn(async () => ({
                cleanup: vi.fn(),
                getViewport: vi.fn(() => ({
                    width: 100,
                    height: 200,
                })),
            })),
            destroy,
        });

        await expect(loadPromise).resolves.not.toBeNull();
    });

    it('destroys the PDF.js loading task and aborts range transport when document parsing fails', async () => {
        const destroy = vi.fn(() => Promise.resolve());
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.reject(new Error('parse failed')),
            destroy,
        });
        electronApi.documents.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = usePdfDocument();
        const result = await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/parse-failure.pdf',
            size: (1024 * 1024) + 512,
        });

        const getDocumentArg = pdfjsState.getDocument.mock.calls[0]?.[0] as { range?: MockPdfDataRangeTransport } | undefined;
        expect(result).toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(getDocumentArg?.range?.abort).toHaveBeenCalledTimes(1);

        documentState.cleanup();

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(getDocumentArg?.range?.abort).toHaveBeenCalledTimes(1);
    });

    it('destroys the PDF.js loading task and revokes blob URLs when blob loading fails', async () => {
        const destroy = vi.fn(() => Promise.resolve());
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.reject(new Error('blob parse failed')),
            destroy,
        });

        const documentState = usePdfDocument();
        const result = await documentState.loadPdf(new Blob([Uint8Array.of(1, 2, 3)]));

        expect(result).toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(createObjectURLMock).toHaveBeenCalledTimes(1);
        expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:pdf-load');

        documentState.cleanup();

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
    });

    it('bounds the cached PDF pages with an LRU policy', async () => {
        const loadedPages = new Map<number, Array<{
            cleanup: ReturnType<typeof vi.fn>;
            pageNumber: number;
        }>>();
        const getPage = vi.fn(async (pageNumber: number) => ({
            getViewport: vi.fn(() => ({
                width: 200,
                height: 400,
            })),
            cleanup: vi.fn(),
            pageNumber,
        })).mockImplementation(async (pageNumber: number) => {
            const page = {
                getViewport: vi.fn(() => ({
                    width: 200,
                    height: 400,
                })),
                cleanup: vi.fn(),
                pageNumber,
            };
            loadedPages.set(pageNumber, [
                ...(loadedPages.get(pageNumber) ?? []),
                page,
            ]);
            return page;
        });
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: maxCachedPdfPages + 5,
                getPage,
                destroy: vi.fn(),
            }),
            destroy: vi.fn(),
        });
        electronApi.documents.readFileRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));

        const documentState = usePdfDocument();
        await documentState.loadPdf({
            kind: 'path',
            path: '/tmp/cache-lru.pdf',
            size: 2048,
        });

        expect(getPage).toHaveBeenCalledTimes(1);

        for (let pageNumber = 2; pageNumber <= maxCachedPdfPages + 1; pageNumber += 1) {
            await documentState.getPage(pageNumber);
        }

        expect(getPage).toHaveBeenCalledTimes(maxCachedPdfPages + 1);

        await documentState.getPage(1);

        expect(getPage).toHaveBeenCalledTimes(maxCachedPdfPages + 2);

        await documentState.getPage(maxCachedPdfPages + 1);

        expect(getPage).toHaveBeenCalledTimes(maxCachedPdfPages + 2);
        expect(loadedPages.get(2)?.[0]?.cleanup).toHaveBeenCalledTimes(1);
    });
});
