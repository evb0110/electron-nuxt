import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    readFile: vi.fn(),
    getDocument: vi.fn(),
    loadingDestroy: vi.fn(),
    docDestroy: vi.fn(),
}));

vi.mock('@electron/search/dom-polyfill', () => ({}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({debug: vi.fn()})}));

vi.mock('fs/promises', () => ({readFile: mocks.readFile}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({getDocument: mocks.getDocument}));

describe('extractTextWithPdfjs cancellation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readFile.mockResolvedValue(Buffer.from('pdf'));
        mocks.loadingDestroy.mockResolvedValue(undefined);
        mocks.docDestroy.mockResolvedValue(undefined);
    });

    it('returns AbortError immediately when signal is already aborted', async () => {
        const { extractTextWithPdfjs } = await import('@electron/search/pdfjs-text-extractor');
        const controller = new AbortController();
        controller.abort();

        await expect(
            extractTextWithPdfjs('/tmp/file.pdf', {signal: controller.signal}),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.getDocument).not.toHaveBeenCalled();
    });

    it('aborts pending loading task and rejects with AbortError', async () => {
        const { extractTextWithPdfjs } = await import('@electron/search/pdfjs-text-extractor');
        const controller = new AbortController();

        mocks.getDocument.mockReturnValue({
            promise: new Promise(() => {
                // Cancellation should reject before loading completes.
            }),
            destroy: mocks.loadingDestroy,
        });

        const extraction = extractTextWithPdfjs('/tmp/file.pdf', {signal: controller.signal});
        await vi.waitFor(() => {
            expect(mocks.getDocument).toHaveBeenCalledOnce();
        });
        controller.abort();

        await expect(extraction).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.loadingDestroy).toHaveBeenCalledOnce();
    });

    it('keeps successful extraction behavior unchanged', async () => {
        const { extractTextWithPdfjs } = await import('@electron/search/pdfjs-text-extractor');
        const page = {getTextContent: vi.fn().mockResolvedValue({items: [
            {
                str: 'Hello',
                hasEOL: true,
            },
            {
                str: 'World',
                hasEOL: false,
            },
        ]})};
        const doc = {
            numPages: 1,
            getPage: vi.fn().mockResolvedValue(page),
            destroy: mocks.docDestroy,
        };

        mocks.getDocument.mockReturnValue({
            promise: Promise.resolve(doc),
            destroy: mocks.loadingDestroy,
        });

        const result = await extractTextWithPdfjs('/tmp/file.pdf');

        expect(result).toEqual([{
            pageNumber: 1,
            text: 'Hello\nWorld',
        }]);
        expect(mocks.docDestroy).toHaveBeenCalledOnce();
    });
});
