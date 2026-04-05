import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const browserDocumentStoreMock = vi.hoisted(() => ({
    stat: vi.fn(),
    readRange: vi.fn(),
}));
const pdfjsModule = vi.hoisted(() => ({
    GlobalWorkerOptions: { workerSrc: undefined as string | undefined },
    VerbosityLevel: {ERRORS: 3},
    getDocument: vi.fn(),
}));

vi.mock('@app/platform/browser-api/browser-yield', () => ({yieldToBrowser: () => yieldToBrowserMock()}));
vi.mock('@app/platform/browser-document-store', () => ({
    BROWSER_DOCUMENT_CHUNK_SIZE: 4 * 1024 * 1024,
    browserDocumentStore: browserDocumentStoreMock,
}));
vi.mock('pdfjs-dist', () => pdfjsModule);

describe('createBrowserSearchCapability', () => {
    beforeEach(() => {
        vi.resetModules();
        yieldToBrowserMock.mockClear();
        browserDocumentStoreMock.stat.mockReset();
        browserDocumentStoreMock.readRange.mockReset();
        pdfjsModule.getDocument.mockReset();
    });

    it('reuses cached browser page text across repeated searches when the extracted text stays within budget', async () => {
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

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/search-capability');
        const { capability } = createBrowserSearchCapability();

        const firstRun = await capability.run('/tmp/test.pdf', 'foo');
        const secondRun = await capability.run('/tmp/test.pdf', 'foo');

        expect(firstRun.results).toHaveLength(30);
        expect(secondRun.results).toHaveLength(30);
        expect(browserDocumentStoreMock.stat).toHaveBeenCalledTimes(3);
        expect(browserDocumentStoreMock.readRange).toHaveBeenCalledTimes(1);
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(1);
        expect(yieldToBrowserMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(getPage).toHaveBeenCalledTimes(30);
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(30);
    });

    it('rejects browser search for oversized documents before loading PDF.js', async () => {
        browserDocumentStoreMock.stat.mockResolvedValue({ size: (64 * 1024 * 1024) + 1 });

        const { createBrowserSearchCapability } = await import('@app/platform/browser-api/search-capability');
        const { capability } = createBrowserSearchCapability();

        await expect(capability.run('/tmp/huge.pdf', 'foo')).rejects.toThrow('ERR_BROWSER_SEARCH_TOO_LARGE');
        expect(browserDocumentStoreMock.readRange).not.toHaveBeenCalled();
        expect(pdfjsModule.getDocument).not.toHaveBeenCalled();
    });
});
