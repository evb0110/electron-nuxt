import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createCombinedPdfFromPaths } from '@app/platform/browser-api/createCombinedPdfFromPaths';

const browserDocumentStoreMock = vi.hoisted(() => ({
    stat: vi.fn(async () => ({size: 1_024})),
    read: vi.fn(),
    write: vi.fn(async () => {}),
    createStoredDocument: vi.fn(),
    remove: vi.fn(async () => {}),
}));
const browserDjvuCapabilityMock = vi.hoisted(() => ({
    runConversion: vi.fn(),
    cancel: vi.fn(async () => {}),
}));

vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_DOCUMENT_CHUNK_SIZE: 4 * 1024 * 1024,
    getBrowserDocumentFileName: (ref: string) => ref.split('/').at(-1) ?? 'document.pdf',
    browserDocumentStore: browserDocumentStoreMock,
}));
vi.mock('@app/platform/browser-api/browserDjvuCapability', () => ({browserDjvuCapability: browserDjvuCapabilityMock}));
vi.mock('@app/platform/browser-api/browserDjvuConversionPipeline', () => ({
    getBrowserDjvuBookmarksForCombine: async () => [],
    runBrowserDjvuConversion: browserDjvuCapabilityMock.runConversion,
}));

describe('browser combine DjVu abort window', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        browserDocumentStoreMock.stat.mockResolvedValue({size: 1_024});
    });

    // Creating the output document is the one await between the combine's
    // abort check and the conversion it hands the signal to, so a cancellation
    // that lands there must not still pay for a full DjVu conversion.
    it('does not start a DjVu conversion for a combine canceled while its output was created', async () => {
        const controller = new AbortController();
        browserDocumentStoreMock.createStoredDocument.mockImplementation(async () => {
            controller.abort(new DOMException('PDF combine was canceled.', 'AbortError'));
            return 'stored://converted.pdf';
        });

        await expect(createCombinedPdfFromPaths(
            ['/library/scan.djvu'],
            {signal: controller.signal},
        )).rejects.toMatchObject({name: 'AbortError'});

        expect(browserDjvuCapabilityMock.runConversion).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.remove).toHaveBeenCalledWith('stored://converted.pdf');
    });
});
