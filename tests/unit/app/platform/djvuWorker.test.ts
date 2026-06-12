import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    stat: vi.fn(),
    read: vi.fn(),
    readRange: vi.fn(),
    loadDjvuJs: vi.fn(),
    createDocument: vi.fn(),
    terminate: vi.fn(),
    unload: vi.fn(),
    nativeGetPageSizes: vi.fn(),
    nativeRenderPagePreview: vi.fn(),
}));

vi.mock('@app/platform/browser-api/djvujsLoader', () => ({loadDjvuJs: mocks.loadDjvuJs}));

vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_DOCUMENT_CHUNK_SIZE: 4 * 1024 * 1024,
    browserDocumentStore: {
        stat: mocks.stat,
        read: mocks.read,
        readRange: mocks.readRange,
        unload: mocks.unload,
    },
    isBrowserDocumentRef: (ref: string) => ref.startsWith('browser://documents/'),
}));

describe('createDjvuWorkerFromPath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        mocks.stat.mockResolvedValue({size: 3});
        mocks.read.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.loadDjvuJs.mockResolvedValue({Worker: class {
            public createDocument = mocks.createDocument;
            public terminate = mocks.terminate;
        }});
        mocks.createDocument.mockResolvedValue(undefined);
        mocks.nativeGetPageSizes.mockResolvedValue([{
            width: 100,
            height: 200,
            dpi: 300,
        }]);
        mocks.nativeRenderPagePreview.mockResolvedValue({
            bytes: new Uint8Array([
                137,
                80,
                78,
                71,
            ]),
            width: 100,
            height: 200,
        });
    });

    it('reads DjVu bytes through the active platform document capability', async () => {
        const { createDjvuWorkerFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');

        await createDjvuWorkerFromPath('/Users/test/book.djvu');

        expect(mocks.stat).toHaveBeenCalledWith('/Users/test/book.djvu');
        expect(mocks.read).toHaveBeenCalledWith('/Users/test/book.djvu');
        expect(mocks.createDocument).toHaveBeenCalledWith(
            new Uint8Array([
                1,
                2,
                3,
            ]).buffer,
            {},
        );
        expect(mocks.unload).not.toHaveBeenCalled();
    });

    it('still unloads transient browser document refs after creating the worker', async () => {
        const { createDjvuWorkerFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const ref = 'browser://documents/source/book.djvu';

        await createDjvuWorkerFromPath(ref);

        expect(mocks.stat).toHaveBeenCalledWith(ref);
        expect(mocks.read).toHaveBeenCalledWith(ref);
        expect(mocks.unload).toHaveBeenCalledWith(ref);
    });

    it('terminates the worker and unloads browser document refs if document creation fails', async () => {
        const { createDjvuWorkerFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const ref = 'browser://documents/source/broken.djvu';
        mocks.createDocument.mockRejectedValue(new Error('decode failed'));

        await expect(createDjvuWorkerFromPath(ref)).rejects.toThrow('decode failed');

        expect(mocks.terminate).toHaveBeenCalledTimes(1);
        expect(mocks.unload).toHaveBeenCalledWith(ref);
    });

    it('aborts browser DjVu reads before creating the worker document', async () => {
        const { createDjvuWorkerFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const ref = 'browser://documents/source/large.djvu';
        const controller = new AbortController();
        mocks.stat.mockResolvedValue({size: (4 * 1024 * 1024) + 1});
        mocks.readRange.mockImplementation(async () => {
            controller.abort();
            return new Uint8Array([1]);
        });

        await expect(createDjvuWorkerFromPath(ref, { signal: controller.signal }))
            .rejects
            .toThrow('DjVu conversion canceled');

        expect(mocks.readRange).toHaveBeenCalledTimes(1);
        expect(mocks.createDocument).not.toHaveBeenCalled();
        expect(mocks.terminate).toHaveBeenCalled();
        expect(mocks.unload).toHaveBeenCalledWith(ref);
    });

    it('uses native desktop page previews without reading the full DjVu into djvu.js', async () => {
        vi.stubGlobal('window', { electronAPI: { djvu: {
            getPageSizes: mocks.nativeGetPageSizes,
            renderPagePreview: mocks.nativeRenderPagePreview,
        } } });
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:native-preview'),
            revokeObjectURL: vi.fn(),
        });
        vi.stubGlobal('Blob', class {
            public readonly parts: unknown[];
            public readonly options: unknown;

            constructor(parts: unknown[], options: unknown) {
                this.parts = parts;
                this.options = options;
            }
        });
        const { createDjvuPagePreviewSourceFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');

        const source = await createDjvuPagePreviewSourceFromPath('/Users/test/book.djvu');
        await expect(source.getPageSizes()).resolves.toEqual([{
            width: 100,
            height: 200,
            dpi: 300,
        }]);
        await expect(source.renderPageObjectUrl(1, { subsample: 2 })).resolves.toEqual({
            objectUrl: 'blob:native-preview',
            renderedPx: 100,
        });

        expect(mocks.loadDjvuJs).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.read).not.toHaveBeenCalled();
        expect(mocks.nativeRenderPagePreview).toHaveBeenCalledWith('/Users/test/book.djvu', 1, { subsample: 2 });
    });
});
