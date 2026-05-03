import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    readDocumentBytes: vi.fn(),
    loadDjvuJs: vi.fn(),
    createDocument: vi.fn(),
    unload: vi.fn(),
}));

vi.mock('@app/utils/document-bytes', () => ({readDocumentBytes: mocks.readDocumentBytes}));

vi.mock('@app/platform/browser-api/djvujs-loader', () => ({loadDjvuJs: mocks.loadDjvuJs}));

vi.mock('@app/platform/browser-document-store', () => ({
    browserDocumentStore: { unload: mocks.unload },
    isBrowserDocumentRef: (ref: string) => ref.startsWith('browser://documents/'),
}));

describe('createDjvuWorkerFromPath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readDocumentBytes.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.loadDjvuJs.mockResolvedValue({Worker: class {
            public createDocument = mocks.createDocument;
        }});
        mocks.createDocument.mockResolvedValue(undefined);
    });

    it('reads DjVu bytes through the active platform document capability', async () => {
        const { createDjvuWorkerFromPath } =
            await import('@app/platform/browser-api/djvu-worker');

        await createDjvuWorkerFromPath('/Users/test/book.djvu');

        expect(mocks.readDocumentBytes).toHaveBeenCalledWith('/Users/test/book.djvu');
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
            await import('@app/platform/browser-api/djvu-worker');
        const ref = 'browser://documents/source/book.djvu';

        await createDjvuWorkerFromPath(ref);

        expect(mocks.readDocumentBytes).toHaveBeenCalledWith(ref);
        expect(mocks.unload).toHaveBeenCalledWith(ref);
    });
});
