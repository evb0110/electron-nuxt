import {
    mkdtemp,
    readFile,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {WebContents} from 'electron';
import type { IScanCleanupOptions } from '@contracts/electronApiScanCleanup';
import {
    classifyScanCleanupError,
    grantScanCleanupOutputAccess,
} from '@electron/features/scan-cleanup/createScanCleanupService';
import {
    removeAllowedOpenPath,
    requireOpenPath,
} from '@electron/file-access/openPathCapabilities';
import {
    mapScanCleanupRasterPages,
    runScanCleanupPipeline,
    type IRunScanCleanupPipelineDependencies,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';
import {NativeScanCleanupError} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';

const dirs: string[] = [];
interface ICleanupOutput {
    outputPath: string;
    metadataPath: string;
}

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'bw',
    readingOrder: 'ltr',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckle: true,
    skipBlankPages: false,
    pageOverrides: {},
};

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'scan-cleanup-test-'));
    dirs.push(dir);
    const sourcePdfPath = join(dir, 'original.pdf');
    const outputPdfPath = join(dir, 'cleaned.pdf');
    await writeFile(sourcePdfPath, 'ORIGINAL');
    return {
        dir,
        sourcePdfPath,
        outputPdfPath,
    };
}

function dependencies(
    runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'],
): IRunScanCleanupPipelineDependencies {
    return {
        getPageCount: vi.fn(async () => 2),
        detectSourceDpi: vi.fn(async () => ({
            documentDpi: 300,
            pageDpiByNumber: new Map([
                [
                    1,
                    300,
                ],
                [
                    2,
                    150,
                ],
            ]),
        })),
        preparePdf: vi.fn(async (_paths, _log, sourcePdfPath) => ({
            pdfPath: sourcePdfPath,
            warnings: [],
        })),
        renderPage: vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            await writeFile(outputPath, `PNG-${pageNumber}`);
        }),
        runSidecar,
        runCommand: vi.fn(async (_command, args) => {
            const outputIndex = args.indexOf('--output');
            await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        }),
    };
}

async function writeCleanupOutput(
    output: {
        outputPath: string;
        metadataPath: string
    },
    classification: string,
    skewApplied = true,
) {
    await writeFile(output.outputPath, 'PNG-CLEAN');
    await writeFile(output.metadataPath, JSON.stringify({
        outputWidthPx: 1000,
        outputHeightPx: 1400,
        canvasWidthPx: 1000,
        canvasHeightPx: 1400,
        layoutClassification: classification,
        skewApplied,
        contentBox: {
            x: 1,
            y: 1,
            width: 10,
            height: 10,
        },
        warnings: [],
    }));
}

afterEach(async () => {
    const {rm} = await import('fs/promises');
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        recursive: true,
        force: true,
    })));
});

describe('scan cleanup pipeline', () => {
    it('maps rotated lossless analysis to PDF points, reverses RTL halves, and prunes raster options', async () => {
        const fixture = await setup();
        const losslessOptions: IScanCleanupOptions = {
            ...options,
            preserveOriginalQuality: true,
            matchPageSize: false,
            readingOrder: 'rtl',
            outputMode: 'bw',
            thickness: 4,
            despeckle: true,
            skipBlankPages: true,
            pageOverrides: {
                '1': {
                    rotationDegrees: 90,
                    layoutOverride: 'spread',
                    excluded: false,
                    manualSplit: {
                        xNormalized: 0.5,
                        rotationDegrees: 90,
                    },
                },
                '2': {
                    rotationDegrees: 0,
                    layoutOverride: 'auto',
                    excluded: true,
                    manualSplit: null,
                },
            },
        };
        let analyzedOptions: Record<string, unknown> | null = null;
        let splitInstructions: {pages: Array<{
            sourcePageIndex: number;
            rotationQuarterTurns: number;
            outputs: Array<{cropRect: {
                x: number;
                y: number;
                width: number;
                height: number
            }}>
        }>} | null = null;
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: Record<string, unknown>
            }>};
            analyzedOptions = manifest.pages[0]!.options;
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'two-page-spread',
                cutterXPx: 250,
                rotationDegrees: 90,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 2,
                outputs: [
                    {
                        half: 'left',
                        cropRect: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 250,
                            heightPx: 1000,
                        },
                        inputWidthPx: 1000,
                        inputHeightPx: 500,
                    },
                    {
                        half: 'right',
                        cropRect: {
                            xPx: 250,
                            yPx: 0,
                            widthPx: 250,
                            heightPx: 1000,
                        },
                        inputWidthPx: 1000,
                        inputHeightPx: 500,
                    },
                ],
            }));
            await writeFile(manifest.pages[1]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: true,
                blankOutputsSkipped: 0,
                outputCount: 0,
                outputs: [],
            }));
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            const outputPath = args[args.indexOf('--output') + 1]!;
            if (args[0] === 'page-sizes') {
                await writeFile(outputPath, JSON.stringify({pages: [
                    {
                        pageNumber: 1,
                        xPoints: 0,
                        yPoints: 0,
                        widthPoints: 200,
                        heightPoints: 100,
                        rotationDegrees: 0,
                    },
                    {
                        pageNumber: 2,
                        xPoints: 0,
                        yPoints: 0,
                        widthPoints: 200,
                        heightPoints: 100,
                        rotationDegrees: 0,
                    },
                ]}));
            } else {
                const instructionsPath = args[args.indexOf('--instructions-file') + 1]!;
                splitInstructions = JSON.parse(await readFile(instructionsPath, 'utf8')) as typeof splitInstructions;
                await writeFile(outputPath, '%PDF-1.7\n%%EOF\n');
            }
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: losslessOptions,
        }, {
            qpdfBinary: '/qpdf',
            pdftoppmBinary: '/pdftoppm',
            scanCleanupBinary: '/cleanup',
            pdfImageCombineBinary: '/combine',
            pdfPageOpsBinary: '/page-ops',
            tempDir: fixture.dir,
        }, new AbortController().signal, vi.fn(), undefined, pipelineDependencies);

        expect(analyzedOptions).toMatchObject({
            outputMode: 'color',
            thickness: 0,
            despeckle: false,
            skipBlankPages: false,
            experimental: {autoDewarp: false},
        });
        expect(splitInstructions).toEqual({pages: [{
            sourcePageIndex: 0,
            rotationQuarterTurns: 1,
            outputs: [
                {cropRect: {
                    x: 0,
                    y: 50,
                    width: 200,
                    height: 50,
                }},
                {cropRect: {
                    x: 0,
                    y: 0,
                    width: 200,
                    height: 50,
                }},
            ],
        }]});
        expect(summary).toMatchObject({
            outputPages: 2,
            spreadsSplit: 1,
            excludedPages: 1,
        });
        expect(await readFile(fixture.outputPdfPath, 'utf8')).toContain('%PDF-1.7');
    });

    it('grants each subscribed renderer access to the completed managed output', async () => {
        const fixture = await setup();
        await writeFile(fixture.outputPdfPath, '%PDF-1.7\n%%EOF\n');
        const sender: Partial<WebContents> = {
            id: 71_104,
            isDestroyed: () => false,
            once: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const webContents = sender as WebContents;

        expect(() => requireOpenPath(fixture.outputPdfPath, webContents)).toThrow('Path not allowed');
        grantScanCleanupOutputAccess(fixture.outputPdfPath, [webContents]);
        expect(requireOpenPath(fixture.outputPdfPath, webContents)).toMatch(/cleaned\.pdf$/u);
        removeAllowedOpenPath(fixture.outputPdfPath);
    });

    it('rasterizes with a bound of three while preserving source order', async () => {
        let active = 0;
        let peak = 0;
        const resolvers: Array<() => void> = [];
        const resultPromise = mapScanCleanupRasterPages([
            1,
            2,
            3,
            4,
            5,
        ], 3, async value => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise<void>(resolve => resolvers.push(resolve));
            active -= 1;
            return value * 10;
        });
        await vi.waitFor(() => expect(resolvers).toHaveLength(3));
        resolvers.splice(0).forEach(resolve => resolve());
        await vi.waitFor(() => expect(resolvers).toHaveLength(2));
        resolvers.splice(0).forEach(resolve => resolve());
        await expect(resultPromise).resolves.toEqual([
            10,
            20,
            30,
            40,
            50,
        ]);
        expect(peak).toBe(3);
    });

    it('turns a spread into two pages, preserves the original, and publishes only the staged PDF', async () => {
        const fixture = await setup();
        let cleanupManifest: {pages: Array<{
            pageMetadataPath: string;
            options: IScanCleanupOptions & Record<string, unknown>;
            outputs: ICleanupOutput[]
        }>} | null = null;
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: IScanCleanupOptions & Record<string, unknown>;
                outputs: ICleanupOutput[]
            }>};
            cleanupManifest = manifest;
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'two-page-spread',
                cutterXPx: 500,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 2,
            }));
            await writeCleanupOutput(manifest.pages[0]!.outputs[0]!, 'two-page-spread');
            await writeCleanupOutput(manifest.pages[0]!.outputs[1]!, 'two-page-spread');
            await writeFile(manifest.pages[1]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeCleanupOutput(manifest.pages[1]!.outputs[0]!, 'single-uncut-page', false);
            onProgress({
                stage: 'cleaning',
                completedUnits: 1,
                totalUnits: 2,
                percent: 50,
                completedPageNumbers: [2],
            }, {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 2,
                pageNumber: 2,
            });
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            const manifestIndex = args.indexOf('--compact-manifest');
            combineManifest = await readFile(args[manifestIndex + 1]!, 'utf8');
            const outputIndex = args.indexOf('--output');
            await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const progress = vi.fn();
        const summary = await runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            },
            {
                qpdfBinary: '/qpdf',
                pdftoppmBinary: '/pdftoppm',
                scanCleanupBinary: '/cleanup',
                pdfImageCombineBinary: '/combine',
                tempDir: fixture.dir,
            },
            new AbortController().signal,
            progress,
            undefined,
            pipelineDependencies,
        );
        expect(summary).toMatchObject({
            inputPages: 2,
            outputPages: 3,
            spreadsSplit: 1,
            deskewSkipped: 1,
        });
        expect(await readFile(fixture.sourcePdfPath, 'utf8')).toBe('ORIGINAL');
        expect(await readFile(fixture.outputPdfPath, 'utf8')).toContain('%PDF-1.7');
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({
            stage: 'handoff',
            percent: 100,
        }));
        expect(cleanupManifest).not.toBeNull();
        expect(cleanupManifest!.pages[0]!.options).toMatchObject({
            matchPageSize: true,
            pageAlignment: 'top-center',
        });
        const pageSizes = combineManifest.trim().split('\n').map(line => line.split('\t').slice(1, 3));
        expect(new Set(pageSizes.map(size => size.join('x')))).toEqual(new Set(['240.000000x336.000000']));
    });

    it('kills work through the abort signal and leaves no partial final PDF', async () => {
        const fixture = await setup();
        const controller = new AbortController();
        const entered = Promise.withResolvers<undefined>();
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, _manifest, signal) => {
            entered.resolve(undefined);
            await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
        });
        const result = runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            },
            {
                qpdfBinary: '/qpdf',
                pdftoppmBinary: '/pdftoppm',
                scanCleanupBinary: '/cleanup',
                pdfImageCombineBinary: '/combine',
                tempDir: fixture.dir,
            },
            controller.signal,
            vi.fn(),
            undefined,
            dependencies(runSidecar),
        );
        await entered.promise;
        controller.abort(new DOMException('Canceled', 'AbortError'));
        await expect(result).rejects.toThrow('Canceled');
        await expect(readFile(fixture.outputPdfPath)).rejects.toMatchObject({code: 'ENOENT'});
        expect(await readFile(fixture.sourcePdfPath, 'utf8')).toBe('ORIGINAL');
    });

    it('cancels lossless analysis without publishing a partial PDF', async () => {
        const fixture = await setup();
        const controller = new AbortController();
        const entered = Promise.withResolvers<undefined>();
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, _manifest, signal) => {
            entered.resolve(undefined);
            await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            const outputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(outputPath, JSON.stringify({pages: [
                {
                    pageNumber: 1,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 200,
                    heightPoints: 100,
                    rotationDegrees: 0,
                },
                {
                    pageNumber: 2,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 200,
                    heightPoints: 100,
                    rotationDegrees: 0,
                },
            ]}));
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const result = runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: {
                    ...options,
                    preserveOriginalQuality: true,
                },
            },
            {
                qpdfBinary: '/qpdf',
                pdftoppmBinary: '/pdftoppm',
                scanCleanupBinary: '/cleanup',
                pdfImageCombineBinary: '/combine',
                pdfPageOpsBinary: '/page-ops',
                tempDir: fixture.dir,
            },
            controller.signal,
            vi.fn(),
            undefined,
            pipelineDependencies,
        );
        await entered.promise;
        controller.abort(new DOMException('Canceled', 'AbortError'));

        await expect(result).rejects.toThrow('Canceled');
        await expect(readFile(fixture.outputPdfPath)).rejects.toMatchObject({code: 'ENOENT'});
        expect(await readFile(fixture.sourcePdfPath, 'utf8')).toBe('ORIGINAL');
    });

    it('surfaces a typed sidecar failure without touching source or final output', async () => {
        const fixture = await setup();
        const result = runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            },
            {
                qpdfBinary: '/qpdf',
                pdftoppmBinary: '/pdftoppm',
                scanCleanupBinary: '/cleanup',
                pdfImageCombineBinary: '/combine',
                tempDir: fixture.dir,
            },
            new AbortController().signal,
            vi.fn(),
            undefined,
            dependencies(vi.fn(async () => { throw new NativeScanCleanupError('native-failure', 'fixture'); })),
        );
        await expect(result).rejects.toThrow('fixture');
        expect(classifyScanCleanupError(new NativeScanCleanupError('native-failure', 'fixture'), false)).toBe('native-failure');
        expect(await readFile(fixture.sourcePdfPath, 'utf8')).toBe('ORIGINAL');
        await expect(readFile(fixture.outputPdfPath)).rejects.toMatchObject({code: 'ENOENT'});
    });
});
