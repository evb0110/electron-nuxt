import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {promisify} from 'node:util';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    runScanCleanupDetection,
    type IScanCleanupDetectionRetention,
} from '@scan-cleanup-core/detection';
import type {IScanCleanupDetectionRequest} from '@contracts/electronApiScanCleanup';

const dirs: string[] = [];
const MIB = 1024 * 1024;
const execFileAsync = promisify(execFile);

function createRequest(): IScanCleanupDetectionRequest {
    return {
        ownerId: 'owner',
        sourcePdfPath: '/tmp/input.pdf',
        documentRevision: 'revision',
        options: {
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'auto',
            readingOrder: 'ltr',
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'top-center',
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
            skipBlankPages: false,
            pageOverrides: {},
        },
    };
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        force: true,
        recursive: true,
    })));
});

describe('runScanCleanupDetection non-stream raster admission', () => {
    it.runIf(process.platform !== 'win32')('bounds 101 fast staged rasters by producer concurrency and unlinks each after FIFO delivery', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const pageCount = 101;
        const rasterConcurrency = 3;
        const beginConsumption = Promise.withResolvers<undefined>();
        const stagedPaths = new Map<number, string>();
        const stagedReady = Array.from(
            {length: pageCount},
            () => Promise.withResolvers<string>(),
        );
        const liveStagedPaths = new Set<string>();
        let peakLiveStagedBytes = 0;
        const ppm = Buffer.from('P6\n1 1\n255\n\0\0\0', 'binary');
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => pageCount),
            pageSizes: vi.fn(async () => Array.from({length: pageCount}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 612,
                heightPoints: 792,
                rotation: 0,
            }))),
            rasterPages: vi.fn(async () => ({
                detected: false,
                pages: new Set<number>(),
            })),
            retainedPaths: vi.fn(async () => new Map()),
            rasterScratchPath: vi.fn(async () => join(tempDir, 'unexpected.png')),
            retain: vi.fn(),
            release: vi.fn(async () => undefined),
        };
        const detection = runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage: vi.fn(),
                createRasterPipes: vi.fn(async paths => {
                    await execFileAsync('mkfifo', [...paths]);
                }),
                renderPagePpm: vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
                    await writeFile(outputPath, ppm);
                    stagedPaths.set(pageNumber, outputPath);
                    stagedReady[pageNumber - 1]!.resolve(outputPath);
                    liveStagedPaths.add(outputPath);
                    peakLiveStagedBytes = Math.max(
                        peakLiveStagedBytes,
                        liveStagedPaths.size * ppm.byteLength,
                    );
                }),
                runSidecar: vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
                    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                        rasterWindow?: number;
                        pages: Array<{
                            inputPath: string;
                            pageMetadataPath: string;
                            sourcePageIndex: number;
                        }>;
                    };
                    expect(manifest.rasterWindow).toBe(rasterConcurrency);
                    await Promise.all(manifest.pages.map(page => writeFile(
                        page.pageMetadataPath,
                        JSON.stringify({
                            layoutClassification: 'single-uncut-page',
                            cutterXPx: null,
                            rotationDegrees: 0,
                            canvasScope: 'page',
                            excluded: false,
                            blankOutputsSkipped: 0,
                            outputCount: 1,
                            outputs: [{
                                half: 'full',
                                sourceRegion: {
                                    xPx: 0,
                                    yPx: 0,
                                    widthPx: 1,
                                    heightPx: 1,
                                },
                                contentBox: {
                                    xPx: 0,
                                    yPx: 0,
                                    widthPx: 1,
                                    heightPx: 1,
                                },
                                cropRect: {
                                    xPx: 0,
                                    yPx: 0,
                                    widthPx: 1,
                                    heightPx: 1,
                                },
                                appliedMargins: {
                                    leftPx: 0,
                                    topPx: 0,
                                    rightPx: 0,
                                    bottomPx: 0,
                                },
                                inputWidthPx: 1,
                                inputHeightPx: 1,
                            }],
                        }),
                    )));
                    await beginConsumption.promise;
                    // Blocking FIFO reads run outside the main isolate's
                    // libuv pool, which the producer needs for stat/unlink.
                    const fifoConsumer = new Worker([
                        'const fs = require(\'node:fs\');',
                        'const {workerData} = require(\'node:worker_threads\');',
                        'const buffer = Buffer.allocUnsafe(4096);',
                        'for (const path of workerData) {',
                        '  const fd = fs.openSync(path, \'r\');',
                        '  while (fs.readSync(fd, buffer, 0, buffer.length, null) > 0) {}',
                        '  fs.closeSync(fd);',
                        '}',
                    ].join('\n'), {
                        eval: true,
                        workerData: manifest.pages.map(page => page.inputPath),
                    });
                    const consumed = new Promise<void>((resolve, reject) => {
                        fifoConsumer.once('error', reject);
                        fifoConsumer.once('exit', code => {
                            if (code === 0) resolve();
                            else reject(new Error(`FIFO consumer worker exited with code ${String(code)}`));
                        });
                    });
                    for (const [
                        index,
                        page,
                    ] of manifest.pages.entries()) {
                        const pageNumber = page.sourcePageIndex + 1;
                        // The FIFO consumer can finish the previous page before
                        // the producer's continuation records the next staged
                        // path. Await that producer-owned event instead of
                        // depending on libuv/coverage scheduling order.
                        const stagedPath = await stagedReady[pageNumber - 1]!.promise;
                        for (;;) {
                            try {
                                await stat(stagedPath);
                                await new Promise<void>(resolve => setImmediate(resolve));
                            } catch (error) {
                                expect(error).toMatchObject({code: 'ENOENT'});
                                break;
                            }
                        }
                        liveStagedPaths.delete(stagedPath);
                        onProgress({
                            stage: 'detecting',
                            completedUnits: index + 1,
                            totalUnits: pageCount,
                            percent: (index + 1) / pageCount * 100,
                            completedPageNumbers: Array.from(
                                {length: index + 1},
                                (_, pageIndex) => pageIndex + 1,
                            ),
                        }, {
                            stage: 'page-complete',
                            completedPages: index + 1,
                            totalPages: pageCount,
                            pageNumber,
                            classification: 'single-uncut-page',
                            confidence: 0.9,
                        });
                    }
                    await consumed;
                }),
            },
            {rasterConcurrency},
            () => undefined,
        );

        await vi.waitFor(() => expect(stagedPaths.size).toBe(rasterConcurrency));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(stagedPaths.size).toBe(rasterConcurrency);
        expect(peakLiveStagedBytes).toBeLessThanOrEqual(ppm.byteLength * rasterConcurrency);

        beginConsumption.resolve(undefined);
        const result = await detection;
        expect(result.results).toHaveLength(pageCount);
        expect(stagedPaths.size).toBe(pageCount);
        expect(liveStagedPaths.size).toBe(0);
        await Promise.all([...stagedPaths.values()].map(async path => {
            await expect(stat(path)).rejects.toMatchObject({code: 'ENOENT'});
        }));
        expect(retention.release).toHaveBeenCalledOnce();
    }, 15_000);

    it('classifies malformed native page metadata as a native protocol failure', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => 1),
            pageSizes: vi.fn(async () => [{
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 100,
                heightPoints: 200,
                rotation: 0,
            }]),
            rasterPages: vi.fn(async () => ({
                detected: true,
                pages: new Set([1]),
            })),
            retainedPaths: vi.fn(async () => new Map([[
                1,
                {
                    dpi: 150,
                    height: 200,
                    pageNumber: 1,
                    path: join(tempDir, 'retained.png'),
                    sizeBytes: 100,
                    width: 100,
                },
            ]])),
            rasterScratchPath: vi.fn(async () => join(tempDir, 'unexpected.png')),
            retain: vi.fn(),
            release: vi.fn(async () => undefined),
        };
        const request: IScanCleanupDetectionRequest = {
            ownerId: 'owner',
            sourcePdfPath: '/tmp/input.pdf',
            documentRevision: 'revision',
            options: {
                preserveOriginalQuality: false,
                layoutMode: 'auto',
                outputMode: 'auto',
                readingOrder: 'ltr',
                thickness: 0,
                crop: true,
                matchPageSize: false,
                pageAlignment: 'top-center',
                marginsMm: {
                    leftMm: 0,
                    topMm: 0,
                    rightMm: 0,
                    bottomMm: 0,
                },
                skipBlankPages: false,
                pageOverrides: {},
            },
        };

        await expect(runScanCleanupDetection(
            request,
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage: vi.fn(),
                renderPagePpm: vi.fn(),
                runSidecar: vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
                    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>;};
                    await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                        layoutClassification: 42,
                        cutterXPx: null,
                        rotationDegrees: 0,
                        canvasScope: 'page',
                        excluded: false,
                        blankOutputsSkipped: 0,
                        outputCount: 0,
                    }));
                    onProgress({
                        stage: 'detecting',
                        completedUnits: 1,
                        totalUnits: 1,
                        percent: 100,
                        completedPageNumbers: [1],
                    }, {
                        stage: 'page-analyzed',
                        completedPages: 1,
                        totalPages: 1,
                        pageNumber: 1,
                        classification: 'single-uncut-page',
                        confidence: 0.9,
                    });
                }),
            },
            {rasterConcurrency: 1},
            () => undefined,
        )).rejects.toMatchObject({
            code: 'native-failure',
            artifact: 'page metadata',
        });

        expect(retention.release).toHaveBeenCalledOnce();
    });

    it('rejects a Windows-style whole-document staging footprint before rendering', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const pageCount = 30;
        const renderPage = vi.fn();
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => pageCount),
            pageSizes: vi.fn(async () => Array.from({length: pageCount}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                // 3,000 × 3,000 at 150 DPI: plausible individually, but the
                // non-stream document total cannot fit the cache budget.
                widthPoints: 1_440,
                heightPoints: 1_440,
                rotation: 0,
            }))),
            rasterPages: vi.fn(async () => ({
                detected: false,
                pages: new Set<number>(),
            })),
            retainedPaths: vi.fn(async () => new Map()),
            rasterScratchPath: vi.fn(async () => join(tempDir, 'unexpected.png')),
            retain: vi.fn(),
            release: vi.fn(async () => undefined),
        };
        await expect(runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                // The fallback branch is selected by omitting createRasterPipes.
                getAvailableScratchBytes: vi.fn(async () => 1),
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage,
                renderPagePpm: vi.fn(),
                runSidecar: vi.fn(),
            },
            {rasterConcurrency: 2},
            () => undefined,
        )).rejects.toThrow('raster cache/scratch budget');

        expect(renderPage).not.toHaveBeenCalled();
        expect(retention.retain).not.toHaveBeenCalled();
        expect(retention.release).toHaveBeenCalledOnce();
    });

    it('counts retained rasters together with new pages against the whole-manifest budget', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const renderPage = vi.fn();
        const retainedRaster = {
            dpi: 150,
            height: 1_000,
            pageNumber: 1,
            path: join(tempDir, 'retained-page-1.png'),
            sizeBytes: 6 * MIB,
            width: 1_000,
        };
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => 2),
            pageSizes: vi.fn(async () => Array.from({length: 2}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                // 1,000 × 1,000 pixels at the 150-DPI detection ceiling.
                widthPoints: 480,
                heightPoints: 480,
                rotation: 0,
            }))),
            rasterPages: vi.fn(async () => ({
                detected: false,
                pages: new Set<number>(),
            })),
            retainedPaths: vi.fn(async () => new Map([[
                1,
                retainedRaster,
            ]])),
            rasterScratchPath: vi.fn(async () => join(tempDir, 'unexpected.png')),
            retain: vi.fn(),
            release: vi.fn(async () => undefined),
        };

        await expect(runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                // 520 MiB available leaves an 8-MiB budget after the reserve.
                // The missing page fits alone (~3 MiB), but not together with
                // the already-retained 6-MiB page.
                getAvailableScratchBytes: vi.fn(async () => 520 * MIB),
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage,
                renderPagePpm: vi.fn(),
                runSidecar: vi.fn(),
            },
            {rasterConcurrency: 2},
            () => undefined,
        )).rejects.toThrow('raster cache/scratch budget');

        expect(renderPage).not.toHaveBeenCalled();
        expect(retention.retain).not.toHaveBeenCalled();
        expect(retention.release).toHaveBeenCalledOnce();
    });
});
