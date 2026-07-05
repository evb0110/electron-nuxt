import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
    FakeIndexedDbFactory,
    MemoryStorage,
    cast,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';

const browserPdfCombineWorkerMock = vi.hoisted(() => ({
    canUse: vi.fn(() => false),
    cloneInput: vi.fn((fileName: string, data: Uint8Array) => ({
        fileName,
        data, 
    })),
    run: vi.fn(),
}));
const browserDjvuCapabilityMock = vi.hoisted(() => ({convertToPdf: vi.fn()}));
const utifMock = vi.hoisted(() => ({
    decode: vi.fn(() => []),
    decodeImage: vi.fn(),
    toRGBA8: vi.fn(() => new Uint8Array()),
}));
const pdfjsModule = vi.hoisted(() => ({
    version: '5.7.284',
    GlobalWorkerOptions: {},
    PDFDataRangeTransport: function MockPdfDataRangeTransport() {},
    VerbosityLevel: {ERRORS: 3},
    getDocument: vi.fn(() => ({promise: Promise.resolve({destroy: vi.fn(async () => {})})})),
}));

vi.mock('@app/platform/browser-api/browserPdfCombineWorkerClient', () => ({
    BrowserPdfCombineWorkerUnavailableError: class BrowserPdfCombineWorkerUnavailableError extends Error {},
    canUseBrowserPdfCombineWorker: () => browserPdfCombineWorkerMock.canUse(),
    cloneCombineWorkerInput: (fileName: string, data: Uint8Array) =>
        browserPdfCombineWorkerMock.cloneInput(fileName, data),
    runBrowserPdfCombineWorkerRequest: (type: string, payload: unknown) =>
        browserPdfCombineWorkerMock.run(type, payload),
}));
vi.mock('@app/platform/browser-api/browserDjvuCapability', () => ({browserDjvuCapability: {convertToPdf: browserDjvuCapabilityMock.convertToPdf}}));
vi.mock('utif', () => {
    const decode = (...args: Parameters<typeof utifMock.decode>) => utifMock.decode(...args);
    const decodeImage = (...args: Parameters<typeof utifMock.decodeImage>) => utifMock.decodeImage(...args);
    const toRGBA8 = (...args: Parameters<typeof utifMock.toRGBA8>) => utifMock.toRGBA8(...args);
    return {
        decode,
        decodeImage,
        toRGBA8,
        default: {
            decode,
            decodeImage,
            toRGBA8, 
        },
    };
});
vi.mock('pdfjs-dist', () => pdfjsModule);

async function createPdfBytes() {
    const document = await PDFDocument.create();
    document.addPage();
    return new Uint8Array(await document.save());
}

async function getRevisionOptions(
    browserDocumentStore: { getDocumentRevision: (ref: string) => Promise<{ token: string }> },
    ref: string,
) {
    const revision = await browserDocumentStore.getDocumentRevision(ref);
    return { expectedDocumentRevisionToken: revision.token };
}

function createMockElement(tagName: string) {
    const listeners = new Map<string, () => void>();
    return {
        tagName: tagName.toUpperCase(),
        accept: '',
        multiple: false,
        type: '',
        style: {},
        files: null,
        content: {
            firstChild: null,
            appendChild() {},
        },
        relList: { supports() { return true; } },
        setAttribute() {},
        appendChild() {},
        append() {},
        remove() {},
        click() {
            listeners.get('change')?.();
        },
        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
            if (typeof listener === 'function') {
                listeners.set(type, () => listener(new Event(type)));
            }
        },
        removeEventListener() {},
        getContext() {
            return null;
        },
    };
}

interface ILoadBrowserDocumentsFileCapabilityOptions {
    clearSearchCaches?: (pdfPath?: string) => void;
    inputFiles?: File[];
    windowOverrides?: Record<string, unknown>;
}

interface IBrowserDocumentsTestEntry {
    fileName?: string;
    kind: string;
    saveHandle?: FileSystemFileHandle;
    sourceRef?: string;
    storageMode?: string;
}

interface IBrowserDocumentsTestCreateOptions {
    kind: string;
    mimeType: string;
    retention?: string;
    saveHandle?: FileSystemFileHandle;
    saveKind: string;
    storageMode?: string;
}

interface IBrowserDocumentsTestRevisionOptions { expectedDocumentRevisionToken: string }

interface IBrowserDocumentsTestStore {
    cloneAsWorkingCopy: (sourceRef: string) => Promise<string>;
    createStoredDocument: (
        fileName: string,
        data: Uint8Array,
        options: IBrowserDocumentsTestCreateOptions,
    ) => Promise<string>;
    exists: (ref: string) => Promise<boolean>;
    clearChunkedDocument: (ref: string) => Promise<void>;
    finalizeChunkedDocument: (
        ref: string,
        options: {
            fileSize: number;
            chunkCount: number;
            chunkSize?: number;
            saveName?: string;
        },
    ) => Promise<void>;
    getDocumentRevision: (ref: string) => Promise<{
        token: string;
        contentRevision: number
    }>;
    prepareChunkedDocument: (ref: string, options?: { chunkSize?: number }) => Promise<void>;
    read: (ref: string) => Promise<Uint8Array>;
    readRange: (ref: string, offset: number, length: number) => Promise<Uint8Array>;
    requireEntry: (ref: string) => Promise<IBrowserDocumentsTestEntry>;
    stat: (ref: string) => Promise<{ size: number }>;
    touchRecentFile: (ref: string) => Promise<void>;
    unload: (ref: string) => void;
    write: (ref: string, data: Uint8Array, options?: IBrowserDocumentsTestRevisionOptions) => Promise<boolean>;
    writeForBootstrap: (ref: string, data: Uint8Array, reason: string) => Promise<boolean>;
    writeChunk: (ref: string, index: number, data: Uint8Array) => Promise<void>;
}

interface IBrowserDocumentsTestOpenResult {
    isGenerated?: boolean;
    kind: string;
    originalPath: string;
    workingPath: string;
}

interface IBrowserDocumentsTestCapability {
    cleanupFile: (ref: string) => Promise<void>;
    createWorkingCopyFromData: (fileName: string, data: Uint8Array) => Promise<string>;
    createWorkingCopyFromPath: (sourcePath: string, originalPath?: string) => Promise<string>;
    openCombineDialog: () => Promise<IBrowserDocumentsTestOpenResult | null>;
    openDocumentDirectBatch: (paths: string[], requestId?: string) => Promise<IBrowserDocumentsTestOpenResult | null>;
    openImageDialog: () => Promise<string | null>;
    openFolderDialog: () => Promise<IBrowserDocumentsTestOpenResult | null>;
    openFolderDialogStructured: () => Promise<unknown>;
    openPdfDialog: () => Promise<IBrowserDocumentsTestOpenResult | null>;
    openPdfDirect: (path: string) => Promise<IBrowserDocumentsTestOpenResult | null>;
    recentFiles: { get: () => Promise<IBrowserDocumentsRecentFile[]> };
    registerFilesForOpen: (files: File[]) => Promise<string[]>;
    saveFileStructured: (workingPath: string, options?: IBrowserDocumentsTestRevisionOptions) => Promise<unknown>;
    getDocumentRevision: (workingPath: string) => Promise<{
        token: string;
        contentRevision: number
    }>;
    savePdfAs: (
        workingPath: string,
        options?: unknown,
        revisionOptions?: IBrowserDocumentsTestRevisionOptions,
    ) => Promise<string | null>;
    savePdfData: (workingPath: string, data: Uint8Array, options?: IBrowserDocumentsTestRevisionOptions) => Promise<{
        isValid: boolean;
        errors: string[];
    }>;
    savePdfDataChunks: (
        workingPath: string,
        totalBytes: number,
        chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
        options?: IBrowserDocumentsTestRevisionOptions,
    ) => Promise<{
        isValid: boolean;
        errors: string[];
        warnings: string[];
    }>;
    savePdfDataAs: (
        workingPath: string,
        data: Uint8Array,
        options?: unknown,
        revisionOptions?: IBrowserDocumentsTestRevisionOptions,
    ) => Promise<{
        path: string | null;
        validation: unknown;
    }>;
    showItemInFolder: (path: string) => Promise<boolean>;
    showItemInFolderStructured: (path: string) => Promise<unknown>;
}

interface IBrowserDocumentsRecentFile {
    fileName: string;
    originalPath: string;
}

interface IBrowserBatchProgress {
    elapsedMs: number;
    estimatedRemainingMs: number | null;
    operation: string;
    percent: number;
    processed: number;
    requestId: string;
    total: number;
}

interface IBrowserDocumentsMenuTestCapability { onOpenPdfDirectBatchProgress: (callback: (progress: IBrowserBatchProgress) => void) => () => void }

interface ILoadedBrowserDocumentsFileCapability {
    BROWSER_DOCUMENT_CHUNK_SIZE: number;
    BROWSER_MAX_FULL_READ_BYTES: number;
    browserDocumentStore: IBrowserDocumentsTestStore;
    capability: IBrowserDocumentsTestCapability;
}

interface ICreateCombinedPdfFromPathsOptions { requestId?: string }

type TCreateCombinedPdfFromPaths = (paths: string[], options?: ICreateCombinedPdfFromPathsOptions) => Promise<Uint8Array>;

async function loadCreateCombinedPdfFromPaths(): Promise<TCreateCombinedPdfFromPaths> {
    const module = await import('@app/platform/browser-api/createBrowserDocumentsFileCapability');
    return module.createBrowserCombinedPdfFromPaths;
}

async function loadBrowserDocumentsMenuCapability(): Promise<IBrowserDocumentsMenuTestCapability> {
    const module = await import('@app/platform/browser-api/documentsMenuCapability');
    return module.browserDocumentsMenuCapability;
}

async function loadBrowserDocumentsFileCapability(
    options?: ILoadBrowserDocumentsFileCapabilityOptions,
): Promise<ILoadedBrowserDocumentsFileCapability> {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    vi.stubGlobal('window', {
        localStorage,
        sessionStorage,
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
        ...options?.windowOverrides,
    });
    vi.stubGlobal('document', {
        cookie: '',
        body: {
            append() {},
            appendChild() {},
            removeChild() {},
        },
        createElement(tagName: string) {
            const element = createMockElement(tagName);
            if (tagName === 'input' && options?.inputFiles) {
                (element as { files: File[] | null }).files = options.inputFiles;
            }
            return element;
        },
        createElementNS(_namespace: string, tagName: string) {
            return createMockElement(tagName);
        },
        createTextNode(text: string) {
            return { nodeValue: text };
        },
        createComment(text: string) {
            return { nodeValue: text };
        },
        querySelector() {
            return null;
        },
    });

    const [
        { createBrowserDocumentsFileCapability },
        {
            BROWSER_DOCUMENT_CHUNK_SIZE,
            BROWSER_MAX_FULL_READ_BYTES,
            browserDocumentStore,
        },
    ] = await Promise.all([
        import('@app/platform/browser-api/createBrowserDocumentsFileCapability'),
        import('@app/platform/browserDocumentStore'),
    ]);

    return {
        BROWSER_DOCUMENT_CHUNK_SIZE,
        BROWSER_MAX_FULL_READ_BYTES,
        capability: cast<IBrowserDocumentsTestCapability>(
            createBrowserDocumentsFileCapability({clearSearchCaches: options?.clearSearchCaches ?? (() => {})}),
        ),
        browserDocumentStore: browserDocumentStore as IBrowserDocumentsTestStore,
    };
}

describe('createBrowserDocumentsFileCapability', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        browserPdfCombineWorkerMock.canUse.mockReset();
        browserPdfCombineWorkerMock.canUse.mockReturnValue(false);
        browserPdfCombineWorkerMock.cloneInput.mockClear();
        browserPdfCombineWorkerMock.run.mockReset();
        browserDjvuCapabilityMock.convertToPdf.mockReset();
        utifMock.decode.mockReset();
        utifMock.decode.mockReturnValue([]);
        utifMock.decodeImage.mockReset();
        utifMock.toRGBA8.mockReset();
        utifMock.toRGBA8.mockReturnValue(new Uint8Array());
        pdfjsModule.getDocument.mockReset();
        pdfjsModule.getDocument.mockReturnValue({promise: Promise.resolve({destroy: vi.fn(async () => {})})});
    });

    it('returns typed unsupported results for desktop-only folder actions', async () => {
        const { capability } = await loadBrowserDocumentsFileCapability();

        await expect(capability.openFolderDialog()).resolves.toBeNull();
        await expect(capability.openFolderDialogStructured()).resolves.toEqual({
            ok: false,
            reason: 'requires-native-backend',
            message: 'Folder dialogs require the desktop app.',
        });
        await expect(capability.showItemInFolder('browser://documents/source.pdf')).resolves.toBe(false);
        await expect(capability.showItemInFolderStructured('browser://documents/source.pdf')).resolves.toEqual({
            ok: false,
            reason: 'requires-native-backend',
            message: 'Showing files in a folder requires the desktop app.',
        });
    });

    it('registers browser files for open after ingestion completes', async () => {
        const file = new File([new Uint8Array([
            1,
            2,
            3,
        ])], 'drop.pdf', { type: 'application/pdf' });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();

        const refs = await capability.registerFilesForOpen([file]);

        expect(refs).toHaveLength(1);
        const [ref] = refs;
        expect(ref).toBeDefined();
        await expect(browserDocumentStore.read(ref as string)).resolves.toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
    });

    it('propagates browser file ingestion failures when registering files for open', async () => {
        const file = new File([new Uint8Array([
            1,
            2,
            3,
        ])], 'broken.pdf', { type: 'application/pdf' });
        vi.spyOn(file, 'arrayBuffer').mockRejectedValueOnce(new Error('read failed'));
        const { capability } = await loadBrowserDocumentsFileCapability();

        await expect(capability.registerFilesForOpen([file])).rejects.toThrow('read failed');
    });

    it('cleans up transient source refs via cleanupFile', async () => {
        const clearSearchCaches = vi.fn();
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ clearSearchCaches });
        const ref = await browserDocumentStore.createStoredDocument(
            'picked-image.png',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'image/png',
                kind: 'source',
                retention: 'transient',
                saveKind: 'generic',
            },
        );

        await capability.cleanupFile(ref);

        await expect(browserDocumentStore.exists(ref)).resolves.toBe(false);
        expect(clearSearchCaches).toHaveBeenCalledWith(ref);
    });

    it('exposes browser document revisions through the file capability', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'revision.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);

        const initialRevision = await capability.getDocumentRevision(workingRef);
        await browserDocumentStore.write(sourceRef, new Uint8Array([2]));
        const nextRevision = await capability.getDocumentRevision(workingRef);

        expect(initialRevision.token).toMatch(/^drt1:browser:/u);
        expect(nextRevision.token).not.toBe(initialRevision.token);
        expect(nextRevision.contentRevision).toBe(initialRevision.contentRevision + 1);
    });

    it('exposes DjVu files in the browser combine picker', async () => {
        const showOpenFilePicker = vi.fn(async () => []);
        const { capability } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showOpenFilePicker } });

        await expect(capability.openCombineDialog()).resolves.toBeNull();

        const firstCall = showOpenFilePicker.mock.calls[0] as [{types?: Array<{ accept: Record<string, string[]>; }>;}] | undefined;
        const accept = firstCall?.[0]?.types?.[0]?.accept;
        const expectedDjvuAccept = [
            '.djvu',
            '.djv',
        ];
        const expectedPickerTypes = [expect.objectContaining({accept: expect.objectContaining({'application/octet-stream': expectedDjvuAccept})})];
        expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
        expect(showOpenFilePicker).toHaveBeenCalledWith(expect.objectContaining({
            multiple: true,
            types: expectedPickerTypes,
        }));
        expect(accept?.['application/octet-stream']).toEqual(expectedDjvuAccept);
        expect(accept?.['image/*']).not.toContain('.svgz');
    });

    it('does not expose svgz files in the browser image picker', async () => {
        const showOpenFilePicker = vi.fn(async () => []);
        const { capability } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showOpenFilePicker } });

        await expect(capability.openImageDialog()).resolves.toBeNull();

        const firstCall = showOpenFilePicker.mock.calls[0] as [{types?: Array<{ accept: Record<string, string[]>; }>;}] | undefined;
        const accept = firstCall?.[0]?.types?.[0]?.accept;
        expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
        expect(accept?.['image/*']).not.toContain('.svgz');
    });

    it('does not chain a hidden input picker after denied browser file handles', async () => {
        const pdfBytes = await createPdfBytes();
        const pickedPdf = new File([pdfBytes], 'fallback.pdf', { type: 'application/pdf' });
        const deniedHandle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'denied.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const showOpenFilePicker = vi.fn(async () => [deniedHandle]);
        const { capability } = await loadBrowserDocumentsFileCapability({
            inputFiles: [pickedPdf],
            windowOverrides: { showOpenFilePicker },
        });

        await expect(capability.openPdfDialog()).resolves.toBeNull();
        const fallbackResult = await capability.openPdfDialog();

        expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
        expect(fallbackResult?.kind).toBe('pdf');
    });

    it('rejects oversized browser combine rewrites before reading the input PDFs', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const firstRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const secondRef = await browserDocumentStore.createStoredDocument(
            'second.pdf',
            new Uint8Array([2]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({ size: 20 * 1024 * 1024 });
        const readSpy = vi.spyOn(browserDocumentStore, 'read');

        await expect(createCombinedPdfFromPaths([
            firstRef,
            secondRef,
        ])).rejects.toThrow(
            'Combining documents is unavailable in the browser for inputs larger than 32MB',
        );

        expect(readSpy).not.toHaveBeenCalled();
        statSpy.mockRestore();
        readSpy.mockRestore();
    });

    it('offloads all-PDF combine jobs to the browser worker when available', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const firstRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const secondRef = await browserDocumentStore.createStoredDocument(
            'second.pdf',
            new Uint8Array([
                4,
                5,
                6,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserPdfCombineWorkerMock.run.mockResolvedValue({data: new Uint8Array([
            9,
            8,
            7,
        ])});

        const result = await createCombinedPdfFromPaths([
            firstRef,
            secondRef,
        ]);

        expect(result).toEqual(new Uint8Array([
            9,
            8,
            7,
        ]));
        expect(browserPdfCombineWorkerMock.cloneInput).toHaveBeenCalledTimes(2);
        expect(browserPdfCombineWorkerMock.run).toHaveBeenCalledWith('combinePdfs', {inputs: [
            {
                fileName: 'first.pdf',
                data: new Uint8Array([
                    1,
                    2,
                    3,
                ]), 
            },
            {
                fileName: 'second.pdf',
                data: new Uint8Array([
                    4,
                    5,
                    6,
                ]), 
            },
        ]});
    });

    it('emits browser batch-open progress while combining multiple inputs', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const [
            createCombinedPdfFromPaths,
            browserDocumentsMenuCapability,
        ] = await Promise.all([
            loadCreateCombinedPdfFromPaths(),
            loadBrowserDocumentsMenuCapability(),
        ]);
        const firstRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const secondRef = await browserDocumentStore.createStoredDocument(
            'second.pdf',
            new Uint8Array([
                4,
                5,
                6,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserPdfCombineWorkerMock.run.mockResolvedValue({data: new Uint8Array([
            9,
            8,
            7,
        ])});

        const progressEvents: Array<{
            operation: string;
            requestId: string;
            processed: number;
            total: number;
            percent: number;
            elapsedMs: number;
            estimatedRemainingMs: number | null;
        }> = [];
        const stopListening = browserDocumentsMenuCapability.onOpenPdfDirectBatchProgress((progress) => {
            progressEvents.push(progress);
        });

        try {
            await createCombinedPdfFromPaths(
                [
                    firstRef,
                    secondRef,
                ],
                { requestId: 'browser-batch-1' },
            );
        } finally {
            stopListening();
        }

        expect(progressEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                operation: 'document-open',
                requestId: 'browser-batch-1',
                processed: 1,
                total: 2,
            }),
            expect.objectContaining({
                operation: 'document-open',
                requestId: 'browser-batch-1',
                processed: 2,
                total: 2,
                percent: 100,
            }),
        ]));
    });

    it('offloads supported mixed PDF and raster-image combine jobs to the browser worker', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const imageRef = await browserDocumentStore.createStoredDocument(
            'photo.png',
            new Uint8Array([
                4,
                5,
                6,
            ]),
            {
                mimeType: 'image/png',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserPdfCombineWorkerMock.run.mockResolvedValue({data: new Uint8Array([
            7,
            8,
            9,
        ])});

        const result = await createCombinedPdfFromPaths([
            pdfRef,
            imageRef,
        ]);

        expect(result).toEqual(new Uint8Array([
            7,
            8,
            9,
        ]));
        expect(browserPdfCombineWorkerMock.run).toHaveBeenCalledWith('combinePdfs', {inputs: [
            {
                fileName: 'first.pdf',
                data: new Uint8Array([
                    1,
                    2,
                    3,
                ]),
            },
            {
                fileName: 'photo.png',
                data: new Uint8Array([
                    4,
                    5,
                    6,
                ]), 
            },
        ]});
    });

    it('converts DjVu files before combining mixed browser batches', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const pdfBytes = await createPdfBytes();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            pdfBytes,
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const djvuRef = await browserDocumentStore.createStoredDocument(
            'scan.djvu',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'application/octet-stream',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        let convertedRef: string | null = null;
        browserDjvuCapabilityMock.convertToPdf.mockImplementation(async (_djvuPath: string, outputPath: string) => {
            convertedRef = outputPath;
            await browserDocumentStore.write(outputPath, pdfBytes);
            return {
                success: true,
                pdfPath: outputPath,
            };
        });

        const result = await createCombinedPdfFromPaths([
            pdfRef,
            djvuRef,
        ]);
        const combinedPdf = await PDFDocument.load(result);

        expect(combinedPdf.getPageCount()).toBe(2);
        expect(browserDjvuCapabilityMock.convertToPdf).toHaveBeenCalledWith(
            djvuRef,
            expect.stringMatching(/^browser:\/\/documents\//u),
            {
                subsample: 1,
                preserveBookmarks: true,
            },
        );
        expect(convertedRef).not.toBeNull();
        await expect(browserDocumentStore.exists(convertedRef!)).resolves.toBe(false);
    });

    it('offloads TIFF combine jobs to the browser worker when available', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const tiffRef = await browserDocumentStore.createStoredDocument(
            'scan.tiff',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'image/tiff',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserPdfCombineWorkerMock.run.mockResolvedValue({data: new Uint8Array([
            7,
            8,
            9,
        ])});

        const result = await createCombinedPdfFromPaths([tiffRef]);

        expect(result).toEqual(new Uint8Array([
            7,
            8,
            9,
        ]));
        expect(browserPdfCombineWorkerMock.run).toHaveBeenCalledWith('combinePdfs', {inputs: [{
            fileName: 'scan.tiff',
            data: new Uint8Array([
                1,
                2,
                3,
            ]),
        }]});
    });

    it('keeps unsupported image combine formats on the direct fallback path', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const svgRef = await browserDocumentStore.createStoredDocument(
            'vector.svg',
            new Uint8Array([
                60,
                115,
                118,
                103,
                62,
            ]),
            {
                mimeType: 'image/svg+xml',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);

        await expect(createCombinedPdfFromPaths([svgRef])).rejects.toThrow();
        expect(browserPdfCombineWorkerMock.run).not.toHaveBeenCalled();
    });

    it('cleans up transient combine refs when opening picked browser inputs fails', async () => {
        vi.stubGlobal('crypto', {
            ...(globalThis.crypto ?? {}),
            randomUUID: vi.fn(() => 'open-failure-ref'),
        });
        const brokenPng = new File([new Uint8Array([
            1,
            2,
            3,
        ])], 'broken.png', { type: 'image/png' });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ inputFiles: [brokenPng] });
        const failedRef = 'browser://documents/open-failure-ref/broken.png';

        await expect(capability.openCombineDialog()).rejects.toThrow();
        await expect(browserDocumentStore.exists(failedRef)).resolves.toBe(false);
    });

    it('creates one PDF page per TIFF frame on the direct browser fallback path', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const tinyPngBytes = new Uint8Array([
            137,
            80,
            78,
            71,
            13,
            10,
            26,
            10,
            0,
            0,
            0,
            13,
            73,
            72,
            68,
            82,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            1,
            8,
            6,
            0,
            0,
            0,
            31,
            21,
            196,
            137,
            0,
            0,
            0,
            13,
            73,
            68,
            65,
            84,
            120,
            156,
            99,
            248,
            15,
            4,
            0,
            9,
            251,
            3,
            253,
            160,
            90,
            111,
            167,
            0,
            0,
            0,
            0,
            73,
            69,
            78,
            68,
            174,
            66,
            96,
            130,
        ]);
        const tiffRef = await browserDocumentStore.createStoredDocument(
            'scan.tif',
            new Uint8Array([
                1,
                2,
                3,
            ]),
            {
                mimeType: 'image/tiff',
                kind: 'source',
                saveKind: 'generic',
            },
        );

        utifMock.decode.mockReturnValue([
            {
                width: 2,
                height: 2,
            },
            {
                width: 1,
                height: 3,
            },
        ] as never);
        utifMock.toRGBA8
            .mockReturnValueOnce(new Uint8Array(2 * 2 * 4).fill(255))
            .mockReturnValueOnce(new Uint8Array(1 * 3 * 4).fill(128));

        const putImageData = vi.fn();
        vi.stubGlobal('ImageData', class {
            public constructor(
                public readonly data: Uint8ClampedArray,
                public readonly width: number,
                public readonly height: number,
            ) {}
        });
        vi.stubGlobal('document', {
            cookie: '',
            body: {
                append() {},
                appendChild() {},
                removeChild() {},
            },
            createElement(tagName: string) {
                if (tagName === 'canvas') {
                    return {
                        width: 0,
                        height: 0,
                        getContext() {
                            return { putImageData };
                        },
                        toBlob(callback: (blob: Blob | null) => void) {
                            callback(new Blob([tinyPngBytes], { type: 'image/png' }));
                        },
                    };
                }

                return createMockElement(tagName);
            },
            createElementNS(_namespace: string, tagName: string) {
                return createMockElement(tagName);
            },
            createTextNode(text: string) {
                return { nodeValue: text };
            },
            createComment(text: string) {
                return { nodeValue: text };
            },
            querySelector() {
                return null;
            },
        });

        const result = await createCombinedPdfFromPaths([tiffRef]);
        const document = await PDFDocument.load(result);

        expect(document.getPageCount()).toBe(2);
        expect(utifMock.decode).toHaveBeenCalledTimes(1);
        expect(utifMock.decodeImage).toHaveBeenCalledTimes(2);
        expect(putImageData).toHaveBeenCalledTimes(2);
        expect(browserPdfCombineWorkerMock.run).not.toHaveBeenCalled();
    });

    it('creates transient working copies from raw browser data without durable recents', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await capability.createWorkingCopyFromData(
            'draft.pdf',
            await createPdfBytes(),
        );

        const workingEntry = await browserDocumentStore.requireEntry(workingRef);

        expect(workingEntry.kind).toBe('working');
        expect(workingEntry.sourceRef).toBeUndefined();
        await expect(capability.recentFiles.get()).resolves.toEqual([]);

        await capability.cleanupFile(workingRef);
        await expect(browserDocumentStore.exists(workingRef)).resolves.toBe(false);
    });

    it('does not add direct-batch PDF or DjVu sources to recents when opening a generated PDF', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const pdfBytes = await createPdfBytes();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            pdfBytes,
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const djvuRef = await browserDocumentStore.createStoredDocument(
            'second.djvu',
            new Uint8Array([1]),
            {
                mimeType: 'image/vnd.djvu',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserDjvuCapabilityMock.convertToPdf.mockImplementation(async (_path: string, outputRef: string) => {
            await browserDocumentStore.write(outputRef, pdfBytes);
            return {success: true};
        });

        const result = await capability.openDocumentDirectBatch([
            pdfRef,
            djvuRef,
        ]);

        expect(result).toEqual(expect.objectContaining({
            kind: 'pdf',
            isGenerated: true,
        }));
        await expect(capability.recentFiles.get()).resolves.toEqual([]);
    });

    it('cleans up the original source when cloned working copy snapshots are removed', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const pdfBytes = await createPdfBytes();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            pdfBytes,
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const snapshotRef = await capability.createWorkingCopyFromPath(
            workingRef,
            sourceRef,
        );

        const snapshotEntry = await browserDocumentStore.requireEntry(snapshotRef);

        expect(snapshotEntry.sourceRef).toBe(sourceRef);

        await capability.cleanupFile(snapshotRef);
        await capability.cleanupFile(workingRef);

        await expect(browserDocumentStore.exists(sourceRef)).resolves.toBe(false);
    });

    it('clones chunked working-copy snapshots without forcing a full read', async () => {
        const {
            capability,
            browserDocumentStore,
            BROWSER_MAX_FULL_READ_BYTES,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const oversizedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        oversizedBytes[0] = 37;
        oversizedBytes[1] = 80;
        oversizedBytes[2] = 68;
        oversizedBytes[3] = 70;
        await browserDocumentStore.writeForBootstrap(workingRef, oversizedBytes, 'test-setup');

        const snapshotRef = await capability.createWorkingCopyFromPath(
            workingRef,
            sourceRef,
        );
        const snapshotEntry = await browserDocumentStore.requireEntry(snapshotRef);

        expect(snapshotEntry.storageMode).toBe('chunked');
        expect(snapshotEntry.sourceRef).toBe(sourceRef);
        await expect(browserDocumentStore.stat(snapshotRef)).resolves.toEqual({ size: BROWSER_MAX_FULL_READ_BYTES + 1 });
        await expect(browserDocumentStore.readRange(snapshotRef, 0, 4)).resolves.toEqual(new Uint8Array([
            37,
            80,
            68,
            70,
        ]));
    });

    it('creates source-proxy working copies when reopening a persisted source path', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            await createPdfBytes(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );

        const workingRef = await capability.createWorkingCopyFromPath(sourceRef);
        const workingEntry = await browserDocumentStore.requireEntry(workingRef);

        expect(workingEntry.kind).toBe('working');
        expect(workingEntry.sourceRef).toBe(sourceRef);
        expect(workingEntry.storageMode).toBe('source-proxy');
    });

    it('hydrates legacy handle-backed browser sources during direct open', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const pdfBytes = await createPdfBytes();
        const getFile = vi.fn(async () => new File([pdfBytes], 'legacy.pdf', { type: 'application/pdf' }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'legacy.pdf',
            getFile,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'legacy.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        const result = await capability.openPdfDirect(sourceRef);
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('pdf');

        getFile.mockImplementation(async () => {
            throw new DOMException('Not allowed', 'NotAllowedError');
        });
        browserDocumentStore.unload(sourceRef);

        await expect(browserDocumentStore.read(sourceRef)).resolves.toEqual(pdfBytes);
    });

    it('keeps recent entries when direct browser handle reopen is denied', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'denied.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'denied.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        await browserDocumentStore.touchRecentFile(sourceRef);

        await expect(capability.openPdfDirect(sourceRef)).resolves.toBeNull();
        const recentFiles = await capability.recentFiles.get();
        expect(recentFiles).toEqual([expect.objectContaining({
            originalPath: sourceRef,
            fileName: 'denied.pdf',
        })]);
    });

    it('keeps oversized handle-backed sources lazy during direct open', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const getFile = vi.fn(async () => ({
            size: BROWSER_MAX_FULL_READ_BYTES + 1,
            slice(start?: number, end?: number) {
                const requestedLength = Math.max(0, (end ?? 0) - (start ?? 0));
                return new Blob([new Uint8Array(requestedLength)], { type: 'application/pdf' });
            },
        }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'huge.pdf',
            getFile,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'huge.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        const result = await capability.openPdfDirect(sourceRef);
        const sourceEntry = await browserDocumentStore.requireEntry(sourceRef);
        const workingEntry = result
            ? await browserDocumentStore.requireEntry(result.workingPath)
            : null;

        expect(result?.kind).toBe('pdf');
        expect(sourceEntry.storageMode).toBe('handle');
        expect(workingEntry?.storageMode).toBe('source-proxy');
        expect(workingEntry?.sourceRef).toBe(sourceRef);
    });

    it('streams oversized browser saves to an existing file handle', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const writes: Uint8Array[] = [];
        const savedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        const queryPermission = vi.fn(async () => 'granted' as const);
        const requestPermission = vi.fn(async () => 'granted' as const);
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'large-save.pdf',
            getFile: vi.fn(async () => new File([savedBytes], 'large-save.pdf', { type: 'application/pdf' })),
            queryPermission,
            requestPermission,
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    const chunkBytes = new Uint8Array(chunk);
                    const offset = writes.reduce((sum, current) => sum + current.byteLength, 0);
                    savedBytes.set(chunkBytes, offset);
                    writes.push(chunkBytes);
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'large-save.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const oversizedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        oversizedBytes[0] = 37;
        oversizedBytes[1] = 80;
        oversizedBytes[2] = 68;
        oversizedBytes[3] = 70;
        await browserDocumentStore.writeForBootstrap(workingRef, oversizedBytes, 'test-setup');

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({ ok: true });

        expect(queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(requestPermission).not.toHaveBeenCalled();
        const savedEntry = await browserDocumentStore.requireEntry(sourceRef);
        expect(savedEntry.storageMode).toBe('handle');
        await expect(browserDocumentStore.stat(sourceRef)).resolves.toEqual({ size: BROWSER_MAX_FULL_READ_BYTES + 1 });
        expect(writes.length).toBeGreaterThan(1);
        expect(writes[0]?.slice(0, 4)).toEqual(new Uint8Array([
            37,
            80,
            68,
            70,
        ]));
    });

    it('requests browser write permission before saving to an existing file handle', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const queryPermission = vi.fn(async () => 'prompt' as const);
        const requestPermission = vi.fn(async () => 'granted' as const);
        const createWritable = vi.fn(async () => ({
            write: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'needs-permission.pdf',
            getFile: vi.fn(async () => new File([new Uint8Array([1])], 'needs-permission.pdf', { type: 'application/pdf' })),
            queryPermission,
            requestPermission,
            createWritable,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'needs-permission.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.writeForBootstrap(workingRef, new Uint8Array([
            37,
            80,
            68,
            70,
        ]), 'test-setup');

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({ ok: true });

        expect(queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(createWritable).toHaveBeenCalledOnce();
    });

    it('rejects browser structured saves without a revision token', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'missing-revision.pdf',
            new Uint8Array([
                37,
                80,
                68,
                70,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);

        await expect(capability.saveFileStructured(workingRef)).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('Document revision token is required'),
        });
    });

    it('rejects browser structured saves with a stale revision token', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'stale-revision.pdf',
            new Uint8Array([
                37,
                80,
                68,
                70,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const staleRevisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);
        await browserDocumentStore.writeForBootstrap(
            workingRef,
            new Uint8Array([
                37,
                80,
                68,
                70,
                10,
            ]),
            'test-advance-revision',
        );

        await expect(capability.saveFileStructured(workingRef, staleRevisionOptions)).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('Document changed while this edit was being prepared'),
        });
    });

    it('propagates browser save cancellation without clearing search caches', async () => {
        const showSaveFilePicker = vi.fn(async () => {
            throw new DOMException('Canceled', 'AbortError');
        });
        const clearSearchCaches = vi.fn();
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({
            clearSearchCaches,
            windowOverrides: { showSaveFilePicker },
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'cancel-save.pdf',
            new Uint8Array([
                37,
                80,
                68,
                70,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({
            ok: false,
            reason: 'user-canceled',
        });

        expect(clearSearchCaches).not.toHaveBeenCalled();
    });

    it('returns failed validation for canceled browser PDF data saves without clearing search caches', async () => {
        const showSaveFilePicker = vi.fn(async () => {
            throw new DOMException('Canceled', 'AbortError');
        });
        const clearSearchCaches = vi.fn();
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({
            clearSearchCaches,
            windowOverrides: { showSaveFilePicker },
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'cancel-save-data.pdf',
            await createPdfBytes(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const data = await createPdfBytes();

        const result = await capability.savePdfData(
            workingRef,
            data,
            await getRevisionOptions(browserDocumentStore, workingRef),
        );

        expect(result.isValid).toBe(false);
        expect(result.errors).toEqual([]);
        expect(clearSearchCaches).not.toHaveBeenCalled();
    });

    it('streams browser PDF data chunks into staged document chunks before saving', async () => {
        const clearSearchCaches = vi.fn();
        const writes: Uint8Array[] = [];
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'chunked-save.pdf',
            getFile: vi.fn(async () => new File([new Uint8Array()], 'chunked-save.pdf', { type: 'application/pdf' })),
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    writes.push(new Uint8Array(chunk));
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const {
            BROWSER_DOCUMENT_CHUNK_SIZE,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ clearSearchCaches });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'chunked-save.pdf',
            await createPdfBytes(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const writeSpy = vi.spyOn(browserDocumentStore, 'write');
        const pdfPrefix = await createPdfBytes();
        const data = new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE + 17);
        data.set(pdfPrefix.subarray(0, Math.min(pdfPrefix.byteLength, data.byteLength)));
        data[data.byteLength - 1] = 23;

        const result = await capability.savePdfDataChunks(workingRef, data.byteLength, [
            data.subarray(0, 3),
            data.subarray(3, BROWSER_DOCUMENT_CHUNK_SIZE + 5),
            data.subarray(BROWSER_DOCUMENT_CHUNK_SIZE + 5),
        ], await getRevisionOptions(browserDocumentStore, workingRef));

        expect(result).toMatchObject({
            isValid: true,
            errors: [],
            warnings: [],
        });
        expect(writeSpy).not.toHaveBeenCalled();
        const entry = await browserDocumentStore.requireEntry(workingRef);
        expect(entry.storageMode).toBe('chunked');
        await expect(browserDocumentStore.readRange(workingRef, 0, 3)).resolves.toEqual(data.subarray(0, 3));
        await expect(browserDocumentStore.readRange(
            workingRef,
            data.byteLength - 1,
            1,
        )).resolves.toEqual(new Uint8Array([23]));
        expect(writes.length).toBe(2);
        expect(clearSearchCaches).toHaveBeenCalledOnce();
    });

    it('discards staged browser PDF data chunks when streaming fails before finalization', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const originalBytes = await createPdfBytes();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'interrupted-chunked-save.pdf',
            originalBytes,
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        async function* brokenChunks() {
            yield new Uint8Array([
                37,
                80,
                68,
                70,
            ]);
            throw new Error('stream interrupted');
        }

        await expect(capability.savePdfDataChunks(
            workingRef,
            originalBytes.byteLength + 4,
            brokenChunks(),
        )).rejects.toThrow('stream interrupted');

        await expect(browserDocumentStore.read(workingRef)).resolves.toEqual(originalBytes);
    });

    it('does not report oversized invalid browser PDF data chunks as valid', async () => {
        const clearSearchCaches = vi.fn();
        const {
            BROWSER_DOCUMENT_CHUNK_SIZE,
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ clearSearchCaches });
        const originalBytes = await createPdfBytes();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'invalid-oversized-chunked-save.pdf',
            originalBytes,
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        pdfjsModule.getDocument.mockImplementationOnce(() => ({promise: Promise.resolve().then(() => {
            throw new Error('invalid oversized pdf');
        })}));
        async function* invalidOversizedChunks() {
            let bytesWritten = 0;
            const totalBytes = BROWSER_MAX_FULL_READ_BYTES + 1;
            while (bytesWritten < totalBytes) {
                const length = Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, totalBytes - bytesWritten);
                yield new Uint8Array(length);
                bytesWritten += length;
            }
        }

        const result = await capability.savePdfDataChunks(
            workingRef,
            BROWSER_MAX_FULL_READ_BYTES + 1,
            invalidOversizedChunks(),
        );

        expect(result).toMatchObject({
            isValid: false,
            errors: ['invalid oversized pdf'],
        });
        await expect(browserDocumentStore.read(workingRef)).resolves.toEqual(originalBytes);
        expect(clearSearchCaches).not.toHaveBeenCalled();
    });

    it('saves oversized valid browser PDF data chunks after range-backed validation', async () => {
        const clearSearchCaches = vi.fn();
        let writtenBytes = 0;
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'valid-oversized-chunked-save.pdf',
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    writtenBytes += chunk.byteLength;
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const {
            BROWSER_DOCUMENT_CHUNK_SIZE,
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ clearSearchCaches });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'valid-oversized-chunked-save.pdf',
            await createPdfBytes(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const pdfPrefix = await createPdfBytes();
        async function* validOversizedChunks() {
            let bytesWritten = 0;
            const totalBytes = BROWSER_MAX_FULL_READ_BYTES + 1;
            while (bytesWritten < totalBytes) {
                const length = Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, totalBytes - bytesWritten);
                const chunk = new Uint8Array(length);
                if (bytesWritten === 0) {
                    chunk.set(pdfPrefix.subarray(0, Math.min(pdfPrefix.byteLength, chunk.byteLength)));
                }
                yield chunk;
                bytesWritten += length;
            }
        }

        const result = await capability.savePdfDataChunks(
            workingRef,
            BROWSER_MAX_FULL_READ_BYTES + 1,
            validOversizedChunks(),
            await getRevisionOptions(browserDocumentStore, workingRef),
        );

        expect(result).toMatchObject({
            isValid: true,
            errors: [],
            warnings: [],
        });
        expect(pdfjsModule.getDocument).toHaveBeenCalledWith(expect.objectContaining({length: BROWSER_MAX_FULL_READ_BYTES + 1}));
        expect(writtenBytes).toBe(BROWSER_MAX_FULL_READ_BYTES + 1);
        expect(clearSearchCaches).toHaveBeenCalledOnce();
    });

    it('fails browser saves without opening the writer when write permission is denied', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const queryPermission = vi.fn(async () => 'prompt' as const);
        const requestPermission = vi.fn(async () => 'denied' as const);
        const createWritable = vi.fn(async () => ({
            write: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        }));
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'denied.pdf',
            getFile: vi.fn(async () => new File([new Uint8Array([1])], 'denied.pdf', { type: 'application/pdf' })),
            queryPermission,
            requestPermission,
            createWritable,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'denied.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.writeForBootstrap(workingRef, new Uint8Array([
            37,
            80,
            68,
            70,
        ]), 'test-setup');

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('Browser write permission was not granted for this file.'),
        });

        expect(createWritable).not.toHaveBeenCalled();
    });

    it('streams oversized browser save-as to a picked file handle', async () => {
        const writes: Uint8Array[] = [];
        const savedBytes = new Uint8Array((64 * 1024 * 1024) + 1);
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'exported-large.pdf',
            getFile: vi.fn(async () => new File([savedBytes], 'exported-large.pdf', { type: 'application/pdf' })),
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (chunk: ArrayBuffer) => {
                    const chunkBytes = new Uint8Array(chunk);
                    const offset = writes.reduce((sum, current) => sum + current.byteLength, 0);
                    savedBytes.set(chunkBytes, offset);
                    writes.push(chunkBytes);
                }),
                close: vi.fn(async () => {}),
            })),
        });
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showSaveFilePicker: vi.fn(async () => handle) } });
        const workingRef = await browserDocumentStore.createStoredDocument(
            'oversized.pdf',
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        const sourceRef = await capability.savePdfAs(
            workingRef,
            undefined,
            await getRevisionOptions(browserDocumentStore, workingRef),
        );

        expect(sourceRef).not.toBeNull();
        const sourceEntry = sourceRef
            ? await browserDocumentStore.requireEntry(sourceRef)
            : null;
        expect(sourceEntry?.storageMode).toBe('handle');
        expect(sourceEntry?.saveHandle).toBe(handle);
        await expect(browserDocumentStore.stat(sourceRef!)).resolves.toEqual({ size: BROWSER_MAX_FULL_READ_BYTES + 1 });
        expect(writes.length).toBeGreaterThan(1);
    });

    it('replaces the existing source with a handle-backed document on Save As to a picked handle', async () => {
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'picked.pdf',
            getFile: vi.fn(async () => new File([new Uint8Array([1])], 'picked.pdf', { type: 'application/pdf' })),
            createWritable: vi.fn(async () => ({
                write: vi.fn(async () => {}),
                close: vi.fn(async () => {}),
            })),
        });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showSaveFilePicker: vi.fn(async () => handle) } });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            new Uint8Array([
                37,
                80,
                68,
                70,
            ]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);

        const savedRef = await capability.savePdfAs(
            workingRef,
            undefined,
            await getRevisionOptions(browserDocumentStore, workingRef),
        );

        expect(savedRef).toBe(sourceRef);
        const sourceEntry = await browserDocumentStore.requireEntry(sourceRef);
        expect(sourceEntry.storageMode).toBe('handle');
        expect(sourceEntry.saveHandle).toBe(handle);
        expect(sourceEntry.fileName).toBe('picked.pdf');
    });

    it('leaves the browser working copy untouched when Save As is canceled for new PDF data', async () => {
        const showSaveFilePicker = vi.fn(async () => {
            throw new DOMException('Canceled', 'AbortError');
        });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showSaveFilePicker } });
        const originalBytes = await createPdfBytes();
        const updatedBytes = new Uint8Array(originalBytes.byteLength + 1);
        updatedBytes.set(originalBytes);
        updatedBytes[updatedBytes.length - 1] = 0x0a;
        const workingRef = await browserDocumentStore.createStoredDocument(
            'draft.pdf',
            originalBytes,
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        const result = await capability.savePdfDataAs(
            workingRef,
            updatedBytes,
            undefined,
            await getRevisionOptions(browserDocumentStore, workingRef),
        );

        expect(result.path).toBeNull();
        await expect(browserDocumentStore.read(workingRef)).resolves.toEqual(originalBytes);
        expect(showSaveFilePicker).toHaveBeenCalledOnce();
    });

    it('blocks browser save-as when a working copy exceeds the full-read budget', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await browserDocumentStore.createStoredDocument(
            'oversized.pdf',
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        await expect(capability.savePdfAs(
            workingRef,
            undefined,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).rejects.toThrow(
            'Saving documents is unavailable in the browser for inputs larger than 64MB',
        );
    });

    it('fails early for oversized browser download fallback saves without a handle', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: undefined}});
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            new Uint8Array([1]),
            {
                mimeType: 'application/pdf',
                kind: 'source',
                saveKind: 'pdf',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.writeForBootstrap(
            workingRef,
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            'test-setup',
        );

        await expect(capability.savePdfAs(
            workingRef,
            undefined,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).rejects.toThrow(
            'Saving documents is unavailable in the browser for inputs larger than 64MB Use a browser with local file system access enabled to save large documents.',
        );
    });
});
