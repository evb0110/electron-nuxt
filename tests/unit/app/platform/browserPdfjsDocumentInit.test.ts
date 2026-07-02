import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';

const pdfjsModule = vi.hoisted(() => {
    class MockPdfDataRangeTransport {
        public onDataRange = vi.fn();
        public abort = vi.fn();
        public requestDataRange: ((begin: number, end: number) => void) | null = null;

        constructor(
            public readonly length: number,
            public readonly initialData: Uint8Array,
        ) {}
    }

    return {
        version: '5.7.284',
        GlobalWorkerOptions: { workerSrc: undefined as string | undefined },
        VerbosityLevel: {ERRORS: 3},
        getDocument: vi.fn(),
        PDFDataRangeTransport: MockPdfDataRangeTransport,
    };
});

const browserDocumentStoreMock = vi.hoisted(() => ({
    stat: vi.fn(),
    getContentSignature: vi.fn(),
    readRange: vi.fn(),
}));

vi.mock('pdfjs-dist', () => pdfjsModule);
vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_DOCUMENT_CHUNK_SIZE: 1024 * 1024,
    browserDocumentStore: browserDocumentStoreMock,
}));

describe('browserPdfjsDocumentInit', () => {
    beforeEach(() => {
        vi.resetModules();
        pdfjsModule.getDocument.mockReset();
        pdfjsModule.GlobalWorkerOptions.workerSrc = undefined;
        browserDocumentStoreMock.stat.mockReset();
        browserDocumentStoreMock.getContentSignature.mockReset();
        browserDocumentStoreMock.readRange.mockReset();
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 3 * 1024 * 1024 });
        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-1');
        browserDocumentStoreMock.readRange.mockImplementation(async (_path: string, _offset: number, length: number) => new Uint8Array(length));
    });

    it('configures pdf.js worker source and leaves worker mode enabled', async () => {
        const {
            createPdfjsDocumentInit,
            getPdfjsLib,
        } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');
        const {
            getPdfjsAssetDir,
            getViewerAssetResolver,
        } = await import('@app/utils/viewerAssets');

        const pdfjsLib = await getPdfjsLib();
        const input = new Uint8Array([
            1,
            2,
            3,
        ]);
        const init = createPdfjsDocumentInit(pdfjsLib, input);

        expect(pdfjsModule.GlobalWorkerOptions.workerSrc).toBe(getViewerAssetResolver().pdfWorkerUrl());
        expect(init).not.toHaveProperty('disableWorker');
        expect(init).toMatchObject({
            data: expect.any(Uint8Array),
            verbosity: pdfjsModule.VerbosityLevel.ERRORS,
            standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
            cMapUrl: getPdfjsAssetDir('cmaps'),
            cMapPacked: true,
            wasmUrl: getPdfjsAssetDir('wasm'),
            iccUrl: getPdfjsAssetDir('iccs'),
            useSystemFonts: false,
        });
        const initData = (init as { data: Uint8Array }).data;
        expect(initData).not.toBe(input);
        expect(Array.from(initData)).toEqual(Array.from(input));
        expect(Array.from(input)).toEqual([
            1,
            2,
            3,
        ]);
    });

    it('aggregates short browser ranges before delivering them to PDF.js', async () => {
        const {
            createPdfjsDocumentInitFromBrowserDocument,
            getPdfjsLib,
        } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');

        const pdfjsLib = await getPdfjsLib();
        const init = await createPdfjsDocumentInitFromBrowserDocument(
            pdfjsLib,
            'browser://documents/test.pdf',
        );
        const range = cast<{ range: InstanceType<typeof pdfjsModule.PDFDataRangeTransport> }>(init).range;

        browserDocumentStoreMock.readRange.mockImplementation(async (_path: string, offset: number, length: number) => {
            if (offset === 1024 * 1024) {
                expect(length).toBe(12);
                return new Uint8Array(8);
            }
            if (offset === (1024 * 1024) + 8) {
                expect(length).toBe(4);
                return new Uint8Array(4);
            }
            return new Uint8Array(length);
        });

        range.requestDataRange?.(1024 * 1024, (1024 * 1024) + 12);

        await vi.waitFor(() => {
            expect(range.onDataRange).toHaveBeenCalledTimes(1);
        });
        expect(range.onDataRange).toHaveBeenCalledWith(1024 * 1024, expect.objectContaining({ byteLength: 12 }));
    });

    it('aborts browser range transport when the source signature changes', async () => {
        const onRangeReadFailure = vi.fn();
        const {
            createPdfjsDocumentInitFromBrowserDocument,
            getPdfjsLib,
        } = await import('@app/platform/browser-api/browserPdfjsDocumentInit');

        const pdfjsLib = await getPdfjsLib();
        const init = await createPdfjsDocumentInitFromBrowserDocument(
            pdfjsLib,
            'browser://documents/test.pdf',
            { onRangeReadFailure },
        );
        const range = cast<{ range: InstanceType<typeof pdfjsModule.PDFDataRangeTransport> }>(init).range;

        browserDocumentStoreMock.getContentSignature.mockResolvedValue('content-token-2');
        range.requestDataRange?.(1024 * 1024, (1024 * 1024) + 12);

        await vi.waitFor(() => {
            expect(onRangeReadFailure).toHaveBeenCalledTimes(1);
        });
        expect(range.onDataRange).not.toHaveBeenCalled();
    });
});
