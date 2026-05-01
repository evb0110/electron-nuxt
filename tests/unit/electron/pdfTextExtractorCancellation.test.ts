import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    runCommand: vi.fn(),
    getOcrToolPaths: vi.fn(),
}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({debug: vi.fn()})}));

vi.mock('@electron/utils/exec', () => ({runElectronCommand: mocks.runCommand}));

vi.mock('@electron/ocr/paths', () => ({getOcrToolPaths: mocks.getOcrToolPaths}));

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

describe('extractTextFromPdf cancellation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getOcrToolPaths.mockReturnValue({pdftotext: 'pdftotext'});
    });

    it('returns AbortError immediately when signal is already aborted', async () => {
        const { extractTextFromPdf } = await import('@electron/search/pdf-text-extractor');
        const controller = new AbortController();
        controller.abort();

        await expect(
            extractTextFromPdf('/tmp/file.pdf', {signal: controller.signal}),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.runCommand).not.toHaveBeenCalled();
    });

    it('forwards signal to runCommand and preserves paging behavior', async () => {
        const { extractTextFromPdf } = await import('@electron/search/pdf-text-extractor');
        const controller = new AbortController();

        mocks.runCommand.mockResolvedValue({
            stdout: 'page-1\f',
            stderr: '',
            exitCode: 0,
        });

        const result = await extractTextFromPdf('/tmp/file.pdf', {
            pageCount: 2,
            signal: controller.signal,
        });

        expect(mocks.runCommand).toHaveBeenCalledWith(
            'pdftotext',
            [
                '-layout',
                '/tmp/file.pdf',
                '-',
            ],
            {
                signal: controller.signal,
                timeoutMs: 120000,
                maxStdoutBytes: 67108864,
                rejectOnStdoutTruncation: true,
            },
        );
        expect(result).toEqual([
            {
                pageNumber: 1,
                text: 'page-1',
            },
            {
                pageNumber: 2,
                text: '',
            },
        ]);
    });

    it('rethrows AbortError from runCommand without wrapping', async () => {
        const { extractTextFromPdf } = await import('@electron/search/pdf-text-extractor');
        const abortError = createAbortError();
        mocks.runCommand.mockRejectedValue(abortError);

        await expect(
            extractTextFromPdf('/tmp/file.pdf', {signal: new AbortController().signal}),
        ).rejects.toBe(abortError);
    });
});
