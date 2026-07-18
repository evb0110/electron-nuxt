import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

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
    nativeSearchText: vi.fn(),
    nativeCancelTextSearch: vi.fn(),
    nativeOnTextSearchProgress: vi.fn(),
    getPagesSizes: vi.fn(),
    getPage: vi.fn(),
    createPngObjectUrlRun: vi.fn(),
    revokeObjectURL: vi.fn(),
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

interface IDjvuPreviewSourceForTest {
    cancelPagePreview(pageNumber: number, requestId?: string): void;
    renderPageObjectUrl(pageNumber: number, options?: {
        previewRequestId?: string;
        targetWidthPx?: number
    }): Promise<{
        objectUrl: string;
        renderedPx: number;
    }>;
    revokeObjectURL(url: string): void;
    terminate(): void;
    getPageSizes?(): Promise<Array<{
        height: number;
        width: number;
    }>>;
    searchText?(request: {
        requestId: string;
        pageCount: number;
        query: string;
        matchOptions: {
            matchCase: boolean;
            wholeWord: boolean;
            useRegex: boolean
        };
        signal: AbortSignal;
        onProgress?: (progress: {
            requestId: string;
            processed: number;
            total: number
        }) => void;
    }): Promise<{
        results: unknown[];
        truncated: boolean
    }>;
}

function stubScaledPreviewDom() {
    vi.stubGlobal('Image', class {
        public onload: (() => void) | null = null;
        public onerror: (() => void) | null = null;

        set src(_url: string) {
            queueMicrotask(() => this.onload?.());
        }
    });
    vi.stubGlobal('document', {createElement: createScaledPreviewElement});
}

function createScaledPreviewElement(tagName: string) {
    if (tagName !== 'canvas') {
        return {};
    }
    return {
        width: 0,
        height: 0,
        getContext: () => ({
            drawImage: vi.fn(),
            imageSmoothingEnabled: false,
            imageSmoothingQuality: 'low',
        }),
        toBlob: (callback: (blob: Blob | null) => void) => {
            callback(new Blob([new Uint8Array([1])], { type: 'image/png' }));
        },
    };
}

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
            public doc = {
                getPage: mocks.getPage,
                getPagesSizes: () => ({run: mocks.getPagesSizes}),
            };
            public revokeObjectURL = mocks.revokeObjectURL;
            public terminate = mocks.terminate;
        }});
        mocks.createDocument.mockResolvedValue(undefined);
        mocks.getPagesSizes.mockResolvedValue([{
            width: 100,
            height: 200,
        }]);
        mocks.getPage.mockImplementation((pageNumber: number) => ({createPngObjectUrl: () => ({run: () => mocks.createPngObjectUrlRun(pageNumber)})}));
        mocks.createPngObjectUrlRun.mockImplementation(async (pageNumber: number) => ({
            height: 200,
            url: `blob:fallback-page-${pageNumber}`,
            width: 100,
        }));
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
        mocks.nativeSearchText.mockResolvedValue({
            results: [],
            truncated: false,
        });
        mocks.nativeCancelTextSearch.mockResolvedValue({canceled: true});
        mocks.nativeOnTextSearchProgress.mockReturnValue(() => undefined);
    });

    it('caps browser same-page search progress batches at the shared contract limit', async () => {
        const {searchDjvuWorkerText} =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const progress = vi.fn();
        const text = Array.from({length: 130}, () => 'hit').join(' ');
        const worker = {doc: {
            getPagesSizes: () => ({run: async () => [{
                width: 100,
                height: 200,
            }]}),
            getPage: () => ({
                getText: () => ({run: async () => text}),
                getNormalizedTextZones: () => ({run: async () => null}),
            }),
        }};

        const response = await searchDjvuWorkerText(worker as never, {
            requestId: 'browser-batched-search',
            pageCount: 1,
            query: 'hit',
            matchOptions: {
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            },
            signal: new AbortController().signal,
            onProgress: progress,
        });

        expect(response.results).toHaveLength(130);
        expect(progress.mock.calls.map(call => call[0].results.length)).toEqual([
            64,
            64,
            2,
        ]);
        expect(progress.mock.calls.map(call => call[0].resultsStartIndex)).toEqual([
            0,
            64,
            128,
        ]);
        expect(progress.mock.calls.every(call => (
            call[0].processed === 1
            && call[0].results.length <= 64
        ))).toBe(true);
    });

    it('rejects a browser DjVu page whose searchable text exceeds the interactive budget', async () => {
        const {searchDjvuWorkerText} =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const worker = {doc: {
            getPagesSizes: () => ({run: async () => [{
                width: 100,
                height: 200,
            }]}),
            getPage: () => ({
                getText: () => ({run: async () => 'x'.repeat(8 * 1024 * 1024 + 1)}),
                getNormalizedTextZones: () => ({run: async () => null}),
            }),
        }};

        await expect(searchDjvuWorkerText(worker as never, {
            requestId: 'oversized-page-text',
            pageCount: 1,
            query: 'x',
            matchOptions: {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
            signal: new AbortController().signal,
        })).rejects.toThrow('page text exceeds');
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

    it('prefers desktop documentFiles over legacy documents for desktop paths', async () => {
        const bytes = new Uint8Array([
            4,
            5,
            6,
        ]);
        const documentFiles = {
            statFile: vi.fn(async () => ({size: bytes.byteLength})),
            readFile: vi.fn(async () => bytes),
            readFileRange: vi.fn(async () => {
                throw new Error('split readFileRange should not be used for small files');
            }),
        };
        const legacyDocuments = {
            statFile: vi.fn(async () => {
                throw new Error('legacy statFile should not be used');
            }),
            readFile: vi.fn(async () => {
                throw new Error('legacy readFile should not be used');
            }),
            readFileRange: vi.fn(async () => {
                throw new Error('legacy readFileRange should not be used');
            }),
        };
        vi.stubGlobal('window', { electronAPI: createElectronPlatformApiFixture({
            documentFiles,
            documents: legacyDocuments,
        }) });
        const { createDjvuWorkerFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');

        await createDjvuWorkerFromPath('/Users/test/desktop-book.djvu');

        expect(documentFiles.statFile).toHaveBeenCalledWith('/Users/test/desktop-book.djvu');
        expect(documentFiles.readFile).toHaveBeenCalledWith('/Users/test/desktop-book.djvu');
        expect(documentFiles.readFileRange).not.toHaveBeenCalled();
        expect(legacyDocuments.statFile).not.toHaveBeenCalled();
        expect(legacyDocuments.readFile).not.toHaveBeenCalled();
        expect(legacyDocuments.readFileRange).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.read).not.toHaveBeenCalled();
        expect(mocks.readRange).not.toHaveBeenCalled();
        expect(mocks.createDocument).toHaveBeenCalledWith(bytes.buffer, {});
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

    it('rejects oversized DjVu allocations before requesting ranges', async () => {
        const { createDjvuWorkerFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const ref = 'browser://documents/source/oversized.djvu';
        mocks.stat.mockResolvedValue({size: (192 * 1024 * 1024) + 1});

        await expect(createDjvuWorkerFromPath(ref))
            .rejects
            .toThrow('Browser DjVu processing is limited to 192MB source files');
        expect(mocks.readRange).not.toHaveBeenCalled();
        expect(mocks.createDocument).not.toHaveBeenCalled();
        expect(mocks.terminate).toHaveBeenCalledOnce();
        expect(mocks.unload).toHaveBeenCalledWith(ref);
    });

    it('uses djvu.js previews for ordinary desktop DjVu files to match web rendering quality', async () => {
        const bytes = new Uint8Array([
            4,
            5,
            6,
        ]);
        const documentFiles = {
            statFile: vi.fn(async () => ({size: bytes.byteLength})),
            readFile: vi.fn(async () => bytes),
            readFileRange: vi.fn(async () => {
                throw new Error('split readFileRange should not be used for small files');
            }),
        };
        vi.stubGlobal('window', { electronAPI: createElectronPlatformApiFixture({
            documentFiles,
            djvu: {
                getPageSizes: mocks.nativeGetPageSizes,
                renderPagePreview: mocks.nativeRenderPagePreview,
            },
        }) });
        const { createDjvuPagePreviewSourceFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');

        const source = await createDjvuPagePreviewSourceFromPath('/Users/test/book.djvu');
        await expect(source.getPageSizes()).resolves.toEqual([{
            width: 100,
            height: 200,
        }]);
        await expect(source.renderPageObjectUrl(1, { subsample: 2 })).resolves.toEqual({
            objectUrl: 'blob:fallback-page-1',
            renderedPx: 100,
        });

        expect(mocks.loadDjvuJs).toHaveBeenCalledTimes(1);
        expect(documentFiles.statFile).toHaveBeenCalledWith('/Users/test/book.djvu');
        expect(documentFiles.readFile).toHaveBeenCalledWith('/Users/test/book.djvu');
        expect(mocks.nativeGetPageSizes).not.toHaveBeenCalled();
        expect(mocks.nativeRenderPagePreview).not.toHaveBeenCalled();
    });

    it('uses native desktop page previews when reading the full DjVu into djvu.js is unavailable', async () => {
        vi.stubGlobal('window', { electronAPI: createElectronPlatformApiFixture({ djvu: {
            getPageSizes: mocks.nativeGetPageSizes,
            renderPagePreview: mocks.nativeRenderPagePreview,
        } }) });
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
        expect(mocks.nativeRenderPagePreview).toHaveBeenCalledWith('/Users/test/book.djvu', 1, {
            previewRequestId: 'native-preview:1:1',
            subsample: 2,
        });
    });

    it('uses native desktop page previews for huge desktop DjVu files', async () => {
        const documentFiles = {
            statFile: vi.fn(async () => ({size: 100 * 1024 * 1024})),
            readFile: vi.fn(async () => new Uint8Array([1])),
            readFileRange: vi.fn(async () => new Uint8Array([1])),
        };
        vi.stubGlobal('window', { electronAPI: createElectronPlatformApiFixture({
            documentFiles,
            djvu: {
                getPageSizes: mocks.nativeGetPageSizes,
                renderPagePreview: mocks.nativeRenderPagePreview,
            },
        }) });
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

        const source = await createDjvuPagePreviewSourceFromPath('/Users/test/huge.djvu');
        await expect(source.renderPageObjectUrl(1, { subsample: 2 })).resolves.toEqual({
            objectUrl: 'blob:native-preview',
            renderedPx: 100,
        });

        expect(mocks.loadDjvuJs).not.toHaveBeenCalled();
        expect(documentFiles.readFile).not.toHaveBeenCalled();
        expect(documentFiles.readFileRange).not.toHaveBeenCalled();
        expect(mocks.nativeRenderPagePreview).toHaveBeenCalled();
    });

    it('uses one native full-document search for a huge DjVu and forwards filtered progress', async () => {
        const documentFiles = {
            statFile: vi.fn(async () => ({size: 100 * 1024 * 1024})),
            readFile: vi.fn(),
            readFileRange: vi.fn(),
        };
        let emitProgress: ((progress: {
            requestId: string;
            processed: number;
            total: number;
        }) => void) | undefined;
        mocks.nativeOnTextSearchProgress.mockImplementation((callback) => {
            emitProgress = callback;
            return () => undefined;
        });
        mocks.nativeSearchText.mockImplementation(async () => {
            emitProgress?.({
                requestId: 'native-search',
                processed: 8,
                total: 431,
            });
            return {
                results: [],
                truncated: false,
            };
        });
        vi.stubGlobal('window', {electronAPI: createElectronPlatformApiFixture({
            documentFiles,
            djvu: {
                getPageSizes: mocks.nativeGetPageSizes,
                renderPagePreview: mocks.nativeRenderPagePreview,
                searchText: mocks.nativeSearchText,
                cancelTextSearch: mocks.nativeCancelTextSearch,
                onTextSearchProgress: mocks.nativeOnTextSearchProgress,
            },
        })});
        const {createDjvuPagePreviewSourceFromPath} =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const source = await createDjvuPagePreviewSourceFromPath('/Users/test/huge.djvu') as IDjvuPreviewSourceForTest;
        const onProgress = vi.fn();

        await expect(source.searchText!({
            requestId: 'native-search',
            pageCount: 431,
            query: 'needle',
            matchOptions: {
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            },
            signal: new AbortController().signal,
            onProgress,
        })).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(mocks.nativeSearchText).toHaveBeenCalledOnce();
        expect(mocks.nativeSearchText).toHaveBeenCalledWith('/Users/test/huge.djvu', 'needle', {
            requestId: 'native-search',
            pageCount: 431,
            matchCase: false,
            wholeWord: true,
            useRegex: false,
        });
        expect(onProgress).toHaveBeenCalledWith({
            requestId: 'native-search',
            processed: 8,
            total: 431,
        });
        expect(documentFiles.readFile).not.toHaveBeenCalled();
        expect(documentFiles.readFileRange).not.toHaveBeenCalled();
    });

    it('keeps native streaming search when a small desktop DjVu uses the browser raster renderer', async () => {
        const documentFiles = {
            statFile: vi.fn(async () => ({size: 3})),
            readFile: vi.fn(async () => new Uint8Array([
                1,
                2,
                3,
            ])),
            readFileRange: vi.fn(),
        };
        let emitProgress: ((progress: {
            requestId: string;
            processed: number;
            total: number;
        }) => void) | undefined;
        mocks.nativeOnTextSearchProgress.mockImplementation((callback) => {
            emitProgress = callback;
            return () => undefined;
        });
        mocks.nativeSearchText.mockImplementation(async () => {
            emitProgress?.({
                requestId: 'small-native-search',
                processed: 1,
                total: 1,
            });
            return {
                results: [],
                truncated: false,
            };
        });
        vi.stubGlobal('window', {electronAPI: createElectronPlatformApiFixture({
            documentFiles,
            djvu: {
                getPageSizes: mocks.nativeGetPageSizes,
                renderPagePreview: mocks.nativeRenderPagePreview,
                searchText: mocks.nativeSearchText,
                cancelTextSearch: mocks.nativeCancelTextSearch,
                onTextSearchProgress: mocks.nativeOnTextSearchProgress,
            },
        })});
        const {createDjvuPagePreviewSourceFromPath} =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const source = await createDjvuPagePreviewSourceFromPath('/Users/test/small.djvu') as IDjvuPreviewSourceForTest;
        const onProgress = vi.fn();

        await expect(source.renderPageObjectUrl(1)).resolves.toEqual({
            objectUrl: 'blob:fallback-page-1',
            renderedPx: 100,
        });
        await expect(source.searchText!({
            requestId: 'small-native-search',
            pageCount: 1,
            query: 'needle',
            matchOptions: {
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            },
            signal: new AbortController().signal,
            onProgress,
        })).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(mocks.loadDjvuJs).toHaveBeenCalledOnce();
        expect(mocks.createPngObjectUrlRun).toHaveBeenCalledWith(1);
        expect(mocks.nativeRenderPagePreview).not.toHaveBeenCalled();
        expect(mocks.nativeSearchText).toHaveBeenCalledWith('/Users/test/small.djvu', 'needle', {
            requestId: 'small-native-search',
            pageCount: 1,
            matchCase: false,
            wholeWord: true,
            useRegex: false,
        });
        expect(onProgress).toHaveBeenCalledWith({
            requestId: 'small-native-search',
            processed: 1,
            total: 1,
        });
    });

    it('keeps concurrent browser fallback consumers of the same page independent', async () => {
        mocks.getPagesSizes.mockResolvedValue([
            {
                width: 100,
                height: 200,
            },
            {
                width: 100,
                height: 200,
            },
        ]);
        const firstRender = Promise.withResolvers<{
            height: number;
            url: string;
            width: number;
        }>();
        mocks.createPngObjectUrlRun.mockImplementation((pageNumber: number) => {
            if (pageNumber === 2) {
                return firstRender.promise;
            }
            return Promise.resolve({
                height: 200,
                url: `blob:fallback-page-${pageNumber}`,
                width: 100,
            });
        });
        const { createDjvuPagePreviewSourceFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const source = await createDjvuPagePreviewSourceFromPath('browser://documents/source/book.djvu');

        const blockingRender = source.renderPageObjectUrl(2, { previewRequestId: 'blocker' });
        await vi.waitFor(() => expect(mocks.createPngObjectUrlRun).toHaveBeenCalledWith(2));
        const viewportRender = source.renderPageObjectUrl(1, { previewRequestId: 'page-1-viewport' });
        const thumbnailRender = source.renderPageObjectUrl(1, { previewRequestId: 'page-1-thumbnail' });

        firstRender.resolve({
            height: 200,
            url: 'blob:fallback-page-2',
            width: 100,
        });

        await expect(blockingRender).resolves.toEqual({
            objectUrl: 'blob:fallback-page-2',
            renderedPx: 100,
        });
        await expect(viewportRender).resolves.toEqual({
            objectUrl: 'blob:fallback-page-1',
            renderedPx: 100,
        });
        await expect(thumbnailRender).resolves.toEqual({
            objectUrl: 'blob:fallback-page-1',
            renderedPx: 100,
        });

        expect(mocks.getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([
            2,
            1,
            1,
        ]);
        expect(mocks.createPngObjectUrlRun.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([
            2,
            1,
            1,
        ]);
    });

    it('rejects browser DjVu documents above the interactive page-count cap', async () => {
        mocks.getPagesSizes.mockResolvedValue(Array.from(
            {length: 10_001},
            () => ({
                width: 100,
                height: 200,
            }),
        ));
        const { createDjvuPagePreviewSourceFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const source = await createDjvuPagePreviewSourceFromPath(
            'browser://documents/source/too-many-pages.djvu',
        ) as IDjvuPreviewSourceForTest;

        await expect(source.getPageSizes!()).rejects.toThrow('capped at 10000 pages');
        source.terminate();
    });

    it('revokes stale browser fallback preview URLs created after cancellation', async () => {
        const { createDjvuPagePreviewSourceFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');
        const source = await createDjvuPagePreviewSourceFromPath('browser://documents/source/book.djvu');
        mocks.createPngObjectUrlRun.mockImplementation(async () => {
            source.cancelPagePreview(1, 'stale');
            return {
                height: 200,
                url: 'blob:fallback-page-1',
                width: 100,
            };
        });

        const staleRender = source.renderPageObjectUrl(1, { previewRequestId: 'stale' });

        await expect(staleRender).rejects.toThrow('DjVu conversion canceled');

        expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:fallback-page-1');
    });

    it('tracks scaled browser fallback preview URLs as window-owned', async () => {
        const revokeWindowObjectURL = vi.fn();
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:scaled-preview'),
            revokeObjectURL: revokeWindowObjectURL,
        });
        stubScaledPreviewDom();
        const { createDjvuPagePreviewSourceFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');

        const source = await createDjvuPagePreviewSourceFromPath('browser://documents/source/book.djvu');
        await expect(source.renderPageObjectUrl(1, { targetWidthPx: 50 })).resolves.toEqual({
            objectUrl: 'blob:scaled-preview',
            renderedPx: 50,
        });

        expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:fallback-page-1');

        source.revokeObjectURL('blob:scaled-preview');

        expect(revokeWindowObjectURL).toHaveBeenCalledWith('blob:scaled-preview');
        expect(mocks.revokeObjectURL).not.toHaveBeenCalledWith('blob:scaled-preview');
    });

    it('revokes scaled browser fallback preview URLs when they become stale before return', async () => {
        const revokeWindowObjectURL = vi.fn();
        let source: IDjvuPreviewSourceForTest | null = null;
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => {
                source?.cancelPagePreview(1, 'scaled-stale');
                return 'blob:scaled-stale-preview';
            }),
            revokeObjectURL: revokeWindowObjectURL,
        });
        stubScaledPreviewDom();
        const { createDjvuPagePreviewSourceFromPath } =
            await import('@app/platform/browser-api/createDjvuWorkerFromPath');

        const previewSource = await createDjvuPagePreviewSourceFromPath('browser://documents/source/book.djvu');
        source = previewSource;

        await expect(previewSource.renderPageObjectUrl(1, {
            previewRequestId: 'scaled-stale',
            targetWidthPx: 50,
        }))
            .rejects
            .toThrow('DjVu conversion canceled');

        expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:fallback-page-1');
        expect(revokeWindowObjectURL).toHaveBeenCalledWith('blob:scaled-stale-preview');
    });
});
