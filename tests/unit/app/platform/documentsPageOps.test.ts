import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    degrees,
    PDFDocument,
} from 'pdf-lib';

const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const browserDocumentStoreMock = vi.hoisted(() => ({
    read: vi.fn(),
    stat: vi.fn(),
    write: vi.fn(async () => {}),
    createStoredDocument: vi.fn(),
    replaceWithHandleBackedDocument: vi.fn(async () => {}),
    touchRecentFile: vi.fn(async () => {}),
}));
const BrowserPageOpsWorkerUnavailableError = vi.hoisted(() => class extends Error {});
const browserPageOpsWorkerMock = vi.hoisted(() => ({
    canUse: vi.fn(() => false),
    run: vi.fn(),
}));

vi.mock('@app/platform/browser-api/browserYield', () => ({yieldToBrowser: yieldToBrowserMock}));
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({
    BrowserPageOpsWorkerUnavailableError,
    canUseBrowserPageOpsWorker: () => browserPageOpsWorkerMock.canUse(),
    runBrowserPageOpsWorkerRequest: (...args: unknown[]) => browserPageOpsWorkerMock.run(...args),
}));
vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_DOCUMENT_CHUNK_SIZE: 4 * 1024 * 1024,
    getBrowserDocumentFileName: (ref: string) => ref.split('/').at(-1) ?? 'document.pdf',
    browserDocumentStore: browserDocumentStoreMock,
}));

describe('createBrowserPageOps', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        browserDocumentStoreMock.read.mockReset();
        browserDocumentStoreMock.stat.mockReset();
        browserDocumentStoreMock.write.mockReset();
        browserDocumentStoreMock.write.mockResolvedValue(undefined);
        browserDocumentStoreMock.createStoredDocument.mockReset();
        browserDocumentStoreMock.replaceWithHandleBackedDocument.mockReset();
        browserDocumentStoreMock.replaceWithHandleBackedDocument.mockResolvedValue(undefined);
        browserDocumentStoreMock.touchRecentFile.mockReset();
        browserDocumentStoreMock.touchRecentFile.mockResolvedValue(undefined);
        browserPageOpsWorkerMock.canUse.mockReset();
        browserPageOpsWorkerMock.canUse.mockReturnValue(false);
        browserPageOpsWorkerMock.run.mockReset();
    });

    it('yields before applying direct multi-page mutations', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const clearSearchCaches = vi.fn();
        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches,
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        const result = await pageOps.rotate('/tmp/work.pdf', [
            1,
            2,
            3,
        ], 90);

        expect(result.success).toBe(true);
        expect(browserDocumentStoreMock.write).toHaveBeenCalledTimes(1);
        expect(clearSearchCaches).toHaveBeenCalledTimes(1);
        expect(yieldToBrowserMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects large browser page-ops jobs before reading the full PDF', async () => {
        browserDocumentStoreMock.stat.mockResolvedValue({ size: (64 * 1024 * 1024) + 1 });

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.delete('/tmp/work.pdf', [1], 1)).rejects.toThrow(
            'Deleting pages is unavailable in the browser for PDFs larger than 64MB',
        );
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('rejects duplicate page selections instead of silently normalizing them', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.delete('/tmp/work.pdf', [
            2,
            2,
        ], 3)).rejects.toThrow('deletePages: duplicate page number 2');
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('rejects out-of-range page mutations instead of silently dropping them', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.rotate('/tmp/work.pdf', [4], 90)).rejects.toThrow(
            'rotatePages: page number 4 is out of range 1-3',
        );
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('rejects non-permutation reorder payloads instead of partially reordering pages', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.reorder('/tmp/work.pdf', [
            3,
            1,
        ])).rejects.toThrow('reorderPages: missing page 2 in reorder payload');
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('uses the worker for crop mutations above the direct browser budget', async () => {
        const pdfBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        const workerResult = {
            data: new Uint8Array([
                4,
                5,
                6,
            ]),
            pageCount: 1,
        };
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 120 * 1024 * 1024 });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run.mockResolvedValue(workerResult);

        const clearSearchCaches = vi.fn();
        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches,
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        const result = await pageOps.crop('/tmp/work.pdf', [1], {
            top: 12,
            bottom: 8,
            left: 6,
            right: 4,
        });

        expect(result.success).toBe(true);
        expect(browserDocumentStoreMock.read).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.write).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.write).toHaveBeenCalledWith('/tmp/work.pdf', workerResult.data);
        expect(browserPageOpsWorkerMock.run).toHaveBeenCalledWith('crop', {
            data: pdfBytes,
            pages: [1],
            margins: {
                top: 12,
                bottom: 8,
                left: 6,
                right: 4,
            },
        });
        expect(clearSearchCaches).toHaveBeenCalledTimes(1);
    });

    it('uses the worker for delete and reorder mutations when available', async () => {
        const pdfBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run
            .mockResolvedValueOnce({
                data: new Uint8Array([4]),
                pageCount: 2,
            })
            .mockResolvedValueOnce({
                data: new Uint8Array([5]),
                pageCount: 2,
            });

        const clearSearchCaches = vi.fn();
        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches,
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.delete('/tmp/work.pdf', [2], 3)).resolves.toEqual({
            success: true,
            pageCount: 2,
        });
        await expect(pageOps.reorder('/tmp/work.pdf', [
            2,
            1,
        ])).resolves.toEqual({
            success: true,
            pageCount: 2,
        });

        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(1, 'deletePages', {
            data: pdfBytes,
            pages: [2],
        });
        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(2, 'reorderPages', {
            data: pdfBytes,
            newOrder: [
                2,
                1,
            ],
        });
        expect(browserDocumentStoreMock.write).toHaveBeenCalledTimes(2);
        expect(clearSearchCaches).toHaveBeenCalledTimes(2);
    });

    it('serializes same working-copy mutations so later reads see earlier writes', async () => {
        let storedBytes = new Uint8Array([1]);
        let releaseFirstWorker: () => void = () => {};
        const firstWorkerGate = new Promise<void>((resolve) => {
            releaseFirstWorker = resolve;
        });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 1 });
        browserDocumentStoreMock.read.mockImplementation(async () => storedBytes);
        browserDocumentStoreMock.write.mockImplementation(async (...args: unknown[]) => {
            const data = args[1] as Uint8Array<ArrayBuffer>;
            storedBytes = data;
        });
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run
            .mockImplementationOnce(async () => {
                await firstWorkerGate;
                return {
                    data: new Uint8Array([2]),
                    pageCount: 1,
                };
            })
            .mockResolvedValueOnce({
                data: new Uint8Array([3]),
                pageCount: 1,
            });

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        const rotatePromise = pageOps.rotate('/tmp/work.pdf', [1], 90);
        const deletePromise = pageOps.delete('/tmp/work.pdf', [1], 1);
        await vi.waitFor(() => {
            expect(browserPageOpsWorkerMock.run).toHaveBeenCalledTimes(1);
        });
        releaseFirstWorker();
        await Promise.all([
            rotatePromise,
            deletePromise,
        ]);

        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(1, 'rotate', expect.objectContaining({data: new Uint8Array([1])}));
        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(2, 'deletePages', expect.objectContaining({data: new Uint8Array([2])}));
        expect(storedBytes).toEqual(new Uint8Array([3]));
    });

    it('uses the worker for geometry inspection above the direct browser budget', async () => {
        const pdfBytes = new Uint8Array([
            7,
            8,
            9,
        ]);
        const geometry = {
            mediaBox: {
                x: 0,
                y: 0,
                width: 300,
                height: 500,
            },
            cropBox: null,
            rotation: 90,
        };
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 120 * 1024 * 1024 });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run.mockResolvedValue(geometry);

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.getPageGeometry('/tmp/work.pdf', 1)).resolves.toEqual(geometry);
        expect(browserPageOpsWorkerMock.run).toHaveBeenCalledWith('getPageGeometry', {
            data: pdfBytes,
            pageNumber: 1,
        });
        expect(browserDocumentStoreMock.read).toHaveBeenCalledTimes(1);
    });

    it('returns crop boxes and rotation when inspecting page geometry directly', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([
            300,
            500,
        ]);
        page.setCropBox(20, 30, 260, 420);
        page.setRotation(degrees(90));
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.getPageGeometry('/tmp/work.pdf', 1)).resolves.toEqual({
            mediaBox: {
                x: 0,
                y: 0,
                width: 300,
                height: 500,
            },
            cropBox: {
                x: 20,
                y: 30,
                width: 260,
                height: 420,
            },
            rotation: 90,
        });
        expect(browserDocumentStoreMock.read).toHaveBeenCalledTimes(1);
    });

    it('returns PDF.js effective crop boxes when direct geometry inspection sees CropBox outside MediaBox', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([
            300,
            500,
        ]);
        page.setCropBox(-20, 30, 260, 520);
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.getPageGeometry('/tmp/work.pdf', 1)).resolves.toEqual({
            mediaBox: {
                x: 0,
                y: 0,
                width: 300,
                height: 500,
            },
            cropBox: {
                x: 0,
                y: 30,
                width: 240,
                height: 470,
            },
            rotation: 0,
        });
        expect(browserDocumentStoreMock.read).toHaveBeenCalledTimes(1);
    });

    it('locks in the browser save target before extracting pages and writes to that handle', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/extract/work-extract.pdf',
        );

        const pickSaveTarget = vi.fn(async () => ({
            canceled: false,
            fileName: 'work-extract.pdf',
            handle: { name: 'work-extract.pdf' } as FileSystemFileHandle,
        }));
        const saveBytesToPickerOrDownload = vi.fn();
        const writeBytesToHandle = vi.fn(
            async (_handle: FileSystemFileHandle, _data: Uint8Array) => {},
        );

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths: vi.fn(),
            pickSaveTarget,
            saveBytesToPickerOrDownload,
            writeBytesToHandle,
        });

        const result = await pageOps.extract('/tmp/work.pdf', [
            2,
            3,
        ]);

        expect(result).toEqual({
            success: true,
            destPath: 'browser://documents/extract/work-extract.pdf',
        });
        expect(pickSaveTarget).toHaveBeenCalledWith({
            suggestedName: 'work-extract.pdf',
            pickerTypes: expect.any(Array),
        });
        expect(pickSaveTarget.mock.invocationCallOrder[0]).toBeLessThan(
            browserDocumentStoreMock.read.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(writeBytesToHandle).toHaveBeenCalledTimes(1);
        expect(saveBytesToPickerOrDownload).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledWith(
            'work-extract.pdf',
            expect.any(Uint8Array),
            expect.objectContaining({
                mimeType: 'application/pdf',
                saveKind: 'pdf',
                kind: 'source',
                saveHandle: expect.objectContaining({ name: 'work-extract.pdf' }),
                storageMode: 'handle',
            }),
        );
        expect(browserDocumentStoreMock.replaceWithHandleBackedDocument).toHaveBeenCalledWith(
            'browser://documents/extract/work-extract.pdf',
            expect.objectContaining({
                fileSize: expect.any(Number),
                saveHandle: expect.objectContaining({ name: 'work-extract.pdf' }),
                saveName: 'work-extract.pdf',
            }),
        );
        expect(browserDocumentStoreMock.touchRecentFile).toHaveBeenCalledWith(
            'browser://documents/extract/work-extract.pdf',
        );

        const writeCall = writeBytesToHandle.mock.calls[0];
        expect(writeCall).toBeDefined();
        if (!writeCall) {
            throw new Error('Expected extract to write bytes to the reserved save handle');
        }
        const writtenBytes = writeCall[1];
        expect(writtenBytes).toBeInstanceOf(Uint8Array);
        const extractedPdf = await PDFDocument.load(writtenBytes);
        expect(extractedPdf.getPageCount()).toBe(2);
    });

    it('uses the worker for extract and insert when available', async () => {
        const pdfBytes = new Uint8Array([
            9,
            8,
            7,
        ]);
        const insertionBytes = new Uint8Array([
            6,
            5,
            4,
        ]);
        browserDocumentStoreMock.stat.mockImplementation(async (path: string) => {
            if (path === '/tmp/work.pdf') {
                return { size: pdfBytes.byteLength };
            }

            return { size: insertionBytes.byteLength };
        });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/extract/work-extract.pdf',
        );
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run
            .mockResolvedValueOnce({
                data: insertionBytes,
                pageCount: 1,
            })
            .mockResolvedValueOnce({
                data: new Uint8Array([
                    3,
                    2,
                    1,
                ]),
                pageCount: 2,
            });

        const pickSaveTarget = vi.fn(async () => ({
            canceled: false,
            fileName: 'work-extract.pdf',
            handle: null,
        }));
        const saveBytesToPickerOrDownload = vi.fn(async () => ({
            canceled: false,
            fileName: 'work-extract.pdf',
            handle: null,
        }));
        const createCombinedPdfFromPaths = vi.fn(async () => insertionBytes);

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths,
            pickSaveTarget,
            saveBytesToPickerOrDownload,
            writeBytesToHandle: vi.fn(),
        });

        await pageOps.extract('/tmp/work.pdf', [1]);
        await pageOps.insertFile('/tmp/work.pdf', 1, 1, ['browser://documents/picked/image.png']);

        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(1, 'extractPages', {
            data: pdfBytes,
            pages: [1],
        });
        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(2, 'insertPages', {
            data: pdfBytes,
            insertionData: insertionBytes,
            afterPage: 1,
        });
        expect(createCombinedPdfFromPaths).toHaveBeenCalledWith(
            ['browser://documents/picked/image.png'],
            expect.objectContaining({requestId: expect.stringMatching(/^browser-page-op-insert-/u)}),
        );
        expect(saveBytesToPickerOrDownload).toHaveBeenCalledTimes(1);
    });

    it('rejects large browser insert jobs when the worker path is unavailable', async () => {
        const destinationPdf = await PDFDocument.create();
        destinationPdf.addPage([
            300,
            500,
        ]);
        const destinationBytes = new Uint8Array(await destinationPdf.save());

        const insertionPdf = await PDFDocument.create();
        insertionPdf.addPage([
            200,
            200,
        ]);
        const insertionBytes = new Uint8Array(await insertionPdf.save());

        browserDocumentStoreMock.stat.mockImplementation(async (path: string) => {
            if (path === '/tmp/work.pdf') {
                return { size: 120 * 1024 * 1024 };
            }

            return { size: insertionBytes.byteLength };
        });
        browserDocumentStoreMock.read.mockResolvedValue(destinationBytes);

        const createCombinedPdfFromPaths = vi.fn(async () => insertionBytes);
        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths,
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.insertFile(
            '/tmp/work.pdf',
            1,
            1,
            ['browser://documents/picked/image.png'],
        )).rejects.toThrow(
            'Inserting pages is unavailable in the browser for jobs larger than 96MB',
        );
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(createCombinedPdfFromPaths).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('rejects browser insert jobs whose working set would exceed the safety budget', async () => {
        browserDocumentStoreMock.stat.mockImplementation(async (path: string) => {
            if (path === '/tmp/work.pdf') {
                return { size: 64 * 1024 * 1024 };
            }

            return { size: 40 * 1024 * 1024 };
        });

        const createCombinedPdfFromPaths = vi.fn(async () => new Uint8Array([1]));
        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths,
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        await expect(pageOps.insertFile(
            '/tmp/work.pdf',
            1,
            1,
            ['browser://documents/picked/insert.pdf'],
        )).rejects.toThrow(
            'Inserting pages is unavailable in the browser for jobs larger than 96MB',
        );

        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(createCombinedPdfFromPaths).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('bypasses browser combine when inserting a single PDF source', async () => {
        const destinationPdf = await PDFDocument.create();
        destinationPdf.addPage([
            300,
            500,
        ]);
        const destinationBytes = new Uint8Array(await destinationPdf.save());

        const insertionPdf = await PDFDocument.create();
        insertionPdf.addPage([
            200,
            200,
        ]);
        const insertionBytes = new Uint8Array(await insertionPdf.save());

        browserDocumentStoreMock.stat.mockImplementation(async (path: string) => {
            if (path === '/tmp/work.pdf') {
                return { size: destinationBytes.byteLength };
            }

            return { size: insertionBytes.byteLength };
        });
        browserDocumentStoreMock.read.mockImplementation(async (path: string) => (
            path === '/tmp/work.pdf' ? destinationBytes : insertionBytes
        ));

        const createCombinedPdfFromPaths = vi.fn(async () => new Uint8Array([9]));
        const { createBrowserPageOps } = await import('@app/platform/browser-api/documentsPageOps');
        const pageOps = createBrowserPageOps({
            clearSearchCaches: vi.fn(),
            openInputAccept: 'application/pdf',
            pickFiles: vi.fn(),
            buildOpenPdfPickerTypes: vi.fn(),
            createCombinedPdfFromPaths,
            pickSaveTarget: vi.fn(),
            saveBytesToPickerOrDownload: vi.fn(),
            writeBytesToHandle: vi.fn(),
        });

        const result = await pageOps.insertFile(
            '/tmp/work.pdf',
            1,
            1,
            ['browser://documents/picked/insert.pdf'],
        );

        expect(result.success).toBe(true);
        expect(createCombinedPdfFromPaths).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.read).toHaveBeenNthCalledWith(1, '/tmp/work.pdf');
        expect(browserDocumentStoreMock.read).toHaveBeenNthCalledWith(2, 'browser://documents/picked/insert.pdf');
        expect(browserDocumentStoreMock.write).toHaveBeenCalledTimes(1);
    });
});
