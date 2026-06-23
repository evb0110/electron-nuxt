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
    stat: vi.fn(),
    writeFile: vi.fn(),
    atomicReplace: vi.fn(),
    extractTextFromPdf: vi.fn(),
    extractTextWithPdfjs: vi.fn(),
    extractTextWithPdfjsWordBoxes: vi.fn(),
    loadCompactSearchIndex: vi.fn(),
    persistCompactSearchIndex: vi.fn(),
    persistCompactSearchIndexBestEffort: vi.fn(),
}));

vi.mock('fs', () => ({existsSync: mocks.existsSync}));

vi.mock('fs/promises', () => ({
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
}));

vi.mock('@electron/search/extractTextFromPdf', () => ({extractTextFromPdf: mocks.extractTextFromPdf}));

vi.mock('@electron/search/extractTextWithPdfjs', () => ({
    extractTextWithPdfjs: mocks.extractTextWithPdfjs,
    extractTextWithPdfjsWordBoxes: mocks.extractTextWithPdfjsWordBoxes,
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: (targetPath: string) => `${targetPath}.tmp`,
}));

vi.mock('@electron/search/searchIndexSidecar', () => ({
    COMPACT_SEARCH_INDEX_MAGIC: 'EVBSIDX1',
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION: 1,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER: 1,
    getCompactSearchIndexPath: (pdfPath: string) => `${pdfPath}.index.evb-search-v1.bin`,
    loadCompactSearchIndex: mocks.loadCompactSearchIndex,
    persistCompactSearchIndex: mocks.persistCompactSearchIndex,
    persistCompactSearchIndexBestEffort: mocks.persistCompactSearchIndexBestEffort,
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
        mocks.stat.mockResolvedValue({ size: 0 });
        mocks.atomicReplace.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.loadCompactSearchIndex.mockResolvedValue(null);
        mocks.persistCompactSearchIndex.mockResolvedValue(undefined);
        mocks.persistCompactSearchIndexBestEffort.mockResolvedValue(undefined);
        mocks.extractTextWithPdfjsWordBoxes.mockResolvedValue([]);
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

        expect(mocks.extractTextWithPdfjsWordBoxes).toHaveBeenCalledWith('/tmp/file.pdf', {
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
        expect(mocks.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
    });

    it('rethrows AbortError from pdfjs extraction and skips fallback extraction', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        const abortError = createAbortError();
        mocks.extractTextWithPdfjsWordBoxes.mockRejectedValue(abortError);

        await expect(
            buildSearchIndex('/tmp/file.pdf', [], {
                pageCount: 1,
                signal: new AbortController().signal,
            }),
        ).rejects.toBe(abortError);
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
    });
});

describe('buildSearchIndex assembly', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(false);
        mocks.readFile.mockRejectedValue(new Error('ENOENT'));
        mocks.stat.mockResolvedValue({ size: 0 });
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.loadCompactSearchIndex.mockResolvedValue(null);
        mocks.persistCompactSearchIndexBestEffort.mockResolvedValue(undefined);
        mocks.extractTextWithPdfjsWordBoxes.mockResolvedValue([]);
    });

    it('skips PDF text extraction when existing index already covers expected pages', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        const cachedIndex = {
            schemaVersion: 6,
            pdfPath: '/tmp/file.pdf',
            createdAt: 1,
            pages: [
                {
                    pageNumber: 1,
                    text: 'cached one',
                    pageWidth: 100,
                    pageHeight: 100,
                    words: [{
                        text: 'cached',
                        x: 0,
                        y: 0,
                        width: 10,
                        height: 10,
                    }],
                },
                {
                    pageNumber: 2,
                    text: 'cached two',
                    pageWidth: 100,
                    pageHeight: 100,
                    words: [{
                        text: 'cached',
                        x: 0,
                        y: 0,
                        width: 10,
                        height: 10,
                    }],
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
        expect(mocks.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
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

    it('uses pdftotext before pdfjs for large PDFs', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.stat.mockResolvedValue({ size: 128 * 1024 * 1024 });
        mocks.extractTextFromPdf.mockResolvedValue([{
            pageNumber: 1,
            text: 'from-pdftotext',
        }]);

        const result = await buildSearchIndex('/tmp/file.pdf', [], { pageCount: 1 });

        expect(mocks.extractTextFromPdf).toHaveBeenCalledWith('/tmp/file.pdf', { pageCount: 1 });
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(result.pages).toEqual([expect.objectContaining({
            pageNumber: 1,
            text: 'from-pdftotext',
        })]);
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
        expect(result.schemaVersion).toBe(6);
        expect(result.textSource).toEqual({
            kind: 'ocr-v2-text-layer',
            version: 1,
        });
        expect(mocks.persistCompactSearchIndexBestEffort).toHaveBeenCalledWith('/tmp/file.pdf', {
            pageCount: 2,
            pages: [
                expect.objectContaining({
                    pageNumber: 1,
                    text: 'alpha beta \n',
                }),
                expect.objectContaining({
                    pageNumber: 2,
                    text: 'line \ntwo \n',
                }),
            ],
            textSource: {
                kind: 1,
                version: 1,
            },
        }, undefined);
    });

    it('reads OCR page JSON instead of compact text-only sidecar so geometry is preserved', async () => {
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
                    rotation: 0,
                    render: {
                        dpi: 300,
                        imagePx: {
                            w: 100,
                            h: 200,
                        },
                    },
                    words: [{
                        text: 'json',
                        x: 1,
                        y: 2,
                        width: 3,
                        height: 4,
                    }],
                });
            }
            if (path.endsWith('page-2.json')) {
                return JSON.stringify({
                    pageNumber: 2,
                    rotation: 90,
                    render: {
                        dpi: 300,
                        imagePx: {
                            w: 100,
                            h: 200,
                        },
                    },
                    words: [{
                        text: 'geometry',
                        x: 5,
                        y: 6,
                        width: 7,
                        height: 8,
                    }],
                });
            }
            throw new Error(`Unexpected JSON read: ${path}`);
        });
        mocks.stat.mockResolvedValue({
            size: 0,
            mtimeMs: 10,
        });
        mocks.loadCompactSearchIndex.mockResolvedValue({
            pageCount: 2,
            pages: [
                {
                    pageNumber: 1,
                    text: 'compact one',
                },
                {
                    pageNumber: 2,
                    text: 'compact two',
                },
            ],
        });

        const onPageIndexed = vi.fn();
        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            pageCount: 2,
            onPageIndexed,
        });

        expect(mocks.loadCompactSearchIndex).not.toHaveBeenCalled();
        expect(mocks.readFile).toHaveBeenCalledTimes(3);
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
        expect(result.pages).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                text: 'json \n',
                pageWidth: 100,
                pageHeight: 200,
                rotation: 0,
                words: [expect.objectContaining({ text: 'json' })],
            }),
            expect.objectContaining({
                pageNumber: 2,
                text: 'geometry \n',
                pageWidth: 100,
                pageHeight: 200,
                rotation: 90,
                words: [expect.objectContaining({ text: 'geometry' })],
            }),
        ]);
        expect(onPageIndexed).toHaveBeenCalledWith(expect.objectContaining({
            pageNumber: 1,
            text: 'json \n',
            pageWidth: 100,
            pageHeight: 200,
            rotation: 0,
        }));
        expect(onPageIndexed).toHaveBeenCalledWith(expect.objectContaining({
            pageNumber: 2,
            text: 'geometry \n',
            pageWidth: 100,
            pageHeight: 200,
            rotation: 90,
        }));
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
