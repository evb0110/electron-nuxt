import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { readFileSync } from 'fs';
import { buildPdfSearchExcerpt } from '@pdf-core';
import { cast } from '@tests/helpers/cast';

interface ISearchConformanceCase {
    id: string;
    text: string;
    query: string;
    options?: {
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
    };
    expectedMatches: Array<{
        startOffset: number;
        endOffset: number;
    }>;
}

interface ISearchConformanceCorpus {cases: ISearchConformanceCase[];}

const searchConformanceCorpus = JSON.parse(readFileSync(
    new URL('../../../../packages/contracts/searchConformanceCorpus.json', import.meta.url),
    'utf8',
)) as ISearchConformanceCorpus;

function makeBrowserRevision(documentRef: string, token: string, contentRevision = 1) {
    return {
        version: 1,
        documentRef,
        authority: 'browser-document-store',
        contentRevision,
        mintedAt: 1,
        token,
    };
}

class FakeIdbRequest<T> {
    public result!: T;
    public error: Error | null = null;
    public onsuccess: ((event: Event) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public onupgradeneeded: ((event: Event) => void) | null = null;
}

interface IFakeStoreState {
    records: Map<string, unknown>;
    keyPath: string;
    indexes: Map<string, string>;
}

class FakeIndex {
    public constructor(
        private readonly state: IFakeStoreState,
        private readonly keyPath: string,
    ) {}

    public getAllKeys(value: IDBValidKey) {
        const request = new FakeIdbRequest<IDBValidKey[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.state.records.entries())
                .filter(([
                    ,
                    record,
                ]) => (
                    typeof record === 'object'
                    && record !== null
                    && !Array.isArray(record)
                    && String((record as Record<string, unknown>)[this.keyPath]) === String(value)
                ))
                .map(([key]) => key);
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<IDBValidKey[]>>(request);
    }
}

class FakeObjectStore {
    public readonly indexNames = { contains: (name: string) => this.state.indexes.has(name) };

    public constructor(
        private readonly state: IFakeStoreState,
    ) {}

    public createIndex(name: string, keyPath: string, _options?: { unique?: boolean }) {
        this.state.indexes.set(name, keyPath);
        return cast<IDBIndex>(new FakeIndex(this.state, keyPath));
    }

    public index(name: string) {
        const keyPath = this.state.indexes.get(name);
        if (!keyPath) {
            throw new Error(`Missing fake IndexedDB index: ${name}`);
        }
        return cast<IDBIndex>(new FakeIndex(this.state, keyPath));
    }

    public put(record: unknown, key?: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            const recordKey = key ?? (
                typeof record === 'object' && record !== null && !Array.isArray(record)
                    ? (record as Record<string, unknown>)[this.state.keyPath]
                    : undefined
            );
            if (recordKey === undefined) {
                request.error = new Error('Fake IndexedDB record key is missing');
                request.onerror?.(new Event('error'));
                return;
            }
            this.state.records.set(String(recordKey), record);
            request.result = record;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public get(key: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            request.result = this.state.records.get(String(key));
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public delete(key: IDBValidKey) {
        const request = new FakeIdbRequest<unknown>();
        queueMicrotask(() => {
            this.state.records.delete(String(key));
            request.result = undefined;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown>>(request);
    }

    public clear() {
        const request = new FakeIdbRequest<undefined>();
        queueMicrotask(() => {
            this.state.records.clear();
            request.result = undefined;
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<undefined>>(request);
    }

    public getAll() {
        const request = new FakeIdbRequest<unknown[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.state.records.values());
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<unknown[]>>(request);
    }

    public getAllKeys() {
        const request = new FakeIdbRequest<IDBValidKey[]>();
        queueMicrotask(() => {
            request.result = Array.from(this.state.records.keys());
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBRequest<IDBValidKey[]>>(request);
    }
}

class FakeTransaction {
    public onabort: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public oncomplete: (() => void) | null = null;

    public constructor(private readonly store: FakeObjectStore) {}

    public objectStore(_name: string) {
        queueMicrotask(() => {
            this.oncomplete?.();
        });
        return cast<IDBObjectStore>(this.store);
    }
}

class FakeDatabase {
    private readonly storesByName = new Map<string, IFakeStoreState>();
    private readonly storeNames = new Set<string>();

    public readonly objectStoreNames = { contains: (name: string) => this.storeNames.has(name) };

    public createObjectStore(name: string, options?: { keyPath?: string }) {
        this.storeNames.add(name);
        const store: IFakeStoreState = {
            records: new Map<string, unknown>(),
            keyPath: options?.keyPath ?? 'key',
            indexes: new Map<string, string>(),
        };
        this.storesByName.set(name, store);
        return cast<IDBObjectStore>(new FakeObjectStore(store));
    }

    public transaction(name: string, _mode: IDBTransactionMode) {
        const store = this.storesByName.get(name) ?? {
            records: new Map<string, unknown>(),
            keyPath: 'key',
            indexes: new Map<string, string>(),
        };
        this.storesByName.set(name, store);
        return cast<IDBTransaction>(new FakeTransaction(new FakeObjectStore(store)));
    }

    public getStoreRecords(name: string) {
        const store = this.storesByName.get(name);
        return store?.records ?? new Map<string, unknown>();
    }

    public close() {}

    public rejectNextTransaction(error: Error) {
        const transaction = this.transaction.bind(this);
        this.transaction = ((_name: string, _mode: IDBTransactionMode) => {
            this.transaction = transaction;
            throw error;
        }) as typeof this.transaction;
    }
}

class FakeIndexedDbFactory {
    private readonly databases = new Map<string, FakeDatabase>();

    public open(name: string, _version: number) {
        const request = new FakeIdbRequest<IDBDatabase>();
        queueMicrotask(() => {
            let database = this.databases.get(name);
            const isNew = !database;
            if (!database) {
                database = new FakeDatabase();
                this.databases.set(name, database);
            }

            request.result = cast<IDBDatabase>(database);
            if (isNew) {
                request.onupgradeneeded?.(new Event('upgradeneeded'));
            }
            request.onsuccess?.(new Event('success'));
        });
        return cast<IDBOpenDBRequest>(request);
    }

    public getDatabase(name: string) {
        return this.databases.get(name) ?? null;
    }
}

const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const browserDocumentStoreMock = vi.hoisted(() => ({
    stat: vi.fn(),
    getContentSignature: vi.fn(),
    getDocumentRevision: vi.fn(),
    readRange: vi.fn(),
}));
const browserSearchWorkerClientMock = vi.hoisted(() => ({
    canUseBrowserSearchWorker: vi.fn(() => false),
    createBrowserSearchWorkerRequest: vi.fn(),
    cancelBrowserSearchWorkerRequest: vi.fn(async () => {}),
    BrowserSearchWorkerUnavailableError: class BrowserSearchWorkerUnavailableError extends Error {},
}));
const pdfjsModule = vi.hoisted(() => ({
    version: '5.7.284',
    GlobalWorkerOptions: { workerSrc: undefined as string | undefined },
    PDFDataRangeTransport: function MockPdfDataRangeTransport() {},
    OPS: {
        beginText: 1,
        setFont: 2,
        setTextMatrix: 3,
        showText: 4,
        endText: 5,
    },
    VerbosityLevel: {ERRORS: 3},
    getDocument: vi.fn(),
}));

vi.mock('@app/platform/browser-api/browserYield', () => ({yieldToBrowser: () => yieldToBrowserMock()}));
vi.mock('@app/platform/browser-api/browserSearchWorkerClient', () => ({
    canUseBrowserSearchWorker: () => browserSearchWorkerClientMock.canUseBrowserSearchWorker(),
    createBrowserSearchWorkerRequest: (type: unknown, payload: unknown) =>
        (
            browserSearchWorkerClientMock.createBrowserSearchWorkerRequest as (
                nextType: unknown,
                nextPayload: unknown,
            ) => unknown
        )(type, payload),
    cancelBrowserSearchWorkerRequest: (requestId: unknown) =>
        (
            browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest as (
                nextRequestId: unknown,
            ) => unknown
        )(requestId),
    BrowserSearchWorkerUnavailableError: browserSearchWorkerClientMock.BrowserSearchWorkerUnavailableError,
}));
vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_DOCUMENT_CHUNK_SIZE: 4 * 1024 * 1024,
    browserDocumentStore: browserDocumentStoreMock,
}));
vi.mock('pdfjs-dist', () => pdfjsModule);

describe('createBrowserSearchCapability', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doUnmock('@app/platform/browser-api/browserSearchLimits');
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        yieldToBrowserMock.mockClear();
        browserDocumentStoreMock.stat.mockReset();
        browserDocumentStoreMock.getContentSignature.mockReset();
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-1');
        browserDocumentStoreMock.getDocumentRevision.mockReset();
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:content-token-1'));
        browserDocumentStoreMock.readRange.mockReset();
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReset();
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(false);
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockReset();
        browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest.mockReset();
        browserSearchWorkerClientMock.cancelBrowserSearchWorkerRequest.mockResolvedValue(undefined);
        pdfjsModule.getDocument.mockReset();
    });

    it('returns an observable cache-clear rejection and allows the caller to retry', async () => {
        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { clearSearchCaches } = createBrowserSearchCapability();
        await clearSearchCaches();
        const database = cast<FakeIndexedDbFactory>(indexedDB)
            .getDatabase('evb-browser-search-cache');
        database?.rejectNextTransaction(new Error('clear transaction failed'));

        await expect(clearSearchCaches()).rejects.toThrow('clear transaction failed');
        await expect(clearSearchCaches()).resolves.toBeUndefined();
    });

    it('does not reuse persisted browser page text for geometry-required search runs', async () => {
        const pageTexts = Array.from(
            { length: 30 },
            (_value, index) => `page ${index + 1} foo`,
        );
        const cleanup = vi.fn(async () => {});
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup,
        }));
        const destroy = vi.fn(async () => {});
        const fakePdfDocument = {
            numPages: pageTexts.length,
            getPage,
            destroy,
        };

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        const firstRun = await firstCapability.run('/tmp/test.pdf', 'foo');
        const secondCapability = createBrowserSearchCapability().capability;
        const secondRun = await secondCapability.run('/tmp/test.pdf', 'foo');

        expect(firstRun.results).toHaveLength(30);
        expect(secondRun.results).toHaveLength(30);
        expect(browserDocumentStoreMock.stat).toHaveBeenCalledTimes(8);
        expect(browserDocumentStoreMock.readRange).toHaveBeenCalledTimes(2);
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(yieldToBrowserMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(getPage).toHaveBeenCalledTimes(60);
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(cleanup).toHaveBeenCalledTimes(60);
    });

    it('extracts browser search text from the current PDF bytes without OCR sidecars', async () => {
        const pdfPath = 'browser://documents/test/search.pdf';
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: 'pdf fallback needle'}]})),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const result = await capability.run(pdfPath, 'fallback');

        expect(result.results).toEqual([expect.objectContaining({ pageNumber: 1 })]);
        expect(pdfjsModule.getDocument).toHaveBeenCalledOnce();
        expect(getPage).toHaveBeenCalledOnce();
    });

    it.each(searchConformanceCorpus.cases)('matches the shared conformance corpus case $id in the browser capability', async (fixture) => {
        const pdfPath = `browser://documents/test/${fixture.id}.pdf`;
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: fixture.text}]})),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        browserDocumentStoreMock.getContentSignature.mockResolvedValue(`content-token-${fixture.id}`);

        const { SEARCH_EXCERPT_CONTEXT_CHARS } = await import('@app/platform/browser-api/browserSearchLimits');
        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const result = await capability.run(pdfPath, fixture.query, fixture.options);

        expect(result.results.map(match => ({
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            excerpt: match.excerpt,
        }))).toEqual(fixture.expectedMatches.map(match => ({
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            excerpt: buildPdfSearchExcerpt(
                fixture.text,
                match.startOffset,
                match.endOffset,
                SEARCH_EXCERPT_CONTEXT_CHARS,
            ),
        })));
    });

    it('attaches pdfjs operator-list geometry to browser search results', async () => {
        const glyphs = Array.from('«История»').map((unicode) => ({
            unicode,
            width: unicode === '«' || unicode === '»' ? 200 : 600,
        }));
        const getTextContent = vi.fn(async () => ({items: [{str: 'fallback'}]}));
        const getPage = vi.fn(async () => ({
            view: [
                0,
                0,
                200,
                200,
            ],
            getOperatorList: vi.fn(async () => ({
                fnArray: [
                    pdfjsModule.OPS.beginText,
                    pdfjsModule.OPS.setFont,
                    pdfjsModule.OPS.setTextMatrix,
                    pdfjsModule.OPS.showText,
                    pdfjsModule.OPS.endText,
                ],
                argsArray: [
                    [],
                    [
                        'f1',
                        10,
                    ],
                    [new Float32Array([
                        1,
                        0,
                        0,
                        1,
                        10,
                        50,
                    ])],
                    [glyphs],
                    [],
                ],
            })),
            getTextContent,
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const result = await capability.run('/tmp/test.pdf', 'история');
        const word = result.results[0]?.words?.[0];

        expect(result.results).toHaveLength(1);
        expect(result.results[0]).toMatchObject({
            pageNumber: 1,
            pageWidth: 200,
            pageHeight: 200,
        });
        expect(word).toMatchObject({
            text: 'История',
            y: 140,
            height: 10,
        });
        expect(word?.x).toBeCloseTo(12, 5);
        expect(word?.width).toBeCloseTo(42, 5);
        expect(getTextContent).not.toHaveBeenCalled();
    });

    it('invalidates browser page text caches when same-size document content changes', async () => {
        const firstDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'alpha foo'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };
        const secondDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'beta bar'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-1');
        pdfjsModule.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(firstDocument)})
            .mockReturnValueOnce({promise: Promise.resolve(secondDocument)});

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/test.pdf', 'foo')).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
            truncated: false,
        });
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-2');
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:content-token-2', 2));
        await expect(capability.run('/tmp/test.pdf', 'bar')).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
            truncated: false,
        });

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(firstDocument.getPage).toHaveBeenCalledTimes(1);
        expect(secondDocument.getPage).toHaveBeenCalledTimes(1);
    });

    it('invalidates browser page text caches when only document revision changes', async () => {
        const firstDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'alpha foo'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };
        const secondDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'beta bar'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('same-content-signature');
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:revision-1'));
        pdfjsModule.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(firstDocument)})
            .mockReturnValueOnce({promise: Promise.resolve(secondDocument)});

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/test.pdf', 'foo')).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
            truncated: false,
        });
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async (documentRef: string) =>
            makeBrowserRevision(documentRef, 'drt1:browser:revision-2', 2));
        await expect(capability.run('/tmp/test.pdf', 'bar')).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
            truncated: false,
        });

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(firstDocument.getPage).toHaveBeenCalledTimes(1);
        expect(secondDocument.getPage).toHaveBeenCalledTimes(1);
    });

    it.each([
        [
            'schema version changes',
            (record: Record<string, unknown>) => {
                record.version = 0;
            },
        ],
        [
            'page count mismatches',
            (record: Record<string, unknown>) => {
                record.pageCount = 2;
            },
        ],
        [
            'text byte metadata is corrupt',
            (record: Record<string, unknown>) => {
                record.textBytes = 999;
            },
        ],
    ] as const)('rebuilds persisted browser page text when %s', async (_label, mutateRecord) => {
        const firstDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'alpha foo'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };
        const secondDocument = {
            numPages: 1,
            getPage: vi.fn(async () => ({
                getTextContent: vi.fn(async () => ({items: [{str: 'beta bar'}]})),
                cleanup: vi.fn(async () => {}),
            })),
            destroy: vi.fn(async () => {}),
        };

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(firstDocument)})
            .mockReturnValueOnce({promise: Promise.resolve(secondDocument)});

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        await firstCapability.run('/tmp/test.pdf', 'foo', { pageCount: 1 });

        const indexedDbFactory = cast<FakeIndexedDbFactory>(indexedDB);
        const record = indexedDbFactory
            .getDatabase('evb-browser-search-cache')
            ?.getStoreRecords('document-text')
            .get('/tmp/test.pdf');
        mutateRecord(cast<Record<string, unknown>>(record));

        const secondCapability = createBrowserSearchCapability().capability;
        await expect(secondCapability.run('/tmp/test.pdf', 'bar', { pageCount: 1 })).resolves.toEqual({
            results: [expect.objectContaining({ pageNumber: 1 })],
            truncated: false,
        });

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(secondDocument.getPage).toHaveBeenCalledTimes(1);
    });

    it('clears persisted browser page text indexes on resetCache', async () => {
        const pageTexts = [
            'alpha foo',
            'beta foo',
        ];
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: pageTexts.length,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        await firstCapability.run('/tmp/test.pdf', 'foo');
        await firstCapability.resetCache();

        const secondCapability = createBrowserSearchCapability().capability;
        await secondCapability.run('/tmp/test.pdf', 'foo');

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
    });

    it('prunes persisted browser page text indexes by LRU record limit', async () => {
        let documentIndex = 0;
        pdfjsModule.getDocument.mockImplementation(() => {
            documentIndex += 1;
            const pageText = `document ${documentIndex} foo`;
            return { promise: Promise.resolve({
                numPages: 1,
                getPage: vi.fn(async () => ({
                    getTextContent: vi.fn(async () => ({items: [{str: pageText}]})),
                    cleanup: vi.fn(async () => {}),
                })),
                destroy: vi.fn(async () => {}),
            }) };
        });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        for (let index = 1; index <= 17; index += 1) {
            await capability.warmIndex(`/tmp/lru-${index}.pdf`);
        }

        const indexedDbFactory = cast<FakeIndexedDbFactory>(indexedDB);
        const database = indexedDbFactory.getDatabase('evb-browser-search-cache');
        expect(database?.getStoreRecords('document-text').size).toBe(16);
        expect(database?.getStoreRecords('document-text').has('/tmp/lru-1.pdf')).toBe(false);
        expect(database?.getStoreRecords('document-text').has('/tmp/lru-17.pdf')).toBe(true);
    });

    it('rejects browser search for oversized documents before loading PDF.js', async () => {
        browserDocumentStoreMock.stat.mockResolvedValue({ size: (64 * 1024 * 1024) + 1 });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/huge.pdf', 'foo')).rejects.toThrow('ERR_BROWSER_SEARCH_TOO_LARGE');
        expect(browserDocumentStoreMock.readRange).not.toHaveBeenCalled();
        expect(pdfjsModule.getDocument).not.toHaveBeenCalled();
    });

    it('returns no browser search results for empty queries before loading PDF.js', async () => {
        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/test.pdf', '   ')).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(browserDocumentStoreMock.stat).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.readRange).not.toHaveBeenCalled();
        expect(pdfjsModule.getDocument).not.toHaveBeenCalled();
    });

    it('streams uncached browser search results as direct extraction scans pages', async () => {
        const pageTexts = [
            'alpha sign',
            'beta sign',
        ];
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: pageTexts.length,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const progressUpdates: Array<{
            processed: number;
            resultCount: number;
        }> = [];
        capability.onProgress((progress) => {
            progressUpdates.push({
                processed: progress.processed,
                resultCount: progress.results?.length ?? 0,
            });
        });
        const result = await capability.run('/tmp/test.pdf', 'sign', { requestId: 'stream-search' });

        expect(result.results).toEqual([
            expect.objectContaining({ pageNumber: 1 }),
            expect.objectContaining({ pageNumber: 2 }),
        ]);
        expect(progressUpdates).toContainEqual({
            processed: 1,
            resultCount: 1,
        });
        expect(progressUpdates).toContainEqual({
            processed: 2,
            resultCount: 2,
        });
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerRequest).not.toHaveBeenCalled();
        expect(pdfjsModule.getDocument).toHaveBeenCalledOnce();
        expect(getPage).toHaveBeenCalledTimes(2);
    });

    it('stops direct extraction after truncated streaming search without persisting a full index', async () => {
        vi.doMock('@app/platform/browser-api/browserSearchLimits', () => ({
            SEARCH_EXCERPT_CONTEXT_CHARS: 10,
            SEARCH_RESULT_LIMIT: 2,
        }));
        const pageTexts = [
            'alpha foo',
            'beta foo',
            'gamma foo',
        ];
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => ({items: [{str: pageTexts[pageNumber - 1] ?? ''}]})),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: pageTexts.length,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const firstCapability = createBrowserSearchCapability().capability;
        const firstRun = await firstCapability.run('/tmp/test.pdf', 'foo');
        const secondCapability = createBrowserSearchCapability().capability;
        const secondRun = await secondCapability.run('/tmp/test.pdf', 'foo');

        expect(firstRun).toEqual({
            results: expect.arrayContaining([
                expect.objectContaining({ pageNumber: 1 }),
                expect.objectContaining({ pageNumber: 2 }),
            ]),
            truncated: true,
        });
        expect(secondRun.truncated).toBe(true);
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(2);
        expect(getPage).toHaveBeenCalledTimes(4);

        const indexedDbFactory = cast<FakeIndexedDbFactory>(indexedDB);
        const database = indexedDbFactory.getDatabase('evb-browser-search-cache');
        expect(database?.getStoreRecords('document-text').size ?? 0).toBe(0);
    });

    it('assigns page match indexes without scanning prior results', async () => {
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: 'foo foo foo'}]})),
            cleanup: vi.fn(async () => {}),
        }));

        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const result = await capability.run('/tmp/test.pdf', 'foo');

        expect(result.results.map((match) => match.pageMatchIndex)).toEqual([
            0,
            1,
            2,
        ]);
    });

    it('falls back to direct warm-index extraction when the browser search worker is unavailable', async () => {
        const getPage = vi.fn(async () => ({
            getTextContent: vi.fn(async () => ({items: [{str: 'foo'}]})),
            cleanup: vi.fn(async () => {}),
        }));
        const WorkerUnavailableError = browserSearchWorkerClientMock.BrowserSearchWorkerUnavailableError;

        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockImplementation(() => {
            throw new WorkerUnavailableError('worker unavailable');
        });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 1,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.warmIndex('/tmp/test.pdf')).resolves.toBe(true);
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerRequest).toHaveBeenCalledTimes(1);
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(1);
    });

    it('surfaces browser search worker request failures without direct extraction fallback', async () => {
        browserSearchWorkerClientMock.canUseBrowserSearchWorker.mockReturnValue(true);
        browserSearchWorkerClientMock.createBrowserSearchWorkerRequest.mockImplementation(() => ({
            requestId: 17,
            promise: new Promise((_resolve, reject) => {
                queueMicrotask(() => reject(new Error('worker crashed after request start')));
            }),
        }));
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.warmIndex('/tmp/test.pdf')).rejects.toThrow('worker crashed after request start');
        expect(browserSearchWorkerClientMock.createBrowserSearchWorkerRequest).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.readRange).not.toHaveBeenCalled();
        expect(pdfjsModule.getDocument).not.toHaveBeenCalled();
    });

    it('cancels active direct browser extraction when search is canceled', async () => {
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 });
        browserDocumentStoreMock.readRange.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        let firstPageRead = false;
        let releaseFirstPageRead: () => void = () => {};
        const firstPageReadGate = new Promise<void>((resolve) => {
            releaseFirstPageRead = resolve;
        });
        const getPage = vi.fn(async (pageNumber: number) => ({
            getTextContent: vi.fn(async () => {
                if (pageNumber === 1) {
                    firstPageRead = true;
                    await firstPageReadGate;
                }
                return {items: [{str: `page ${pageNumber} foo`}]};
            }),
            cleanup: vi.fn(async () => {}),
        }));
        pdfjsModule.getDocument.mockReturnValue({ promise: Promise.resolve({
            numPages: 3,
            getPage,
            destroy: vi.fn(async () => {}),
        }) });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/createBrowserSearchCapability');
        const { capability } = createBrowserSearchCapability();
        const runPromise = capability.run('/tmp/test.pdf', 'foo', { requestId: 'cancel-me' });

        await vi.waitFor(() => {
            expect(firstPageRead).toBe(true);
        });
        await capability.cancel('cancel-me');
        releaseFirstPageRead();

        await expect(runPromise).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(getPage.mock.calls.length).toBeLessThan(3);

        const nextRun = await capability.run('/tmp/test.pdf', 'foo', { requestId: 'cancel-me' });

        expect(nextRun.results.length).toBeGreaterThan(0);
    });
});
