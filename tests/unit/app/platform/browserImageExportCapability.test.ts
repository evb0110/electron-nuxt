import * as utifModule from 'utif';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IUtifFrame {
    width?: number;
    height?: number;
    t273?: number[];
    [key: string]: unknown;
}

interface IUtifModule {
    decode(input: Uint8Array | ArrayBuffer): IUtifFrame[];
    decodeImage(input: Uint8Array | ArrayBuffer, frame: IUtifFrame): void;
    toRGBA8(frame: IUtifFrame): Uint8Array;
}

const browserDocumentStoreMock = vi.hoisted(() => ({
    createStoredDocument: vi.fn(),
    replaceWithHandleBackedDocument: vi.fn(),
    touchRecentFile: vi.fn(async () => {}),
}));
const saveBlobToPickerOrDownloadMock = vi.hoisted(() => vi.fn());
const saveBytesToPickerOrDownloadMock = vi.hoisted(() => vi.fn());
const pickSaveTargetMock = vi.hoisted(() => vi.fn());
const getDocumentMock = vi.hoisted(() => vi.fn());
const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@app/platform/browserDocumentStore', () => ({
    browserDocumentStore: browserDocumentStoreMock,
    getBrowserDocumentFileName: () => 'sample.pdf',
}));

vi.mock('@app/platform/browser-api/browserYield', () => ({ yieldToBrowser: yieldToBrowserMock }));

vi.mock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
    pickSaveTarget: (...args: unknown[]) => pickSaveTargetMock(...args),
    saveBlobToPickerOrDownload: (...args: unknown[]) => saveBlobToPickerOrDownloadMock(...args),
    saveBytesToPickerOrDownload: (...args: unknown[]) => saveBytesToPickerOrDownloadMock(...args),
}));

vi.mock('@app/platform/browser-api/browserImageExportConfig', () => ({ EXPORT_RENDER_SCALE: 1 }));

vi.mock('@app/platform/browser-api/browserPdfjsDocumentInit', () => ({
    createPdfjsDocumentInitFromBrowserDocument: vi.fn(async () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);
        return {data};
    }),
    getPdfjsLib: vi.fn(async () => ({getDocument: getDocumentMock})),
}));

vi.mock('@app/platform/browser-api/browserFileName', () => ({ ensurePdfExtension: (fileName: string) => fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf` }));

vi.mock('@app/platform/browser-api/browserBytes', () => ({ toUint8Array: (value: Uint8Array | ArrayBuffer) => value instanceof Uint8Array ? value : new Uint8Array(value) }));

const UTIF = utifModule as IUtifModule;

function countTiffDirectories(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = view.getUint32(4, false);
    let count = 0;

    while (offset !== 0) {
        expect(offset + 2).toBeLessThanOrEqual(bytes.byteLength);
        const entryCount = view.getUint16(offset, false);
        const nextPointerOffset = offset + 2 + (entryCount * 12);
        expect(nextPointerOffset + 4).toBeLessThanOrEqual(bytes.byteLength);
        offset = view.getUint32(nextPointerOffset, false);
        count += 1;
        expect(count).toBeLessThan(256);
    }

    return count;
}

function createCanvas() {
    const canvas = {
        width: 0,
        height: 0,
        currentPageNumber: 0,
        getContext: vi.fn(() => ({ getImageData: vi.fn(() => {
            const data = new Uint8ClampedArray([
                Math.max(0, canvas.currentPageNumber - 1),
                0,
                0,
                255,
            ]);
            return {data};
        }) })),
        toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
            callback(new Blob([new Uint8Array([canvas.currentPageNumber])], {type: 'image/png'}));
        }),
    };

    return canvas;
}

function createFakePdfDocument(pageCount: number) {
    return {
        numPages: pageCount,
        destroy: vi.fn(async () => {}),
        getPage: vi.fn(async (pageNumber: number) => ({
            getViewport: vi.fn(() => ({
                width: 1,
                height: 1,
            })),
            render: vi.fn(({ canvas }: { canvas: ReturnType<typeof createCanvas> }) => {
                canvas.currentPageNumber = pageNumber;
                return { promise: Promise.resolve() };
            }),
            cleanup: vi.fn(async () => {}),
        })),
    };
}

describe('createBrowserImageExportCapability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/sample.tiff',
        );
        browserDocumentStoreMock.replaceWithHandleBackedDocument.mockResolvedValue(undefined);
        saveBlobToPickerOrDownloadMock.mockResolvedValue({
            canceled: false,
            fileName: 'page-1.png',
            handle: null,
        });
        saveBytesToPickerOrDownloadMock.mockResolvedValue({
            canceled: false,
            fileName: 'sample.tiff',
            handle: null,
        });
        pickSaveTargetMock.mockImplementation(async (options: {suggestedName: string}) => ({
            canceled: false,
            fileName: options.suggestedName,
            handle: null,
        }));
        const mockDocument = { createElement: (tagName: string) => {
            if (tagName !== 'canvas') {
                throw new Error(`Unexpected element request: ${tagName}`);
            }
            return createCanvas();
        }};
        vi.stubGlobal('document', mockDocument);
    });

    it('keeps the full browser multi-page TIFF directory chain intact past the legacy UTIF header limit', async () => {
        const fakePdfDocument = createFakePdfDocument(120);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        const result = await capability.exportPdfToMultiPageTiff(
            'browser://documents/work/sample.pdf',
        );

        expect(result).toEqual({
            success: true,
            outputPath: 'browser://documents/output/sample.tiff',
        });
        expect(saveBytesToPickerOrDownloadMock).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.touchRecentFile).toHaveBeenCalledWith(
            'browser://documents/output/sample.tiff',
        );

        const savedBytes = saveBytesToPickerOrDownloadMock.mock.calls[0]?.[0];
        expect(savedBytes).toBeInstanceOf(Uint8Array);
        if (!(savedBytes instanceof Uint8Array)) {
            throw new Error('Expected TIFF export to save raw TIFF bytes');
        }

        expect(countTiffDirectories(savedBytes)).toBe(120);

        const ifds = UTIF.decode(savedBytes);
        expect(ifds).toHaveLength(120);
        expect(ifds[0]?.t273?.[0] ?? 0).toBeGreaterThan(20_000);

        UTIF.decodeImage(savedBytes, ifds[119]!);
        const lastRgba = UTIF.toRGBA8(ifds[119]!);
        expect(Array.from(lastRgba.slice(0, 4))).toEqual([
            119,
            0,
            0,
            255,
        ]);
    });

    it('stores PNG exports as handle-backed outputs when the browser picker returns a file handle', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });
        saveBytesToPickerOrDownloadMock.mockResolvedValue({
            canceled: false,
            fileName: 'page-1.png',
            handle: { name: 'page-1.png' } as FileSystemFileHandle,
        });
        saveBlobToPickerOrDownloadMock.mockResolvedValue({
            canceled: false,
            fileName: 'page-1.png',
            handle: { name: 'page-1.png' } as FileSystemFileHandle,
        });
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/page-1.png',
        );

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        const result = await capability.exportPdfToImages(
            'browser://documents/work/sample.pdf',
            [1],
        );

        expect(result).toEqual({
            success: true,
            outputPaths: ['browser://documents/output/page-1.png'],
        });
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledWith(
            'page-1.png',
            expect.objectContaining({ byteLength: 0 }),
            expect.objectContaining({
                mimeType: 'image/png',
                saveHandle: expect.objectContaining({ name: 'page-1.png' }),
                storageMode: 'handle',
            }),
        );
        expect(saveBlobToPickerOrDownloadMock).toHaveBeenCalledTimes(1);
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.replaceWithHandleBackedDocument).toHaveBeenCalledWith(
            'browser://documents/output/page-1.png',
            expect.objectContaining({
                fileSize: 1,
                saveHandle: expect.objectContaining({ name: 'page-1.png' }),
                saveName: 'page-1.png',
            }),
        );
    });

    it('fails PNG export when selected pages resolve to no valid PDF pages', async () => {
        const fakePdfDocument = createFakePdfDocument(2);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        const result = await capability.exportPdfToImages(
            'browser://documents/work/sample.pdf',
            [
                0,
                3,
            ],
        );

        expect(result).toEqual({
            success: false,
            canceled: true,
        });
        expect(fakePdfDocument.destroy).toHaveBeenCalledTimes(1);
        expect(fakePdfDocument.getPage).not.toHaveBeenCalled();
        expect(saveBlobToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.createStoredDocument).not.toHaveBeenCalled();
    });
});
