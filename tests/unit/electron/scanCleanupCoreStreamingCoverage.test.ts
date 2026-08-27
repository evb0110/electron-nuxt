import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
    TScanCleanupProgress,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {
    createArrayBackedPdfPageSizeStore,
    PDF_PAGE_SIZE_SIDECAR_FORMAT,
    PDF_PAGE_SIZE_SIDECAR_MAX_CHUNK_BYTES,
    PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
    readPdfPageSizeChunks,
    readPdfPageSizes,
    type IPdfPageSize,
    type IPdfPageSizeStore,
} from '@scan-cleanup-core/pdfPageSizes';
import {createFileBackedScanCleanupResultStore} from '@scan-cleanup-core/fileBackedResultStore';
import {
    readDetectionResultsForPageNumbers,
    runScanCleanupConversion,
    type IRunScanCleanupPipelineDependencies,
    type IScanCleanupWorkerPaths,
} from '@scan-cleanup-core/runScanCleanupConversion';
import type {
    IScanCleanupDetectionResultStore,
    IPdfPageSizeChunk,
    TScanCleanupLog,
} from '@scan-cleanup-core/types';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';

const roots: string[] = [];
const PPM = Buffer.concat([
    Buffer.from('P6\n1 1\n255\n', 'ascii'),
    Buffer.from([
        0,
        0,
        0,
    ]),
]);

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'color',
    readingOrder: 'ltr',
    thickness: 0,
    crop: false,
    matchPageSize: false,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 0,
        topMm: 0,
        rightMm: 0,
        bottomMm: 0,
    },
    despeckle: true,
    skipBlankPages: false,
    pageOverrides: {},
};

const policy: IScanCleanupRuntimePolicy = {
    rasterConcurrency: 2,
    rasterStreaming: true,
    logicalCpus: 8,
    totalRamBytes: 8 * 1024 ** 3,
};

function pageGeometry(pageNumber: number): IPdfPageSize {
    return {
        pageNumber,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 72,
        heightPoints: 72,
        rotation: 0,
    };
}

function paths(tempDir: string): IScanCleanupWorkerPaths {
    return {
        qpdfBinary: '/qpdf',
        pdftoppmBinary: '/pdftoppm',
        scanCleanupBinary: '/scan-cleanup',
        pdfImageCombineBinary: '/pdf-image-combine',
        tempDir,
        provenanceStampSupport: false,
    };
}

function outputMetadata() {
    return {
        outputWidthPx: 1,
        outputHeightPx: 1,
        canvasWidthPx: 1,
        canvasHeightPx: 1,
        placementOffsetXPx: 0,
        placementOffsetYPx: 0,
        forwardTransform: null,
        rotationDegrees: 0,
        renderDpi: 300,
        layoutClassification: 'single-uncut-page',
        skewApplied: true,
        bilevelWritten: false,
        layeredWritten: false,
        half: 'full',
        outputMode: 'color',
        contentBox: {
            xPx: 0,
            yPx: 0,
            widthPx: 1,
            heightPx: 1,
        },
        warnings: [],
    };
}

function pageMetadata() {
    return {
        layoutClassification: 'single-uncut-page',
        cutterXPx: null,
        rotationDegrees: 0,
        canvasScope: 'document',
        excluded: false,
        blankOutputsSkipped: 0,
        outputCount: 1,
    };
}

function sidecarPage(pageNumber: number) {
    return {
        pageNumber,
        xPoints: 0,
        yPoints: 0,
        widthInches: 8.5,
        heightInches: 11,
        rotation: pageNumber === 1 ? 90 : 0,
        mediaXPoints: 0,
        mediaYPoints: 0,
        mediaWidthPoints: 612,
        mediaHeightPoints: 792,
        cropXPoints: 10,
        cropYPoints: 20,
        cropWidthPoints: 590,
        cropHeightPoints: 760,
        renderBox: 'cropbox',
        dominantImageWidthPx: 2_550,
        dominantImageHeightPx: 3_300,
        dominantImageWidthPoints: 612,
        dominantImageHeightPoints: 792,
    };
}

async function writePageSizeSidecar(
    outputPath: string,
    pages: readonly unknown[],
) {
    const header = {
        format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
        schemaVersion: PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
        pageCount: pages.length,
        declaredPageCount: pages.length,
        reachablePageCount: pages.length,
        chunkBytes: PDF_PAGE_SIZE_SIDECAR_MAX_CHUNK_BYTES,
        dominantImageAnalysis: 'performed',
    };
    const chunk = {
        chunkIndex: 0,
        firstPageNumber: 1,
        pages,
    };
    await writeFile(outputPath, `${JSON.stringify(header)}\n${JSON.stringify(chunk)}\n`);
}

function pdfInfoWindow(firstPageNumber: number, lastPageNumber: number) {
    const lines = [`Pages: ${String(lastPageNumber)}`];
    for (let pageNumber = firstPageNumber; pageNumber <= lastPageNumber; pageNumber += 1) {
        lines.push(`Page ${String(pageNumber)} size: 612 x 792 pts (Letter)`);
        lines.push(`Page ${String(pageNumber)} rot: ${pageNumber === 1 ? '90' : '0'}`);
        lines.push(`Page ${String(pageNumber)} MediaBox: 0 0 612 792`);
        lines.push(`Page ${String(pageNumber)} CropBox: 0 0 612 792`);
    }
    return `${lines.join('\n')}\n`;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

describe('scan-cleanup-core conversion coverage', () => {
    it('reads empty, sparse, and long contiguous detection windows with bounded calls', async () => {
        const records = new Map<number, IScanCleanupDetectionResult>();
        for (let pageNumber = 1; pageNumber <= 1_025; pageNumber += 1) {
            records.set(pageNumber, {pageNumber} as IScanCleanupDetectionResult);
        }
        const getPage = vi.fn(async (pageNumber: number) =>
            pageNumber === 2_000 ? undefined : records.get(pageNumber));
        const readRange = vi.fn(async (firstPageNumber: number, lastPageNumberExclusive: number) => {
            const result: IScanCleanupDetectionResult[] = [];
            for (let pageNumber = firstPageNumber; pageNumber < lastPageNumberExclusive; pageNumber += 1) {
                const record = records.get(pageNumber);
                if (record !== undefined) result.push(record);
            }
            return result;
        });
        const store: IScanCleanupDetectionResultStore = {
            append: async () => undefined,
            close: async () => undefined,
            forEachChunk: async () => undefined,
            getPage,
            pageCount: 2_000,
            readRange,
            replace: async () => undefined,
            resultCount: records.size,
        };
        const signal = new AbortController().signal;

        await expect(readDetectionResultsForPageNumbers(store, [], signal)).resolves.toEqual([]);
        await expect(readDetectionResultsForPageNumbers(store, [
            1,
            2_000,
        ], signal)).resolves.toEqual([{pageNumber: 1}]);
        expect(getPage).toHaveBeenCalledWith(1);
        expect(getPage).toHaveBeenCalledWith(2_000);

        const contiguous = await readDetectionResultsForPageNumbers(
            store,
            Array.from({length: 1_025}, (_, index) => index + 1),
            signal,
        );
        expect(contiguous).toHaveLength(1_025);
        expect(readRange).toHaveBeenNthCalledWith(1, 1, 1_025);
        expect(readRange).toHaveBeenNthCalledWith(2, 1_025, 1_026);

        const controller = new AbortController();
        controller.abort(new Error('detection window canceled'));
        await expect(readDetectionResultsForPageNumbers(store, [1], controller.signal))
            .rejects.toThrow('detection window canceled');
    });

    it('rejects invalid result-store writes and bounded reads without losing cleanup', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-result-store-errors-test-'));
        roots.push(root);
        await expect(createFileBackedScanCleanupResultStore({
            pageCount: -1,
            pageNumberOf: (record: {pageNumber: number}) => record.pageNumber,
            rootDir: root,
        })).rejects.toThrow('non-negative safe integer');
        const invalidPageNumberReaderOptions = {
            pageCount: 2,
            pageNumberOf: (record: {pageNumber: number}) => record.pageNumber,
            rootDir: root,
        };
        Reflect.set(invalidPageNumberReaderOptions, 'pageNumberOf', undefined);
        await expect(createFileBackedScanCleanupResultStore(invalidPageNumberReaderOptions))
            .rejects.toThrow('page-number reader');

        const store = await createFileBackedScanCleanupResultStore({
            maxReadPages: 1,
            pageCount: 2,
            pageNumberOf: (record: {pageNumber: number}) => record.pageNumber,
            rootDir: root,
        });
        await expect(store.append({pageNumber: 0})).rejects.toThrow('has no page 0');
        await expect(store.append({pageNumber: 1})).resolves.toBeUndefined();
        await expect(store.append({pageNumber: 1})).rejects.toThrow('already contains page 1');
        await expect(store.replace(2, {pageNumber: 1})).rejects.toThrow('received page 1 for page 2');
        await expect(store.replace(2, {pageNumber: 2})).rejects.toThrow('replace missing page 2');
        await expect(store.getPage(3)).rejects.toThrow('has no page 3');
        await expect(store.readRange(0, 1)).rejects.toThrow('read range is invalid');
        await expect(store.readRange(1, 3)).rejects.toThrow('bounded window');
        await store.close();
        await expect(store.append({pageNumber: 2})).rejects.toThrow('result store is closed');
    });

    it.each([
        [
            'invalid JSON',
            '{not-json}\n',
            'contains invalid JSON',
        ],
        [
            'unterminated JSON',
            '{"pageNumber":1}',
            'unterminated or oversized record',
        ],
    ])('reports a %s file-backed record', async (_label, contents, message) => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-result-store-record-test-'));
        roots.push(root);
        const store = await createFileBackedScanCleanupResultStore({
            pageCount: 1,
            pageNumberOf: (record: {pageNumber: number}) => record.pageNumber,
            rootDir: root,
        });
        await store.append({pageNumber: 1});
        const [directory] = await readdir(root);
        await writeFile(join(root, directory!, 'records.jsonl'), contents);
        await expect(store.getPage(1)).rejects.toThrow(message);
        await store.close();
    });

    it('streams native page geometry and enriches it with bounded box metadata', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-page-size-test-'));
        roots.push(root);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-source');
        const log = vi.fn<TScanCleanupLog>();
        const runCommand = vi.fn(async (_command: string, args: string[]) => {
            if (args.includes('--output')) {
                await writePageSizeSidecar(
                    args[args.indexOf('--output') + 1]!,
                    [
                        sidecarPage(1),
                        sidecarPage(2),
                    ],
                );
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            expect(args).toEqual([
                '-f',
                '1',
                '-l',
                '2',
                '-box',
                sourcePdfPath,
            ]);
            return {
                exitCode: 0,
                stdout: [
                    'Pages: 2',
                    'Page 1 size: 612 x 792 pts (Letter)',
                    'Page 1 rot: 90',
                    'Page 1 MediaBox: 0 0 612 792',
                    'Page 1 CropBox: 10 20 600 780',
                    'Page 2 size: 612 x 792 pts (Letter)',
                    'Page 2 rot: 0',
                    'Page 2 MediaBox: 0 0 612 792',
                    'Page 2 CropBox: 0 0 612 792',
                    '',
                ].join('\n'),
                stderr: '',
            };
        });
        const options = {
            pdfPageOpsBinary: '/pdf-page-ops',
            pdfinfoBinary: '/pdfinfo',
            qpdfBinary: '/qpdf',
            tempDir: root,
            log,
            runCommand,
        };
        const chunks: IPdfPageSizeChunk[] = [];
        for await (const chunk of readPdfPageSizeChunks(sourcePdfPath, options)) {
            chunks.push(chunk);
        }
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.pages[0]).toMatchObject({
            widthPoints: 612,
            heightPoints: 792,
            rotation: 90,
            dominantImageWidthPx: 2_550,
            renderBox: 'cropbox',
        });
        expect(chunks[0]?.dominantImageAnalysis).toBe('performed');

        const pageSizes = await readPdfPageSizes(sourcePdfPath, {
            ...options,
            resolveSuspiciousCropBoxFallback: false,
        });
        expect(pageSizes).toHaveLength(2);
        expect(pageSizes[0]).toMatchObject({
            xPoints: 10,
            yPoints: 20,
            widthPoints: 590,
            heightPoints: 760,
            renderBox: 'cropbox',
            mediaWidthPoints: 612,
            cropWidthPoints: 590,
        });
        expect(pageSizes[1]?.rotation).toBe(0);
        expect(log).not.toHaveBeenCalledWith('warn', expect.any(String));
    });

    it('falls back to bounded pdfinfo windows and retains legacy page-ops JSON', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-page-size-fallback-test-'));
        roots.push(root);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-source');
        const log = vi.fn<TScanCleanupLog>();
        const pdfInfoCommand = vi.fn(async (_command: string, args: string[]) => {
            if (args.length === 1) {
                return {
                    exitCode: 0,
                    stdout: 'Pages: 513\n',
                    stderr: '',
                };
            }
            const firstPageNumber = Number(args[1]);
            const lastPageNumber = Number(args[3]);
            return {
                exitCode: 0,
                stdout: pdfInfoWindow(firstPageNumber, lastPageNumber),
                stderr: '',
            };
        });
        const pdfInfoOptions = {
            pdfinfoBinary: '/pdfinfo',
            tempDir: root,
            log,
            runCommand: pdfInfoCommand,
        };
        const chunks: IPdfPageSizeChunk[] = [];
        for await (const chunk of readPdfPageSizeChunks(sourcePdfPath, pdfInfoOptions)) {
            chunks.push(chunk);
        }
        expect(chunks.map(chunk => [
            chunk.firstPageNumber,
            chunk.pages.length,
        ])).toEqual([
            [
                1,
                512,
            ],
            [
                513,
                1,
            ],
        ]);
        expect(chunks[0]?.pages[0]?.rotation).toBe(90);
        expect(pdfInfoCommand).toHaveBeenCalledTimes(3);

        const legacyRunCommand = vi.fn(async (_command: string, args: string[]) => {
            await writeFile(
                args[args.indexOf('--output') + 1]!,
                JSON.stringify({pages: [
                    sidecarPage(1),
                    sidecarPage(2),
                ]}),
            );
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const legacyChunks: IPdfPageSizeChunk[] = [];
        for await (const chunk of readPdfPageSizeChunks(sourcePdfPath, {
            pdfPageOpsBinary: '/pdf-page-ops',
            tempDir: root,
            log,
            runCommand: legacyRunCommand,
        })) {
            legacyChunks.push(chunk);
        }
        expect(legacyChunks).toHaveLength(1);
        expect(legacyChunks[0]?.pages.map(page => page.pageNumber)).toEqual([
            1,
            2,
        ]);
        expect(legacyChunks[0]?.dominantImageAnalysis).toBe('unknown');
    });

    it('converts selected pages through the xlarge geometry sidecar coordinator', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-xlarge-conversion-test-'));
        roots.push(root);
        const sourcePdfPath = join(root, 'source.pdf');
        const outputPdfPath = join(root, 'output.pdf');
        await writeFile(sourcePdfPath, '%PDF-xlarge-source');
        const documentPageCount = SCAN_CLEANUP_STREAMING_BATCH_PAGES + 1;
        const pageSizeStore: IPdfPageSizeStore = {
            pageCount: documentPageCount,
            getPage: vi.fn(async pageNumber => pageGeometry(pageNumber)),
            readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) => Array.from(
                {length: lastPageNumberExclusive - firstPageNumber},
                (_, index) => pageGeometry(firstPageNumber + index),
            )),
            forEachChunk: vi.fn(async onChunk => {
                const chunkSize = 1_024;
                let chunkIndex = 0;
                for (
                    let firstPageNumber = 1;
                    firstPageNumber <= documentPageCount;
                    firstPageNumber += chunkSize
                ) {
                    const pages = Array.from(
                        {length: Math.min(chunkSize, documentPageCount - firstPageNumber + 1)},
                        (_, index) => pageGeometry(firstPageNumber + index),
                    );
                    await onChunk({
                        pageCount: documentPageCount,
                        chunkIndex,
                        firstPageNumber,
                        offset: 0,
                        byteLength: 0,
                        pages,
                    });
                    chunkIndex += 1;
                }
            }),
            close: vi.fn(async () => undefined),
        };
        const renderPagePpm = vi.fn(async (
            _paths: Pick<IScanCleanupWorkerPaths, 'pdftoppmBinary'>,
            _log: TScanCleanupLog,
            _pageNumber: number,
            _source: string,
            outputPath: string,
        ) => {
            await writeFile(outputPath, PPM);
        });
        const progress: TScanCleanupProgress[] = [];
        const log = vi.fn<TScanCleanupLog>();
        const runSidecar = vi.fn(async (
            _binaryPath,
            manifestPath,
            _signal,
            _log,
            onProgress,
        ) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                outputs: Array<{
                    metadataPath: string;
                    outputPath: string;
                }>;
            }>;};
            for (const [
                index,
                page,
            ] of manifest.pages.entries()) {
                const output = page.outputs[0]!;
                await writeFile(output.outputPath, 'composite');
                await writeFile(output.metadataPath, JSON.stringify(outputMetadata()));
                await writeFile(page.pageMetadataPath, JSON.stringify(pageMetadata()));
                onProgress({
                    stage: 'page-complete',
                    completedPages: index + 1,
                    totalPages: manifest.pages.length,
                    pageNumber: index + 1,
                });
            }
        });
        const runCommand = vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputIndex = args.indexOf('--output');
            if (outputIndex >= 0) {
                await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
            }
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const sourceDpi = {
            detected: true,
            documentDpi: 300,
            getPageRaster: (pageNumber: number) => ({
                dpi: pageNumber === 1 ? 300 : 150,
                width: 300,
                height: 300,
            }),
        };
        const dependencies: IRunScanCleanupPipelineDependencies = {
            getPageCount: vi.fn(async () => documentPageCount),
            getPageSizeStore: vi.fn(async () => pageSizeStore),
            detectSourceDpi: vi.fn(async () => sourceDpi),
            createRasterPipes: vi.fn(async () => undefined),
            renderPage: vi.fn(),
            renderPagePpm,
            runSidecar,
            runCommand,
            getAvailableScratchBytes: vi.fn(async () => null),
            hashNativeBinary: vi.fn(async () => 'a'.repeat(64)),
        };

        const summary = await runScanCleanupConversion(
            {
                sourcePdfPath,
                outputPdfPath,
                options,
                sourcePageNumbers: [
                    1,
                    2,
                ],
            },
            {
                ...paths(root),
                pdfimagesBinary: '/pdfimages',
            },
            new AbortController().signal,
            progress.push.bind(progress),
            policy,
            log,
            dependencies,
        );

        expect(summary).toMatchObject({
            inputPages: 2,
            outputPages: 2,
        });
        expect(await readFile(outputPdfPath, 'utf8')).toContain('%PDF-1.7');
        expect(pageSizeStore.forEachChunk).toHaveBeenCalledOnce();
        expect(pageSizeStore.close).toHaveBeenCalledOnce();
        expect(dependencies.createRasterPipes).toHaveBeenCalledOnce();
        expect(runSidecar).toHaveBeenCalledOnce();
        expect(renderPagePpm).toHaveBeenCalledTimes(4);
        expect(progress.at(-1)).toMatchObject({
            stage: 'handoff',
            completedUnits: 2,
            totalUnits: 2,
        });
    });

    it('runs the bounded PPM handoff and publishes a color output', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-core-conversion-test-'));
        roots.push(root);
        const sourcePdfPath = join(root, 'source.pdf');
        const outputPdfPath = join(root, 'output.pdf');
        await writeFile(sourcePdfPath, '%PDF-source');
        const pageSizes = [
            pageGeometry(1),
            pageGeometry(2),
        ];
        const pageSizeStore = createArrayBackedPdfPageSizeStore(pageSizes);
        const renderPagePpm = vi.fn(async (
            _paths: Pick<IScanCleanupWorkerPaths, 'pdftoppmBinary'>,
            _log: TScanCleanupLog,
            _pageNumber: number,
            _source: string,
            outputPath: string,
        ) => {
            await writeFile(outputPath, PPM);
        });
        const progress: TScanCleanupProgress[] = [];
        const log = vi.fn<TScanCleanupLog>();
        const dependencies: IRunScanCleanupPipelineDependencies = {
            getPageCount: vi.fn(async () => pageSizes.length),
            getPageSizeStore: vi.fn(async () => pageSizeStore),
            detectSourceDpi: vi.fn(async () => ({
                detected: true,
                documentDpi: 300,
                getPageRaster: (pageNumber: number) => ({
                    dpi: pageNumber === 1 ? 300 : 150,
                    width: 300,
                    height: 300,
                }),
            })),
            createRasterPipes: vi.fn(async () => undefined),
            renderPage: vi.fn(),
            renderPagePpm,
            runSidecar: vi.fn(async (
                _binaryPath,
                manifestPath,
                _signal,
                _log,
                onProgress,
            ) => {
                const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                    pageMetadataPath: string;
                    outputs: Array<{
                        metadataPath: string;
                        outputPath: string;
                    }>;
                }>};
                for (const [
                    index,
                    page,
                ] of manifest.pages.entries()) {
                    const output = page.outputs[0]!;
                    await writeFile(output.outputPath, 'composite');
                    await writeFile(output.metadataPath, JSON.stringify(outputMetadata()));
                    await writeFile(page.pageMetadataPath, JSON.stringify(pageMetadata()));
                    onProgress({
                        stage: 'page-complete',
                        completedPages: index + 1,
                        totalPages: manifest.pages.length,
                        pageNumber: index + 1,
                    });
                }
            }),
            runCommand: vi.fn(async (command, args) => {
                if (args[0] === '--check') {
                    return {
                        exitCode: 0,
                        stdout: '',
                        stderr: '',
                    };
                }
                const outputIndex = args.indexOf('--output');
                if (outputIndex >= 0) {
                    await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
                }
                return {
                    exitCode: command === '/qpdf' ? 0 : 0,
                    stdout: '',
                    stderr: '',
                };
            }),
            getAvailableScratchBytes: vi.fn(async () => null),
            hashNativeBinary: vi.fn(async () => 'a'.repeat(64)),
        };

        const summary = await runScanCleanupConversion(
            {
                sourcePdfPath,
                outputPdfPath,
                options,
            },
            paths(root),
            new AbortController().signal,
            progress.push.bind(progress),
            policy,
            log,
            dependencies,
        );

        expect(summary).toMatchObject({
            inputPages: 2,
            outputPages: 2,
            spreadsSplit: 0,
            excludedPages: 0,
        });
        expect(await readFile(outputPdfPath, 'utf8')).toContain('%PDF-1.7');
        expect(dependencies.createRasterPipes).toHaveBeenCalledOnce();
        expect(renderPagePpm).toHaveBeenCalledTimes(4);
        expect(dependencies.runSidecar).toHaveBeenCalledOnce();
        expect(progress.at(-1)).toMatchObject({
            stage: 'handoff',
            completedUnits: 2,
            totalUnits: 2,
        });
        expect(log).not.toHaveBeenCalledWith('warn', expect.any(String));
    });
});
