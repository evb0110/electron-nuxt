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
} from './browserPlatformTestDoubles';

const browserPdfCombineWorkerMock = vi.hoisted(() => ({
    canUse: vi.fn(() => false),
    cloneInput: vi.fn((fileName: string, data: Uint8Array) => ({
        fileName,
        data, 
    })),
    run: vi.fn(),
}));
const utifMock = vi.hoisted(() => ({
    decode: vi.fn(() => []),
    decodeImage: vi.fn(),
    toRGBA8: vi.fn(() => new Uint8Array()),
}));

vi.mock('@app/platform/browser-api/browser-pdf-combine-worker-client', () => ({
    BrowserPdfCombineWorkerUnavailableError: class BrowserPdfCombineWorkerUnavailableError extends Error {},
    canUseBrowserPdfCombineWorker: () => browserPdfCombineWorkerMock.canUse(),
    cloneCombineWorkerInput: (fileName: string, data: Uint8Array) =>
        browserPdfCombineWorkerMock.cloneInput(fileName, data),
    runBrowserPdfCombineWorkerRequest: (type: string, payload: unknown) =>
        browserPdfCombineWorkerMock.run(type, payload),
}));
vi.mock('utif', () => ({default: {
    decode: (...args: Parameters<typeof utifMock.decode>) => utifMock.decode(...args),
    decodeImage: (...args: Parameters<typeof utifMock.decodeImage>) => utifMock.decodeImage(...args),
    toRGBA8: (...args: Parameters<typeof utifMock.toRGBA8>) => utifMock.toRGBA8(...args), 
}}));

async function createPdfBytes() {
    const document = await PDFDocument.create();
    document.addPage();
    return new Uint8Array(await document.save());
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
    inputFiles?: File[];
    windowOverrides?: Record<string, unknown>;
}

async function loadBrowserDocumentsFileCapability(options?: ILoadBrowserDocumentsFileCapabilityOptions) {
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
            BROWSER_MAX_FULL_READ_BYTES,
            browserDocumentStore,
        },
    ] = await Promise.all([
        import('@app/platform/browser-api/documents-file-capability'),
        import('@app/platform/browser-document-store'),
    ]);

    return {
        BROWSER_MAX_FULL_READ_BYTES,
        capability: createBrowserDocumentsFileCapability({ clearSearchCaches: () => {} }),
        browserDocumentStore,
    };
}

describe('createBrowserDocumentsFileCapability', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        browserPdfCombineWorkerMock.canUse.mockReset();
        browserPdfCombineWorkerMock.canUse.mockReturnValue(false);
        browserPdfCombineWorkerMock.cloneInput.mockClear();
        browserPdfCombineWorkerMock.run.mockReset();
        utifMock.decode.mockReset();
        utifMock.decode.mockReturnValue([]);
        utifMock.decodeImage.mockReset();
        utifMock.toRGBA8.mockReset();
        utifMock.toRGBA8.mockReturnValue(new Uint8Array());
    });

    it('cleans up transient source refs via cleanupFile', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
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
    });

    it('does not expose DjVu files in the browser combine picker', async () => {
        const showOpenFilePicker = vi.fn(async () => []);
        const { capability } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showOpenFilePicker } });

        await expect(capability.openCombineDialog()).resolves.toBeNull();

        const firstCall = showOpenFilePicker.mock.calls[0] as [{types?: Array<{ accept: Record<string, string[]>; }>;}] | undefined;
        const accept = firstCall?.[0]?.types?.[0]?.accept;
        expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
        expect(showOpenFilePicker).toHaveBeenCalledWith(expect.objectContaining({
            multiple: true,
            types: [expect.objectContaining({ accept: expect.not.objectContaining({'application/octet-stream': expect.anything()}) })],
        }));
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
        const { createCombinedPdfFromPaths } = await import('@app/platform/browser-api/documents-file-capability');
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
        const { createCombinedPdfFromPaths } = await import('@app/platform/browser-api/documents-file-capability');
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
            { createCombinedPdfFromPaths },
            { browserDocumentsMenuCapability },
        ] = await Promise.all([
            import('@app/platform/browser-api/documents-file-capability'),
            import('@app/platform/browser-api/documents-menu-capability'),
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
                requestId: 'browser-batch-1',
                processed: 1,
                total: 2,
            }),
            expect.objectContaining({
                requestId: 'browser-batch-1',
                processed: 2,
                total: 2,
                percent: 100,
            }),
        ]));
    });

    it('offloads supported mixed PDF and raster-image combine jobs to the browser worker', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const { createCombinedPdfFromPaths } = await import('@app/platform/browser-api/documents-file-capability');
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

    it('offloads TIFF combine jobs to the browser worker when available', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const { createCombinedPdfFromPaths } = await import('@app/platform/browser-api/documents-file-capability');
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
        const { createCombinedPdfFromPaths } = await import('@app/platform/browser-api/documents-file-capability');
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
        const { createCombinedPdfFromPaths } = await import('@app/platform/browser-api/documents-file-capability');
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
        await browserDocumentStore.write(workingRef, oversizedBytes);

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
        const handle = cast<FileSystemFileHandle>({
            kind: 'file',
            name: 'large-save.pdf',
            getFile: vi.fn(async () => new File([savedBytes], 'large-save.pdf', { type: 'application/pdf' })),
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
        await browserDocumentStore.write(workingRef, oversizedBytes);

        await expect(capability.saveFile(workingRef)).resolves.toBe(true);

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

        const sourceRef = await capability.savePdfAs(workingRef);

        expect(sourceRef).not.toBeNull();
        const sourceEntry = sourceRef
            ? await browserDocumentStore.requireEntry(sourceRef)
            : null;
        expect(sourceEntry?.storageMode).toBe('handle');
        expect(sourceEntry?.saveHandle).toBe(handle);
        await expect(browserDocumentStore.stat(sourceRef!)).resolves.toEqual({ size: BROWSER_MAX_FULL_READ_BYTES + 1 });
        expect(writes.length).toBeGreaterThan(1);
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

        await expect(capability.savePdfAs(workingRef)).rejects.toThrow(
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
        await browserDocumentStore.write(
            workingRef,
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
        );

        await expect(capability.savePdfAs(workingRef)).rejects.toThrow(
            'Saving documents is unavailable in the browser for inputs larger than 64MB Use a browser with local file system access enabled to save large documents.',
        );
    });
});
