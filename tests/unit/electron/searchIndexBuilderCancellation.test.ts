import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts';

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
    assertWorkingCopyRevisionCurrent: vi.fn(),
    resolveDocumentTextCatalogSnapshot: vi.fn(),
}));

const DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

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
    COMPACT_SEARCH_INDEX_MAGIC: 'EVBSIDX2',
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION: 2,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER: 1,
    getCompactSearchIndexPath: (pdfPath: string) => `${pdfPath}.index.evb-search-v2.bin`,
    loadCompactSearchIndex: mocks.loadCompactSearchIndex,
    persistCompactSearchIndex: mocks.persistCompactSearchIndex,
    persistCompactSearchIndexBestEffort: mocks.persistCompactSearchIndexBestEffort,
}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: mocks.assertWorkingCopyRevisionCurrent}));
vi.mock('@electron/ocr/documentTextCatalog', () => ({resolveDocumentTextCatalogSnapshot: mocks.resolveDocumentTextCatalogSnapshot}));

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
    words?: Array<{
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
    pageWidth?: number;
    pageHeight?: number;
    rotation?: 0 | 90 | 180 | 270;
}

interface IPdfjsMockOptions { onPageText?: (pageText: IPdfjsMockPageText) => void; }

function mockCatalog(pageCount: number, pages: Array<Record<string, unknown>>) {
    mocks.resolveDocumentTextCatalogSnapshot.mockResolvedValue({
        documentRevision: DOCUMENT_REVISION,
        pageCount,
        contentDigest: 'catalog',
        pages: pages.map(page => ({
            source: 'evb-ocr',
            contentDigest: `page-${String(page.pageNumber)}`,
            ...page,
        })),
    });
}

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
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.extractTextWithPdfjsWordBoxes.mockResolvedValue([]);
        mocks.resolveDocumentTextCatalogSnapshot.mockRejectedValue(new Error('catalog unavailable'));
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
            documentRevision: DOCUMENT_REVISION,
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
                documentRevision: DOCUMENT_REVISION,
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
                documentRevision: DOCUMENT_REVISION,
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
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.extractTextWithPdfjsWordBoxes.mockResolvedValue([]);
        mocks.resolveDocumentTextCatalogSnapshot.mockRejectedValue(new Error('catalog unavailable'));
    });

    it('skips PDF text extraction when existing index already covers expected pages', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        const cachedIndex = {
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
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

        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
        });

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

        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 3,
        });

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

        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
        });

        expect(mocks.extractTextFromPdf).toHaveBeenCalledWith('/tmp/file.pdf', {pageCount: 1});
        expect(mocks.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(result.pages).toEqual([expect.objectContaining({
            pageNumber: 1,
            text: 'from-pdftotext',
        })]);
    });

    it('uses pdftotext before pdfjs for high page-count PDFs below the byte threshold', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.stat.mockResolvedValue({ size: 87 * 1024 * 1024 });
        mocks.extractTextFromPdf.mockResolvedValue([{
            pageNumber: 7,
            text: 'kurdan',
        }]);

        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2136,
        });

        expect(mocks.extractTextFromPdf).toHaveBeenCalledWith('/tmp/file.pdf', {pageCount: 2136});
        expect(mocks.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(result.pageCount).toBe(2136);
        expect(result.pages).toHaveLength(2136);
        expect(result.pages[6]).toEqual(expect.objectContaining({
            pageNumber: 7,
            text: 'kurdan',
        }));
    });

    it('carries pdfjs word-box rotation into the search index', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.extractTextWithPdfjsWordBoxes.mockImplementation(async (_path: string, options: IPdfjsMockOptions) => {
            options.onPageText?.({
                pageNumber: 1,
                text: 'rotated \n',
                pageWidth: 200,
                pageHeight: 100,
                rotation: 90,
                words: [{
                    text: 'rotated',
                    x: 10,
                    y: 20,
                    width: 30,
                    height: 40,
                }],
            });
            return [];
        });

        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 1,
        });

        expect(result.pages).toEqual([expect.objectContaining({
            pageNumber: 1,
            text: 'rotated \n',
            pageWidth: 200,
            pageHeight: 100,
            rotation: 90,
            words: [expect.objectContaining({ text: 'rotated' })],
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
            {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 2,
            },
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

    it('validates a built JSON index before writing it to disk', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.extractTextWithPdfjs.mockResolvedValue([]);
        mocks.extractTextFromPdf.mockResolvedValue([]);

        await expect(buildSearchIndex(
            '/tmp/file.pdf',
            [{
                pageNumber: 1,
                words: [],
                text: 'oversized text',
            }],
            {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 1,
                validateBeforePersist: () => {
                    throw new Error('over budget');
                },
            },
        )).rejects.toThrow('over budget');

        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('strips oversized word geometry from legacy JSON while returning the in-memory geometry index', async () => {
        vi.resetModules();
        vi.stubEnv('EVB_SEARCH_LEGACY_JSON_MAX_GEOMETRY_WORDS', '1000');

        try {
            const { buildSearchIndex } = await import('@electron/search/indexBuilder');
            mocks.extractTextWithPdfjsWordBoxes.mockImplementation(async (_path: string, options: IPdfjsMockOptions) => {
                options.onPageText?.({
                    pageNumber: 1,
                    text: 'alpha beta gamma \n',
                    pageWidth: 100,
                    pageHeight: 200,
                    words: Array.from({length: 1001}, (_, index) => ({
                        text: index === 0 ? 'alpha' : `word-${index}`,
                        x: index,
                        y: index,
                        width: 3,
                        height: 4,
                    })),
                });
                return [];
            });

            const result = await buildSearchIndex('/tmp/file.pdf', [], {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 1,
            });

            const legacyJsonPayload = mocks.writeFile.mock.calls.find(([path]) => path === '/tmp/file.pdf.index.json.tmp')?.[1];

            expect(result.pages[0]).toEqual(expect.objectContaining({
                pageNumber: 1,
                text: 'alpha beta gamma \n',
                pageWidth: 100,
                pageHeight: 200,
                words: expect.arrayContaining([expect.objectContaining({ text: 'alpha' })]),
            }));
            expect(JSON.parse(String(legacyJsonPayload)).pages).toEqual([{
                pageNumber: 1,
                text: 'alpha beta gamma \n',
            }]);
            expect(mocks.persistCompactSearchIndex).toHaveBeenCalledWith('/tmp/file.pdf', {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 1,
                pages: [expect.objectContaining({
                    pageNumber: 1,
                    text: 'alpha beta gamma \n',
                })],
            }, undefined);
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });

    it('retries legacy JSON persistence without geometry after an invalid string length error', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.extractTextWithPdfjsWordBoxes.mockImplementation(async (_path: string, options: IPdfjsMockOptions) => {
            options.onPageText?.({
                pageNumber: 1,
                text: 'alpha beta \n',
                pageWidth: 100,
                pageHeight: 200,
                words: [{
                    text: 'alpha',
                    x: 1,
                    y: 2,
                    width: 3,
                    height: 4,
                }],
            });
            return [];
        });

        const originalStringify = JSON.stringify;
        let failedFullGeometryStringify = false;
        const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation((
            value: unknown,
            replacer?: Parameters<typeof JSON.stringify>[1],
            space?: Parameters<typeof JSON.stringify>[2],
        ) => {
            const pages = typeof value === 'object' && value !== null
                ? (value as { pages?: unknown }).pages
                : undefined;
            const hasGeometry = Array.isArray(pages) && pages.some(page => (
                typeof page === 'object'
                && page !== null
                && Array.isArray((page as { words?: unknown }).words)
            ));
            if (!failedFullGeometryStringify && hasGeometry) {
                failedFullGeometryStringify = true;
                throw new RangeError('Invalid string length');
            }
            return originalStringify(value, replacer, space);
        });

        try {
            const result = await buildSearchIndex('/tmp/file.pdf', [], {
                documentRevision: DOCUMENT_REVISION,
                pageCount: 1,
            });
            const legacyJsonPayload = mocks.writeFile.mock.calls.find(([path]) => path === '/tmp/file.pdf.index.json.tmp')?.[1];

            expect(failedFullGeometryStringify).toBe(true);
            expect(result.pages[0]).toEqual(expect.objectContaining({
                pageNumber: 1,
                text: 'alpha beta \n',
                pageWidth: 100,
                pageHeight: 200,
                words: [expect.objectContaining({ text: 'alpha' })],
            }));
            expect(JSON.parse(String(legacyJsonPayload)).pages).toEqual([{
                pageNumber: 1,
                text: 'alpha beta \n',
            }]);
        } finally {
            stringifySpy.mockRestore();
        }
    });

    it('uses OCR v3 words as text-layer-compatible search text and persists index best-effort', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mockCatalog(2, [
            {
                pageNumber: 1,
                text: 'alpha beta \n',
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
            },
            {
                pageNumber: 2,
                text: 'line \ntwo \n',
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
            },
        ]);
        mocks.existsSync.mockReturnValue(true);
        const manifest = {
            version: 3,
            documentRevision: { token: requireDocumentRevisionToken('revision-token') },
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
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
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
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
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

        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
        });

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
        expect(result.schemaVersion).toBe(7);
        expect(result.textSource).toEqual({
            kind: 'ocr-v2-text-layer',
            version: 1,
        });
        expect(mocks.persistCompactSearchIndexBestEffort).toHaveBeenCalledWith('/tmp/file.pdf', {
            documentRevision: DOCUMENT_REVISION,
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

    it('preserves partial OCR v3 pages and fills missing pages from PDF text extraction', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mockCatalog(2, [{
            pageNumber: 1,
            text: 'ocr \n',
            words: [{
                text: 'ocr',
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }],
        }]);
        mocks.existsSync.mockImplementation((path: string) => (
            path.endsWith('manifest.json') || path.endsWith('page-1.json')
        ));
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path.endsWith('manifest.json')) {
                return JSON.stringify({
                    version: 3,
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
                    createdAt: 1,
                    source: { pdfPath: '/tmp/file.pdf' },
                    pageCount: 2,
                    pageBox: 'crop',
                    ocr: {
                        engine: 'tesseract',
                        languages: ['eng'],
                        renderDpi: 300,
                    },
                    pages: { 1: { path: 'page-1.json' } },
                });
            }
            if (path.endsWith('page-1.json')) {
                return JSON.stringify({
                    pageNumber: 1,
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
                    text: 'ocr page one',
                    words: [{
                        text: 'ocr',
                        x: 1,
                        y: 2,
                        width: 3,
                        height: 4,
                    }],
                });
            }
            throw new Error(`Unexpected read: ${path}`);
        });
        mocks.extractTextWithPdfjs.mockImplementation(async (_path: string, options: IPdfjsMockOptions) => {
            options.onPageText?.({
                pageNumber: 1,
                text: 'weaker pdf page one',
            });
            options.onPageText?.({
                pageNumber: 2,
                text: 'pdf page two',
            });
            return [];
        });
        mocks.extractTextFromPdf.mockResolvedValue([]);

        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
        });

        expect(mocks.extractTextWithPdfjs).toHaveBeenCalledOnce();
        expect(result.pages).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                text: 'ocr \n',
                words: [expect.objectContaining({ text: 'ocr' })],
            }),
            expect.objectContaining({
                pageNumber: 2,
                text: 'pdf page two',
            }),
        ]);
        expect(result.pageCount).toBe(2);
        expect(result.textSource).toBeUndefined();
    });

    it('uses OCR v3 manifest pageCount as the effective count for partial sidecars', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mockCatalog(2, [{
            pageNumber: 1,
            text: 'ocr \n',
            words: [{
                text: 'ocr',
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }],
            render: {
                dpi: 300,
                imagePx: {
                    w: 100,
                    h: 200,
                },
            },
        }]);
        mocks.existsSync.mockImplementation((path: string) => (
            path.endsWith('manifest.json') || path.endsWith('page-1.json')
        ));
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path.endsWith('manifest.json')) {
                return JSON.stringify({
                    version: 3,
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
                    createdAt: 1,
                    source: { pdfPath: '/tmp/file.pdf' },
                    pageCount: 2,
                    pageBox: 'crop',
                    ocr: {
                        engine: 'tesseract',
                        languages: ['eng'],
                        renderDpi: 300,
                    },
                    pages: { 1: { path: 'page-1.json' } },
                });
            }
            if (path.endsWith('page-1.json')) {
                return JSON.stringify({
                    pageNumber: 1,
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
                    render: {
                        dpi: 300,
                        imagePx: {
                            w: 100,
                            h: 200,
                        },
                    },
                    words: [{
                        text: 'ocr',
                        x: 1,
                        y: 2,
                        width: 3,
                        height: 4,
                    }],
                });
            }
            if (path.endsWith('file.pdf.index.json')) {
                return JSON.stringify({
                    schemaVersion: 6,
                    pdfPath: '/tmp/file.pdf',
                    createdAt: 1,
                    pageCount: 1,
                    pages: [{
                        pageNumber: 1,
                        text: 'old cached page',
                        pageWidth: 100,
                        pageHeight: 200,
                        words: [{
                            text: 'old',
                            x: 0,
                            y: 0,
                            width: 1,
                            height: 1,
                        }],
                    }],
                });
            }
            throw new Error(`Unexpected read: ${path}`);
        });
        mocks.extractTextWithPdfjs.mockImplementation(async (_path: string, options: IPdfjsMockOptions) => {
            options.onPageText?.({
                pageNumber: 2,
                text: 'manifest missing page',
            });
            return [];
        });
        mocks.extractTextFromPdf.mockResolvedValue([]);

        const result = await buildSearchIndex('/tmp/file.pdf', [], {documentRevision: DOCUMENT_REVISION});

        expect(mocks.extractTextWithPdfjs).toHaveBeenCalledOnce();
        expect(result.pages).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                text: 'ocr \n',
            }),
            expect.objectContaining({
                pageNumber: 2,
                text: 'manifest missing page',
            }),
        ]);
        expect(result.pageCount).toBe(2);
    });

    it('does not extract full PDF text to complete large partial OCR sidecars', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mockCatalog(2136, [{
            pageNumber: 7,
            text: 'Kurdan front matter',
        }]);
        mocks.existsSync.mockImplementation((path: string) => (
            path.endsWith('manifest.json') || path.endsWith('page-7.json')
        ));
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path.endsWith('manifest.json')) {
                return JSON.stringify({
                    version: 3,
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
                    createdAt: 1,
                    source: { pdfPath: '/tmp/large.pdf' },
                    pageCount: 2136,
                    pageBox: 'crop',
                    ocr: {
                        engine: 'tesseract',
                        languages: [
                            'kmr',
                            'tur',
                        ],
                        renderDpi: 300,
                    },
                    pages: { 7: { path: 'page-7.json' } },
                });
            }
            if (path.endsWith('page-7.json')) {
                return JSON.stringify({
                    pageNumber: 7,
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
                    render: {
                        dpi: 300,
                        imagePx: {
                            w: 100,
                            h: 200,
                        },
                    },
                    text: 'Kurdan front matter',
                    words: [],
                });
            }
            throw new Error(`Unexpected read: ${path}`);
        });

        const result = await buildSearchIndex('/tmp/large.pdf', [], {documentRevision: DOCUMENT_REVISION});

        expect(mocks.extractTextWithPdfjsWordBoxes).not.toHaveBeenCalled();
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
        expect(result.pageCount).toBe(2136);
        expect(result.pages).toHaveLength(2136);
        expect(result.pages[6]).toMatchObject({
            pageNumber: 7,
            text: 'Kurdan front matter',
        });
        expect(result.pages[0]).toMatchObject({
            pageNumber: 1,
            text: '',
        });
    });

    it('uses catalog geometry instead of compact text-only sidecars', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mockCatalog(2, [
            {
                pageNumber: 1,
                text: 'json \n',
                words: [{
                    text: 'json',
                    x: 1,
                    y: 2,
                    width: 3,
                    height: 4,
                }],
                render: {
                    dpi: 300,
                    imagePx: {
                        w: 100,
                        h: 200,
                    },
                },
            },
            {
                pageNumber: 2,
                text: 'geometry \n',
                words: [{
                    text: 'geometry',
                    x: 5,
                    y: 6,
                    width: 7,
                    height: 8,
                }],
                render: {
                    dpi: 300,
                    imagePx: {
                        w: 100,
                        h: 200,
                    },
                },
            },
        ]);
        mocks.existsSync.mockReturnValue(true);
        const manifest = {
            version: 3,
            documentRevision: { token: requireDocumentRevisionToken('revision-token') },
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
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
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
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
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
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
            onPageIndexed,
        });

        expect(mocks.loadCompactSearchIndex).not.toHaveBeenCalled();
        expect(mocks.resolveDocumentTextCatalogSnapshot).toHaveBeenCalledOnce();
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
        expect(result.pages).toEqual([
            expect.objectContaining({
                pageNumber: 1,
                text: 'json \n',
                pageWidth: 100,
                pageHeight: 200,
                words: [expect.objectContaining({ text: 'json' })],
            }),
            expect.objectContaining({
                pageNumber: 2,
                text: 'geometry \n',
                pageWidth: 100,
                pageHeight: 200,
                words: [expect.objectContaining({ text: 'geometry' })],
            }),
        ]);
        expect(onPageIndexed).toHaveBeenCalledWith(expect.objectContaining({
            pageNumber: 1,
            text: 'json \n',
            pageWidth: 100,
            pageHeight: 200,
        }));
        expect(onPageIndexed).toHaveBeenCalledWith(expect.objectContaining({
            pageNumber: 2,
            text: 'geometry \n',
            pageWidth: 100,
            pageHeight: 200,
        }));
    });

    it('ignores stale OCR v3 sidecar pages outside the current page count', async () => {
        const { buildSearchIndex } = await import('@electron/search/indexBuilder');
        mocks.existsSync.mockImplementation((path: string) => (
            path.endsWith('manifest.json') || path.endsWith('page-3.json')
        ));
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path.endsWith('manifest.json')) {
                return JSON.stringify({
                    version: 3,
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
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
                    documentRevision: { token: requireDocumentRevisionToken('revision-token') },
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

        const result = await buildSearchIndex('/tmp/file.pdf', [], {
            documentRevision: DOCUMENT_REVISION,
            pageCount: 2,
        });

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
