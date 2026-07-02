import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const createStatResult = (isFile: boolean, size: number) => ({
        isFile: () => isFile,
        size,
    });
    return {
        createStatResult,
        stat: vi.fn(async () => createStatResult(true, 1024)),
    };
});

vi.mock('fs/promises', () => ({stat: mocks.stat}));

const { assertPdfPageSizeFallbackInputSafe } = await import(
    '@electron/ocr/worker/assertPdfPageSizeFallbackInputSafe'
);

describe('OCR worker page-size fallback guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.stat.mockResolvedValue(mocks.createStatResult(true, 1024));
    });

    it('allows regular PDFs within the stat cap', async () => {
        await expect(assertPdfPageSizeFallbackInputSafe('/tmp/small.pdf', 128 * 1024 * 1024))
            .resolves
            .toBeUndefined();
    });

    it('rejects oversized PDFs before the worker can read them', async () => {
        mocks.stat.mockResolvedValueOnce(mocks.createStatResult(true, 129 * 1024 * 1024));

        await expect(assertPdfPageSizeFallbackInputSafe('/tmp/huge.pdf', 128 * 1024 * 1024))
            .rejects
            .toThrow('OCR page-size fallback skipped for PDF larger than 128MB: /tmp/huge.pdf');
    });

    it('rejects non-file inputs as unsafe for pdf-lib fallback reads', async () => {
        mocks.stat.mockResolvedValueOnce(mocks.createStatResult(false, 0));

        await expect(assertPdfPageSizeFallbackInputSafe('/tmp/not-a-file', 128 * 1024 * 1024))
            .rejects
            .toThrow('OCR page-size fallback input is not a regular file: /tmp/not-a-file');
    });
});
