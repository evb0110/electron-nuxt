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
    });

    it('reads DjVu bytes through the active platform document capability', async () => {
        const { createDjvuWorkerFromPath } =
            await import('@app/platform/browser-api/djvuWorker');

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
            await import('@app/platform/browser-api/djvuWorker');
        const ref = 'browser://documents/source/book.djvu';

        await createDjvuWorkerFromPath(ref);

        expect(mocks.stat).toHaveBeenCalledWith(ref);
        expect(mocks.read).toHaveBeenCalledWith(ref);
        expect(mocks.unload).toHaveBeenCalledWith(ref);
    });

    it('terminates the worker and unloads browser document refs if document creation fails', async () => {
        const { createDjvuWorkerFromPath } =
            await import('@app/platform/browser-api/djvuWorker');
        const ref = 'browser://documents/source/broken.djvu';
        mocks.createDocument.mockRejectedValue(new Error('decode failed'));

        await expect(createDjvuWorkerFromPath(ref)).rejects.toThrow('decode failed');

        expect(mocks.terminate).toHaveBeenCalledTimes(1);
        expect(mocks.unload).toHaveBeenCalledWith(ref);
    });
});
