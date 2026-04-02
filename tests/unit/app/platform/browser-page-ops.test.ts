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
    touchRecentFile: vi.fn(async () => {}),
}));
const BrowserPageOpsWorkerUnavailableError = vi.hoisted(() => class extends Error {});
const browserPageOpsWorkerMock = vi.hoisted(() => ({
    canUse: vi.fn(() => false),
    run: vi.fn(),
}));

vi.mock('@app/platform/browser-api/browser-yield', () => ({yieldToBrowser: yieldToBrowserMock}));
vi.mock('@app/platform/browser-api/browser-page-ops-worker-client', () => ({
    BrowserPageOpsWorkerUnavailableError,
    canUseBrowserPageOpsWorker: () => browserPageOpsWorkerMock.canUse(),
    runBrowserPageOpsWorkerRequest: (...args: unknown[]) => browserPageOpsWorkerMock.run(...args),
}));
vi.mock('@app/platform/browser-document-store', () => ({
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
        const { createBrowserPageOps } = await import('@app/platform/browser-api/documents-page-ops');
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
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 64 * 1024 * 1024 });

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documents-page-ops');
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
            'Deleting pages is unavailable in the browser for PDFs larger than 48MB',
        );
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
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
        const { createBrowserPageOps } = await import('@app/platform/browser-api/documents-page-ops');
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

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documents-page-ops');
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

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documents-page-ops');
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

        const { createBrowserPageOps } = await import('@app/platform/browser-api/documents-page-ops');
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

    it('allows inserting image-backed pages into larger browser PDFs within the mutation budget', async () => {
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

        const clearSearchCaches = vi.fn();
        const createCombinedPdfFromPaths = vi.fn(async () => insertionBytes);
        const { createBrowserPageOps } = await import('@app/platform/browser-api/documents-page-ops');
        const pageOps = createBrowserPageOps({
            clearSearchCaches,
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
            ['browser://documents/picked/image.png'],
        );

        expect(result.success).toBe(true);
        expect(createCombinedPdfFromPaths).toHaveBeenCalledWith(['browser://documents/picked/image.png']);
        expect(browserDocumentStoreMock.write).toHaveBeenCalledTimes(1);
        expect(clearSearchCaches).toHaveBeenCalledTimes(1);
    });
});
