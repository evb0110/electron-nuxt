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
    rm: vi.fn(),
    writeFile: vi.fn(),
    atomicReplace: vi.fn(),
    extractTextFromPdf: vi.fn(),
    extractTextWithPdfjs: vi.fn(),
}));

vi.mock('fs', () => ({existsSync: mocks.existsSync}));

vi.mock('fs/promises', () => ({
    readFile: mocks.readFile,
    rm: mocks.rm,
    writeFile: mocks.writeFile,
}));

vi.mock('@electron/search/extractTextFromPdf', () => ({extractTextFromPdf: mocks.extractTextFromPdf}));

vi.mock('@electron/search/extractTextWithPdfjs', () => ({extractTextWithPdfjs: mocks.extractTextWithPdfjs}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: (targetPath: string) => `${targetPath}.tmp`,
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
})}));

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

interface IPdfjsMockPageText {
    pageNumber: number;
    text: string;
}

interface IPdfjsMockOptions { onPageText?: (pageText: IPdfjsMockPageText) => void; }

describe('buildSearchIndex cancellation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(false);
        mocks.readFile.mockRejectedValue(new Error('ENOENT'));
        mocks.rm.mockResolvedValue(undefined);
        mocks.atomicReplace.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
    });

    it('forwards signal to PDF text extractors', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
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

        expect(mocks.extractTextWithPdfjs).toHaveBeenCalledWith('/tmp/file.pdf', {
            signal: controller.signal,
            collectPages: false,
            onPageText: expect.any(Function),
        });
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
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
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
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
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

describe('buildSearchIndex assembly', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(false);
        mocks.readFile.mockRejectedValue(new Error('ENOENT'));
        mocks.writeFile.mockResolvedValue(undefined);
    });

    it('skips PDF text extraction when existing index already covers expected pages', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        const cachedIndex = {
            schemaVersion: 4,
            pdfPath: '/tmp/file.pdf',
            createdAt: 1,
            pages: [
                {
                    pageNumber: 1,
                    text: 'cached one',
                },
                {
                    pageNumber: 2,
                    text: 'cached two',
                },
            ],
            pageCount: 2,
        };
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path === '/tmp/file.pdf.index.json') {
                return JSON.stringify(cachedIndex);
            }
            throw new Error('ENOENT');
        });

        const result = await buildSearchIndex('/tmp/file.pdf', [], { pageCount: 2 });

        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
        expect(result.pages).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                text: 'cached one',
            }),
            expect.objectContaining({
                pageNumber: 2,
                text: 'cached two',
            }),
        ]);
        expect(result.pageCount).toBe(2);
    });

    it('pads missing pages up to expected pageCount with empty text', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.extractTextWithPdfjs.mockImplementation(async (_path: string, options: IPdfjsMockOptions) => {
            options.onPageText?.({
                pageNumber: 1,
                text: 'only-one',
            });
            return [];
        });
        mocks.extractTextFromPdf.mockResolvedValue([]);

        const result = await buildSearchIndex('/tmp/file.pdf', [], { pageCount: 3 });

        expect(result.pages).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                text: 'only-one',
            }),
            expect.objectContaining({
                pageNumber: 2,
                text: '',
            }),
            expect.objectContaining({
                pageNumber: 3,
                text: '',
            }),
        ]);
        expect(result.pageCount).toBe(3);
    });

    it('prefers OCR pageData words over previously extracted text and raw OCR text', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.extractTextWithPdfjs.mockImplementation(async (_path: string, options: IPdfjsMockOptions) => {
            options.onPageText?.({
                pageNumber: 1,
                text: 'pdfjs-1',
            });
            options.onPageText?.({
                pageNumber: 2,
                text: 'pdfjs-2',
            });
            return [];
        });
        mocks.extractTextFromPdf.mockResolvedValue([]);

        const result = await buildSearchIndex(
            '/tmp/file.pdf',
            [
                {
                    pageNumber: 1,
                    words: [],
                    text: 'ocr-override',
                },
                {
                    pageNumber: 2,
                    words: [
                        {
                            text: 'hello',
                            x: 0,
                            y: 0,
                            width: 0,
                            height: 0,
                        },
                        {
                            text: 'world',
                            x: 0,
                            y: 0,
                            width: 0,
                            height: 0,
                        },
                    ],
                },
            ],
            { pageCount: 2 },
        );

        expect(result.pages).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                text: 'ocr-override',
            }),
            expect.objectContaining({
                pageNumber: 2,
                text: 'hello world \n',
            }),
        ]);
    });

    it('uses OCR v2 words as text-layer-compatible search text and persists index best-effort', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.existsSync.mockReturnValue(true);
        const manifest = {
            version: 2,
            createdAt: 1,
            source: { pdfPath: '/tmp/file.pdf' },
            pageCount: 2,
            pageBox: 'cropped',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {
                1: { path: 'page-1.json' },
                2: { path: 'page-2.json' },
            },
        };
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path.endsWith('manifest.json')) {
                return JSON.stringify(manifest);
            }
            if (path.endsWith('page-1.json')) {
                return JSON.stringify({
                    pageNumber: 1,
                    text: 'alpha ghost beta',
                    words: [
                        {
                            text: 'alpha',
                            x: 0,
                            y: 0,
                            width: 10,
                            height: 10,
                        },
                        {
                            text: 'beta',
                            x: 20,
                            y: 0,
                            width: 10,
                            height: 10,
                        },
                    ],
                });
            }
            if (path.endsWith('page-2.json')) {
                return JSON.stringify({
                    pageNumber: 2,
                    text: 'line one\nline two',
                    words: [
                        {
                            text: 'line',
                            x: 0,
                            y: 0,
                            width: 10,
                            height: 10,
                        },
                        {
                            text: 'two',
                            x: 0,
                            y: 20,
                            width: 10,
                            height: 10,
                        },
                    ],
                });
            }
            throw new Error('ENOENT');
        });
        mocks.writeFile.mockRejectedValue(new Error('disk full'));

        const result = await buildSearchIndex('/tmp/file.pdf', [], { pageCount: 2 });

        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
        expect(result.pages).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                text: 'alpha beta \n',
            }),
            expect.objectContaining({
                pageNumber: 2,
                text: 'line \ntwo \n',
            }),
        ]);
        expect(result.pageCount).toBe(2);
        expect(result.schemaVersion).toBe(4);
        expect(result.textSource).toEqual({
            kind: 'ocr-v2-text-layer',
            version: 1,
        });
    });

    it('ignores stale OCR v2 sidecar pages outside the current page count', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.existsSync.mockImplementation((path: string) => (
            path.endsWith('manifest.json') || path.endsWith('page-3.json')
        ));
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path.endsWith('manifest.json')) {
                return JSON.stringify({
                    version: 2,
                    createdAt: 1,
                    source: { pdfPath: '/tmp/file.pdf' },
                    pageCount: 3,
                    pageBox: 'cropped',
                    ocr: {
                        engine: 'tesseract',
                        languages: ['eng'],
                        renderDpi: 300,
                    },
                    pages: { 3: { path: 'page-3.json' } },
                });
            }
            if (path.endsWith('page-3.json')) {
                return JSON.stringify({
                    pageNumber: 3,
                    text: 'stale sidecar text',
                    words: [],
                });
            }
            throw new Error('ENOENT');
        });
        mocks.extractTextWithPdfjs.mockImplementation(async (_path: string, options: IPdfjsMockOptions) => {
            options.onPageText?.({
                pageNumber: 1,
                text: 'current pdf text',
            });
            return [];
        });
        mocks.extractTextFromPdf.mockResolvedValue([]);

        const result = await buildSearchIndex('/tmp/file.pdf', [], { pageCount: 2 });

        expect(result.pages).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                text: 'current pdf text',
            }),
            expect.objectContaining({
                pageNumber: 2,
                text: '',
            }),
        ]);
        expect(result.pages.some(page => page.pageNumber === 3)).toBe(false);
        expect(mocks.extractTextWithPdfjs).toHaveBeenCalledOnce();
    });
});
