import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as UTIFModule from 'utif';

type TUtifModule = typeof UTIFModule;

const browserDocumentStoreMock = vi.hoisted(() => ({
    cleanupDetachedDocument: vi.fn(async () => true),
    createStoredDocument: vi.fn(),
    replaceWithHandleBackedDocument: vi.fn(),
    touchRecentFile: vi.fn(async () => {}),
}));
const saveBlobToPickerOrDownloadMock = vi.hoisted(() => vi.fn());
const saveBytesToPickerOrDownloadMock = vi.hoisted(() => vi.fn());
const pickSaveTargetMock = vi.hoisted(() => vi.fn());
const writeBytesToHandleMock = vi.hoisted(() => vi.fn(async (
    _handle: FileSystemFileHandle,
    _data: Uint8Array,
) => {}));
const getDocumentMock = vi.hoisted(() => vi.fn());
const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const createDjvuWorkerFromPathMock = vi.hoisted(() => vi.fn());
const utifLoaderState = vi.hoisted(() => ({
    encoderAccess: vi.fn(),
    encoderError: null as Error | null,
    request: vi.fn(),
}));

vi.mock('@app/platform/browserDocumentStore', () => ({
    browserDocumentStore: browserDocumentStoreMock,
    getBrowserDocumentFileName: () => 'sample.pdf',
}));

vi.mock('@app/platform/browser-api/browserYield', () => ({ yieldToBrowser: yieldToBrowserMock }));

vi.mock('@app/platform/browser-api/createDjvuWorkerFromPath', () => ({createDjvuWorkerFromPath: (...args: unknown[]) =>
    createDjvuWorkerFromPathMock(...args)}));

vi.mock('utif', async importOriginal => {
    utifLoaderState.request();
    const actual = await importOriginal<TUtifModule>();
    return {
        ...actual,
        default: new Proxy(actual.default, {get(target, property, receiver) {
            if (property === 'ttypes') {
                utifLoaderState.encoderAccess();
            }
            if (property === '_writeIFD' && utifLoaderState.encoderError) {
                return () => {
                    throw utifLoaderState.encoderError;
                };
            }
            return Reflect.get(target, property, receiver);
        }}),
    };
});

vi.mock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
    pickSaveTarget: (...args: unknown[]) => pickSaveTargetMock(...args),
    saveBlobToPickerOrDownload: (...args: unknown[]) => saveBlobToPickerOrDownloadMock(...args),
    saveBytesToPickerOrDownload: (...args: unknown[]) => saveBytesToPickerOrDownloadMock(...args),
    writeBytesToHandle: (handle: FileSystemFileHandle, data: Uint8Array) => writeBytesToHandleMock(handle, data),
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

const UTIF = await vi.importActual<TUtifModule>('utif');

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
        getContext: vi.fn(() => ({
            drawImage: vi.fn(),
            getImageData: vi.fn(() => {
                const data = new Uint8ClampedArray([
                    Math.max(0, canvas.currentPageNumber - 1),
                    0,
                    0,
                    255,
                ]);
                return {data};
            }),
        })),
        toBlob: vi.fn((
            callback: (blob: Blob | null) => void,
            type = 'image/png',
        ) => {
            callback(new Blob([new Uint8Array([canvas.currentPageNumber])], {type}));
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
        vi.resetModules();
        vi.clearAllMocks();
        utifLoaderState.encoderError = null;
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

    it('does not load UTIF for JPEG or PNG exports', async () => {
        getDocumentMock
            .mockReturnValueOnce({promise: Promise.resolve(createFakePdfDocument(1))})
            .mockReturnValueOnce({promise: Promise.resolve(createFakePdfDocument(1))});
        pickSaveTargetMock
            .mockResolvedValueOnce({
                canceled: false,
                fileName: 'page-001.jpg',
                handle: null,
            })
            .mockResolvedValueOnce({
                canceled: false,
                fileName: 'page-001.png',
                handle: null,
            });
        saveBytesToPickerOrDownloadMock
            .mockResolvedValueOnce({
                canceled: false,
                fileName: 'page-001.jpg',
                handle: null,
            })
            .mockResolvedValueOnce({
                canceled: false,
                fileName: 'page-001.png',
                handle: null,
            });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        await capability.exportPdfToImages('browser://documents/work/sample.pdf', [1]);
        await capability.exportPdfToImages('browser://documents/work/sample.pdf', [1]);

        expect(utifLoaderState.encoderAccess).not.toHaveBeenCalled();
        expect(utifLoaderState.request).not.toHaveBeenCalled();
    });

    it('shares one UTIF module request across concurrent TIFF exports', async () => {
        getDocumentMock
            .mockReturnValueOnce({promise: Promise.resolve(createFakePdfDocument(1))})
            .mockReturnValueOnce({promise: Promise.resolve(createFakePdfDocument(1))});

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        await Promise.all([
            capability.exportPdfToMultiPageTiff('browser://documents/work/first.pdf'),
            capability.exportPdfToMultiPageTiff('browser://documents/work/second.pdf'),
        ]);

        expect(utifLoaderState.request).toHaveBeenCalledOnce();
        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
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

        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
        expect(result).toEqual({
            success: true,
            outputPath: 'browser://documents/output/sample.tiff',
            outputPaths: ['browser://documents/output/sample.tiff'],
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

    it('destroys the PDF.js document when multi-page TIFF descriptor collection fails', async () => {
        const fakePdfDocument = createFakePdfDocument(2);
        fakePdfDocument.getPage.mockRejectedValueOnce(new Error('page failed'));
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        await expect(capability.exportPdfToMultiPageTiff(
            'browser://documents/work/sample.pdf',
            [1],
        )).rejects.toThrow('page failed');

        expect(fakePdfDocument.destroy).toHaveBeenCalledTimes(1);
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
    });

    it('does not load UTIF when multi-page TIFF export is canceled before encoding', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: true,
            fileName: 'sample.tiff',
            handle: null,
        });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            'browser://documents/work/sample.pdf',
        )).resolves.toEqual({
            success: false,
            canceled: true,
        });

        expect(utifLoaderState.request).not.toHaveBeenCalled();
        expect(utifLoaderState.encoderAccess).not.toHaveBeenCalled();
        expect(fakePdfDocument.destroy).toHaveBeenCalledOnce();
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
    });

    it('destroys the PDF.js document when the TIFF encoder rejects the export', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        utifLoaderState.encoderError = new Error('encoder failed');

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            'browser://documents/work/sample.pdf',
        )).rejects.toThrow('encoder failed');

        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
        expect(fakePdfDocument.destroy).toHaveBeenCalledOnce();
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.createStoredDocument).not.toHaveBeenCalled();
    });

    it('loads UTIF for DjVu TIFF export and terminates the worker', async () => {
        const terminate = vi.fn();
        const revokeObjectURL = vi.fn();
        createDjvuWorkerFromPathMock.mockResolvedValue({
            doc: {
                getPagesSizes: () => ({run: async () => [{
                    width: 1,
                    height: 1,
                }]}),
                getPage: () => ({createPngObjectUrl: () => ({run: async () => ({url: 'blob:djvu-page'})})}),
            },
            revokeObjectURL,
            terminate,
        });
        vi.stubGlobal('fetch', vi.fn(async () => ({
            arrayBuffer: async () => new Uint8Array([1]).buffer,
            ok: true,
        })));
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            close: vi.fn(),
            height: 1,
            width: 1,
        })));

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            'browser://documents/work/sample.djvu',
            [1],
            undefined,
            'djvu',
        )).resolves.toEqual({
            success: true,
            outputPath: 'browser://documents/output/sample.tiff',
            outputPaths: ['browser://documents/output/sample.tiff'],
        });

        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:djvu-page');
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('cleans up the PDF page and resets its canvas when rendering rejects', async () => {
        const canvas = createCanvas();
        const cleanup = vi.fn(async () => {});
        const fakePdfDocument = {
            numPages: 1,
            destroy: vi.fn(async () => {}),
            getPage: vi.fn(async () => ({
                getViewport: vi.fn(() => ({
                    width: 4,
                    height: 5,
                })),
                render: vi.fn(() => ({promise: Promise.reject(new Error('render failed'))})),
                cleanup,
            })),
        };
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToImages(
            'browser://documents/work/sample.pdf',
            [1],
        )).rejects.toThrow('render failed');

        expect(cleanup).toHaveBeenCalledOnce();
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(fakePdfDocument.destroy).toHaveBeenCalledOnce();
    });

    it('cleans up the PDF page and resets its canvas when no 2D context is available', async () => {
        const canvas = createCanvas();
        canvas.getContext.mockReturnValueOnce(null as never);
        const cleanup = vi.fn(async () => {});
        const render = vi.fn();
        const fakePdfDocument = {
            numPages: 1,
            destroy: vi.fn(async () => {}),
            getPage: vi.fn(async () => ({
                getViewport: vi.fn(() => ({
                    width: 4,
                    height: 5,
                })),
                render,
                cleanup,
            })),
        };
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToImages(
            'browser://documents/work/sample.pdf',
            [1],
        )).rejects.toThrow('Canvas 2D context is unavailable');

        expect(render).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(fakePdfDocument.destroy).toHaveBeenCalledOnce();
    });

    it('defaults browser image export to JPEG and stores handle-backed outputs', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.jpg',
            handle: { name: 'page-001.jpg' } as FileSystemFileHandle,
        });
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/page-001.jpg',
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
            outputPaths: ['browser://documents/output/page-001.jpg'],
        });
        expect(pickSaveTargetMock).toHaveBeenCalledWith({
            suggestedName: 'page-001.jpg',
            pickerTypes: [
                {
                    description: 'JPEG Images',
                    accept: { 'image/jpeg': [
                        '.jpg',
                        '.jpeg',
                    ] },
                },
                {
                    description: 'PNG Images',
                    accept: { 'image/png': ['.png'] },
                },
                {
                    description: 'TIFF Images',
                    accept: { 'image/tiff': [
                        '.tif',
                        '.tiff',
                    ] },
                },
            ],
        });
        expect(writeBytesToHandleMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'page-001.jpg' }),
            new Uint8Array([1]),
        );
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledWith(
            'page-001.jpg',
            expect.objectContaining({ byteLength: 0 }),
            expect.objectContaining({
                mimeType: 'image/jpeg',
                saveHandle: expect.objectContaining({ name: 'page-001.jpg' }),
                storageMode: 'handle',
            }),
        );
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.replaceWithHandleBackedDocument).toHaveBeenCalledWith(
            'browser://documents/output/page-001.jpg',
            expect.objectContaining({
                fileSize: 1,
                saveHandle: expect.objectContaining({ name: 'page-001.jpg' }),
                saveName: 'page-001.jpg',
            }),
        );
    });

    it('exports PNG images when the selected file name uses a PNG extension', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.png',
            handle: null,
        });
        saveBytesToPickerOrDownloadMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.png',
            handle: null,
        });
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/page-001.png',
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
            outputPaths: ['browser://documents/output/page-001.png'],
        });
        expect(saveBytesToPickerOrDownloadMock).toHaveBeenCalledWith(
            new Uint8Array([1]),
            expect.objectContaining({
                suggestedName: 'page-001.png',
                mimeType: 'image/png',
            }),
        );
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledWith(
            'page-001.png',
            new Uint8Array([1]),
            expect.objectContaining({
                mimeType: 'image/png',
                saveHandle: null,
            }),
        );
        expect(writeBytesToHandleMock).not.toHaveBeenCalled();
    });

    it('exports single-page TIFF images when the selected file name uses a TIFF extension', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.tiff',
            handle: null,
        });
        saveBytesToPickerOrDownloadMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.tiff',
            handle: null,
        });
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/page-001.tiff',
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
            outputPaths: ['browser://documents/output/page-001.tiff'],
        });

        const savedBytes = saveBytesToPickerOrDownloadMock.mock.calls[0]?.[0];
        expect(savedBytes).toBeInstanceOf(Uint8Array);
        if (!(savedBytes instanceof Uint8Array)) {
            throw new Error('Expected TIFF image export to save raw TIFF bytes');
        }

        expect(saveBytesToPickerOrDownloadMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            suggestedName: 'page-001.tiff',
            mimeType: 'image/tiff',
        }));
        expect(countTiffDirectories(savedBytes)).toBe(1);
        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
        const ifds = UTIF.decode(savedBytes);
        expect(ifds).toHaveLength(1);
        UTIF.decodeImage(savedBytes, ifds[0]!);
        expect(Array.from(UTIF.toRGBA8(ifds[0]!).slice(0, 4))).toEqual([
            0,
            0,
            0,
            255,
        ]);
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledWith(
            'page-001.tiff',
            savedBytes,
            expect.objectContaining({
                mimeType: 'image/tiff',
                saveHandle: null,
            }),
        );
    });

    it('fails image export when selected pages resolve to no valid PDF pages', async () => {
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
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.createStoredDocument).not.toHaveBeenCalled();
    });
});
