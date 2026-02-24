import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    extractTextFromPdf: vi.fn(),
    extractTextWithPdfjs: vi.fn(),
}));

vi.mock('fs', () => ({existsSync: mocks.existsSync}));

vi.mock('fs/promises', () => ({
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
}));

vi.mock('@electron/search/pdf-text-extractor', () => ({extractTextFromPdf: mocks.extractTextFromPdf}));

vi.mock('@electron/search/pdfjs-text-extractor', () => ({extractTextWithPdfjs: mocks.extractTextWithPdfjs}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
})}));

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

describe('buildSearchIndex cancellation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(false);
        mocks.readFile.mockRejectedValue(new Error('ENOENT'));
        mocks.writeFile.mockResolvedValue(undefined);
    });

    it('forwards signal to PDF text extractors', async () => {
        const { buildSearchIndex } = await import('@electron/search/index-builder');
        const controller = new AbortController();

        mocks.extractTextWithPdfjs.mockResolvedValue([{
            pageNumber: 1,
            text: '',
        }]);
        mocks.extractTextFromPdf.mockResolvedValue([{
            pageNumber: 1,
            text: 'from-pdftotext',
        }]);

        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            pageCount: 1,
            signal: controller.signal,
        });

        expect(mocks.extractTextWithPdfjs).toHaveBeenCalledWith('/tmp/file.pdf', {signal: controller.signal});
        expect(mocks.extractTextFromPdf).toHaveBeenCalledWith('/tmp/file.pdf', {
            pageCount: 1,
            signal: controller.signal,
        });
        expect(result.pages).toEqual([expect.objectContaining({
            pageNumber: 1,
            text: 'from-pdftotext',
        })]);
    });

    it('aborts before extraction starts when signal is already aborted', async () => {
        const { buildSearchIndex } = await import('@electron/search/index-builder');
        const controller = new AbortController();
        controller.abort();

        await expect(
            buildSearchIndex('/tmp/file.pdf', [], {
                pageCount: 1,
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
    });

    it('rethrows AbortError from pdfjs extraction and skips fallback extraction', async () => {
        const { buildSearchIndex } = await import('@electron/search/index-builder');
        const abortError = createAbortError();
        mocks.extractTextWithPdfjs.mockRejectedValue(abortError);

        await expect(
            buildSearchIndex('/tmp/file.pdf', [], {
                pageCount: 1,
                signal: new AbortController().signal,
            }),
        ).rejects.toBe(abortError);
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
    });
});
