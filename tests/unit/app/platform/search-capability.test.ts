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

    it('yields while iterating pages and reuses bounded page text cache', async () => {
        const pageTexts = [
            'alpha foo',
            'beta foo',
            'gamma foo',
        ];
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

        expect(firstRun.results).toHaveLength(3);
        expect(secondRun.results).toHaveLength(3);
        expect(browserDocumentStoreMock.stat).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.readRange).toHaveBeenCalledTimes(1);
        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(1);
        expect(yieldToBrowserMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(getPage).toHaveBeenCalledTimes(3);
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(3);
    });
});
