import {
    mkdtemp,
    readFile,
    unlink,
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
import type {
    IScanCleanupOptions,
    TScanCleanupProgress,
} from '@contracts/electronApiScanCleanup';
import type { IScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import {
    classifyScanCleanupError,
    grantScanCleanupOutputAccess,
    materializeScanCleanupSourcePath,
} from '@electron/features/scan-cleanup/createScanCleanupService';
import {
    captureWorkingCopyAdmissionSnapshot,
    clearWorkingCopyOriginalPaths,
    setWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';
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
const PNG = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
));
const PPM = Buffer.concat([
    Buffer.from('P6\n1 1\n255\n', 'ascii'),
    Buffer.from([
        0,
        0,
        0,
    ]),
]);

function dpiDetails(
    documentDpi: number | null,
    pages: Array<[number, number, {
        width: number;
        height: number
    }?]>,
) {
    return {
        documentDpi,
        pageDpiByNumber: new Map(pages.map(([
            pageNumber,
            dpi,
        ]) => [
            pageNumber,
            dpi,
        ])),
        pageRasterByNumber: new Map(pages.map(([
            pageNumber,
            dpi,
            dimensions,
        ]) => [
            pageNumber,
            {
                dpi,
                width: dimensions?.width ?? 1_000,
                height: dimensions?.height ?? 1_400,
            },
        ])),
    };
}

function pngHeader(width: number, height: number, colorType = 0) {
    const header = Buffer.alloc(26);
    Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ]).copy(header);
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    header[24] = 8;
    header[25] = colorType;
    return header;
}

function pbm(width: number, height: number) {
    return Buffer.concat([
        Buffer.from(`P4\n${width} ${height}\n`, 'ascii'),
        Buffer.alloc(Math.ceil(width / 8) * height),
    ]);
}
interface ICleanupOutput {
    outputPath: string;
    metadataPath: string;
    bilevelOutputPath?: string;
    backgroundOutputPath?: string;
    foregroundMaskOutputPath?: string;
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
const highTierPolicy: IScanCleanupRuntimePolicy = {rasterConcurrency: 3};

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

function pipelinePaths(dir: string, includePageOps = false) {
    return {
        qpdfBinary: '/qpdf',
        pdftoppmBinary: '/pdftoppm',
        scanCleanupBinary: '/cleanup',
        pdfImageCombineBinary: '/combine',
        ...(includePageOps ? {pdfPageOpsBinary: '/page-ops'} : {}),
        tempDir: dir,
    };
}

function dependencies(
    runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'],
): IRunScanCleanupPipelineDependencies {
    return {
        getPageCount: vi.fn(async () => 2),
        detectSourceDpi: vi.fn(async () => dpiDetails(300, [
            [
                1,
                300,
            ],
            [
                2,
                150,
            ],
        ])),
        preparePdf: vi.fn(async (_paths, _log, sourcePdfPath) => ({
            pdfPath: sourcePdfPath,
            warnings: [],
        })),
        renderPage: vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            await writeFile(outputPath, PNG);
        }),
        renderPagePpm: vi.fn(async (_paths, _log, _pageNumber, _source, outputPath) => {
            await writeFile(outputPath, PPM);
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
    output: ICleanupOutput,
    classification: string,
    skewApplied = true,
    bilevelWritten = false,
    renderDpi = 300,
    matchedPageSize = false,
    layeredWritten = false,
    layeredBackgroundIsColor = false,
    outputMode?: string,
) {
    await writeFile(output.outputPath, 'PNG-CLEAN');
    if (bilevelWritten) {
        if (output.bilevelOutputPath === undefined) throw new Error('Missing test bilevel output path');
        await writeFile(output.bilevelOutputPath, 'P4\n1 1\n\x80');
    }
    if (layeredWritten) {
        if (
            output.backgroundOutputPath === undefined
            || output.foregroundMaskOutputPath === undefined
        ) {
            throw new Error('Missing test mixed layer output paths');
        }
        const canvasWidth = Math.round(renderDpi / 72 * 240);
        const canvasHeight = Math.round(renderDpi / 72 * 336);
        const layeredBackgroundDpi = Math.min(300, renderDpi);
        await writeFile(
            output.backgroundOutputPath,
            pngHeader(
                Math.round(canvasWidth * layeredBackgroundDpi / renderDpi),
                Math.round(canvasHeight * layeredBackgroundDpi / renderDpi),
                layeredBackgroundIsColor ? 2 : 0,
            ),
        );
        await writeFile(output.foregroundMaskOutputPath, pbm(canvasWidth, canvasHeight));
    }
    await writeFile(output.metadataPath, JSON.stringify({
        outputWidthPx: Math.round(renderDpi / 72 * 240),
        outputHeightPx: Math.round(renderDpi / 72 * 336),
        canvasWidthPx: Math.round(renderDpi / 72 * 240),
        canvasHeightPx: Math.round(renderDpi / 72 * 336),
        renderDpi,
        ...(matchedPageSize ? {
            matchedCanvasTargetWidthPoints: 240,
            matchedCanvasTargetHeightPoints: 336,
        } : {}),
        layoutClassification: classification,
        skewApplied,
        bilevelWritten,
        layeredWritten,
        ...(outputMode === undefined ? {} : {outputMode}),
        ...(layeredWritten ? {layeredBackgroundDpi: Math.min(300, renderDpi)} : {}),
        contentBox: {
            x: 1,
            y: 1,
            width: 10,
            height: 10,
        },
        warnings: [],
    }));
}

type TScanCleanupFanOutSite = 'lossless' | 'probe' | 'final';

async function measurePipelineRasterPeak(
    site: TScanCleanupFanOutSite,
    rasterConcurrency: IScanCleanupRuntimePolicy['rasterConcurrency'],
) {
    const fixture = await setup();
    const pageNumbers = [
        1,
        2,
        3,
        4,
    ];
    let activeRasters = 0;
    let peakRasters = 0;
    const trackRaster = async (render: () => Promise<void>) => {
        activeRasters += 1;
        peakRasters = Math.max(peakRasters, activeRasters);
        try {
            await new Promise(resolve => setTimeout(resolve, 5));
            await render();
        } finally {
            activeRasters -= 1;
        }
    };
    const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
        if (site === 'lossless') {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>};
            await Promise.all(manifest.pages.map(page => writeFile(page.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
                outputs: [{
                    half: 'full',
                    cropRect: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 100,
                        heightPx: 100,
                    },
                    inputWidthPx: 100,
                    inputHeightPx: 100,
                }],
            }))));
            return;
        }
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
            pageMetadataPath: string;
            options: {dpi: number};
            outputs: ICleanupOutput[]
        }>};
        await Promise.all(manifest.pages.map(async page => {
            await writeFile(page.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeCleanupOutput(
                page.outputs[0]!,
                'single-uncut-page',
                true,
                site === 'probe',
                page.options.dpi,
            );
        }));
    });
    const pipelineDependencies = dependencies(runSidecar);
    pipelineDependencies.getPageCount = vi.fn(async () => pageNumbers.length);
    pipelineDependencies.detectSourceDpi = vi.fn(async () => site === 'probe'
        ? dpiDetails(300, [])
        : dpiDetails(300, pageNumbers.map(pageNumber => [
            pageNumber,
            300,
        ])));
    const renderPage = pipelineDependencies.renderPage;
    const renderPagePpm = pipelineDependencies.renderPagePpm;
    if (site === 'probe') {
        pipelineDependencies.renderPage = vi.fn(async (
            ...args: Parameters<IRunScanCleanupPipelineDependencies['renderPage']>
        ) => trackRaster(
            () => renderPage(...args),
        ));
    } else {
        pipelineDependencies.renderPagePpm = vi.fn(async (
            ...args: Parameters<IRunScanCleanupPipelineDependencies['renderPagePpm']>
        ) => trackRaster(
            () => renderPagePpm(...args),
        ));
    }
    if (site === 'lossless') {
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            const outputPath = args[args.indexOf('--output') + 1]!;
            if (args[0] === 'page-sizes') {
                await writeFile(outputPath, JSON.stringify({pages: pageNumbers.map(pageNumber => ({
                    pageNumber,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 100,
                    heightPoints: 100,
                    rotation: 0,
                }))}));
            } else {
                await writeFile(outputPath, '%PDF-1.7\n%%EOF\n');
            }
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
    }

    await runScanCleanupPipeline(
        {
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                preserveOriginalQuality: site === 'lossless',
                outputMode: site === 'final' ? 'color' : 'bw',
            },
        },
        pipelinePaths(fixture.dir, site === 'lossless'),
        new AbortController().signal,
        vi.fn(),
        {rasterConcurrency},
        undefined,
        pipelineDependencies,
    );
    return peakRasters;
}

afterEach(async () => {
    clearWorkingCopyOriginalPaths();
    const {rm} = await import('fs/promises');
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        recursive: true,
        force: true,
    })));
});

describe('scan cleanup pipeline', () => {
    it('demand-materializes lazy-original input before scan-cleanup apply', async () => {
        const fixture = await setup();
        const workingCopyPath = join(fixture.dir, 'working.pdf');
        await setWorkingCopyOriginalPath(
            workingCopyPath,
            fixture.sourcePdfPath,
            42,
            {
                admissionSnapshot: await captureWorkingCopyAdmissionSnapshot(fixture.sourcePdfPath),
                backingState: 'lazy-original',
                deferOriginalFileExpectation: true,
            },
        );

        await expect(materializeScanCleanupSourcePath(
            workingCopyPath,
            42,
        )).resolves.toBe(workingCopyPath);

        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('ORIGINAL');
    });

    it('keeps eager scan-cleanup apply paths unchanged', async () => {
        const fixture = await setup();
        const workingCopyPath = join(fixture.dir, 'working.pdf');
        await writeFile(workingCopyPath, 'EAGER');
        await setWorkingCopyOriginalPath(
            workingCopyPath,
            fixture.sourcePdfPath,
            42,
            {
                backingState: 'eager',
                deferOriginalFileExpectation: true,
            },
        );

        await expect(materializeScanCleanupSourcePath(
            workingCopyPath,
            42,
        )).resolves.toBe(workingCopyPath);

        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('EAGER');
    });

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
        }, pipelinePaths(fixture.dir, true), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

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

    it.each([
        'lossless',
        'probe',
        'final',
    ] as const)('%s raster fan-out honors policy concurrency 1/2/3', async site => {
        for (const rasterConcurrency of [
            1,
            2,
            3,
        ] as const) {
            await expect(measurePipelineRasterPeak(site, rasterConcurrency))
                .resolves.toBe(rasterConcurrency);
        }
    });

    it('renders unresolved Auto pages once at source DPI and assembles from native mode metadata', async () => {
        const fixture = await setup();
        let cleanupManifest: {pages: Array<{
            inputPath: string;
            pageMetadataPath: string;
            options: IScanCleanupOptions & Record<string, unknown>;
            outputs: ICleanupOutput[]
        }>} | null = null;
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                inputPath: string;
                pageMetadataPath: string;
                options: IScanCleanupOptions & Record<string, unknown>;
                outputs: ICleanupOutput[]
            }>};
            cleanupManifest = manifest;
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'two-page-spread',
                recommendedOutputMode: 'bw',
                recommendedOutputModeConfidence: 0.94,
                cutterXPx: 500,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 2,
            }));
            await writeCleanupOutput(manifest.pages[0]!.outputs[0]!, 'two-page-spread', true, true, Number(manifest.pages[0]!.options.dpi), false, false, false, 'bw');
            await writeCleanupOutput(manifest.pages[0]!.outputs[1]!, 'two-page-spread', true, true, Number(manifest.pages[0]!.options.dpi), false, false, false, 'bw');
            await writeFile(manifest.pages[1]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                recommendedOutputMode: 'grayscale',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeCleanupOutput(manifest.pages[1]!.outputs[0]!, 'single-uncut-page', false, false, Number(manifest.pages[1]!.options.dpi), false, false, false, 'grayscale');
            onProgress({
                stage: 'rendering',
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
                options: {
                    ...options,
                    outputMode: 'auto',
                },
            },
            pipelinePaths(fixture.dir),
            new AbortController().signal,
            progress,
            highTierPolicy,
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
        // Unresolved Auto reaches the native render as `auto` and each page
        // rasterizes exactly once at its detected source DPI: no 150-DPI
        // analysis pass and no 72-DPI size probe.
        expect(runSidecar).toHaveBeenCalledOnce();
        expect(pipelineDependencies.renderPage).not.toHaveBeenCalled();
        const renderedDpis = vi.mocked(pipelineDependencies.renderPagePpm).mock.calls
            .map(call => call[5]);
        expect(renderedDpis).toEqual([
            300,
            150,
        ]);
        expect(cleanupManifest).not.toBeNull();
        expect(cleanupManifest!.pages[0]!.options).toMatchObject({
            matchPageSize: true,
            outputMode: 'auto',
            sourceDpi: 300,
            requestedRenderDpi: 300,
            dpi: 300,
            pageAlignment: 'top-center',
        });
        expect(cleanupManifest!.pages[1]!.options).toMatchObject({
            outputMode: 'auto',
            sourceDpi: 150,
            requestedRenderDpi: 150,
            dpi: 150,
        });
        expect(cleanupManifest!.pages[0]!.outputs[0]).toMatchObject({
            outputPath: expect.stringMatching(/clean-1-0\.png$/u),
            bilevelOutputPath: expect.stringMatching(/clean-1-0\.pbm$/u),
            backgroundOutputPath: expect.stringMatching(/clean-1-0-background\.png$/u),
            foregroundMaskOutputPath: expect.stringMatching(/clean-1-0-mask\.pbm$/u),
        });
        expect(cleanupManifest!.pages[0]!.inputPath).toMatch(/source-1\.ppm$/u);
        const recordKinds = combineManifest.trim().split('\n').map(line => line.split('\t')[0]);
        expect(recordKinds).toEqual([
            'image-bilevel',
            'image-bilevel',
            'image-jpeg',
        ]);
        const recordPaths = combineManifest.trim().split('\n').map(line => line.split('\t').at(-1));
        expect(recordPaths[0]).toMatch(/clean-1-0\.pbm$/u);
        expect(recordPaths[2]).toMatch(/clean-2-0\.png$/u);
        expect(combineManifest.trim().split('\n')[2]!.split('\t')[3]).toBe('85');
        const pageSizes = combineManifest.trim().split('\n').map(line => line.split('\t').slice(1, 3));
        expect(new Set(pageSizes.map(size => size.join('x')))).toEqual(new Set(['240.000000x336.000000']));
    });

    it('falls back to compressed handoff when the full-scope PPM footprint exceeds its scratch budget', async () => {
        const fixture = await setup();
        let inputPaths: string[] = [];
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                inputPath: string;
                pageMetadataPath: string;
                options: {dpi: number};
                outputs: ICleanupOutput[]
            }>};
            inputPaths = manifest.pages.map(page => page.inputPath);
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                await writeCleanupOutput(
                    page.outputs[0]!,
                    'single-uncut-page',
                    true,
                    true,
                    page.options.dpi,
                );
            }
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(300, [
            [
                1,
                300,
                {
                    width: 10_000,
                    height: 10_000,
                },
            ],
            [
                2,
                300,
                {
                    width: 10_000,
                    height: 10_000,
                },
            ],
        ]));
        const log = vi.fn();

        await runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            },
            pipelinePaths(fixture.dir),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            log,
            pipelineDependencies,
        );

        expect(pipelineDependencies.renderPagePpm).not.toHaveBeenCalled();
        expect(pipelineDependencies.renderPage).toHaveBeenCalledTimes(2);
        expect(inputPaths).toEqual([
            expect.stringMatching(/source-1\.png$/u),
            expect.stringMatching(/source-2\.png$/u),
        ]);
        expect(log).toHaveBeenCalledWith(
            'debug',
            expect.stringContaining('final raster handoff uses PNG'),
        );
    });

    it('processes and assembles only scoped source pages with scoped progress totals', async () => {
        const fixture = await setup();
        const renderedSourcePages: number[] = [];
        let manifestSourceIndexes: number[] = [];
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(
            async (_binary, manifestPath, _signal, _log, onProgress) => {
                const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                    sourcePageIndex: number;
                    pageMetadataPath: string;
                    outputs: ICleanupOutput[];
                }>};
                manifestSourceIndexes = manifest.pages.map(page => page.sourcePageIndex);
                for (const [
                    index,
                    page,
                ] of manifest.pages.entries()) {
                    await writeFile(page.pageMetadataPath, JSON.stringify({
                        layoutClassification: 'single-uncut-page',
                        cutterXPx: null,
                        rotationDegrees: 0,
                        excluded: false,
                        blankOutputsSkipped: 0,
                        outputCount: 1,
                    }));
                    await writeCleanupOutput(page.outputs[0]!, 'single-uncut-page');
                    onProgress({
                        stage: 'rendering',
                        completedUnits: index + 1,
                        totalUnits: manifest.pages.length,
                        percent: (index + 1) / manifest.pages.length * 100,
                        completedPageNumbers: Array.from({length: index + 1}, (_, pageIndex) => pageIndex + 1),
                    }, {
                        stage: 'page-analyzed',
                        completedPages: index + 1,
                        totalPages: manifest.pages.length,
                        pageNumber: index + 1,
                    });
                    onProgress({
                        stage: 'rendering',
                        completedUnits: index + 1,
                        totalUnits: manifest.pages.length,
                        percent: (index + 1) / manifest.pages.length * 100,
                        completedPageNumbers: Array.from({length: index + 1}, (_, pageIndex) => pageIndex + 1),
                    }, {
                        stage: 'page-complete',
                        completedPages: index + 1,
                        totalPages: manifest.pages.length,
                        pageNumber: index + 1,
                    });
                }
            },
        );
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.getPageCount = vi.fn(async () => 4);
        pipelineDependencies.detectSourceDpi = vi.fn(async (
            _path,
            _binary,
            _log,
            _environment,
            _signal,
            _pages,
            onProgress,
        ) => {
            onProgress?.(2, 2);
            return dpiDetails(300, [
                [
                    2,
                    300,
                ],
                [
                    4,
                    300,
                ],
            ]);
        });
        pipelineDependencies.renderPagePpm = vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            renderedSourcePages.push(pageNumber);
            await writeFile(outputPath, PPM);
        });
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
        const progress: TScanCleanupProgress[] = [];

        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            sourcePageNumbers: [
                2,
                4,
            ],
            options: {
                ...options,
                outputMode: 'color',
            },
        }, pipelinePaths(fixture.dir), new AbortController().signal, value => progress.push(value), highTierPolicy, undefined, pipelineDependencies);

        expect(summary).toMatchObject({
            inputPages: 2,
            outputPages: 2,
        });
        expect(renderedSourcePages).toEqual([
            2,
            4,
        ]);
        expect(manifestSourceIndexes).toEqual([
            1,
            3,
        ]);
        expect(combineManifest.trim().split('\n')).toHaveLength(2);
        for (const stage of [
            'probing',
            'rasterizing',
            'classifying',
            'rendering',
        ] as const) {
            expect(progress).toContainEqual(expect.objectContaining({
                stage,
                totalUnits: 2,
            }));
        }
        expect(progress.at(-1)).toMatchObject({
            stage: 'handoff',
            completedPageNumbers: [
                2,
                4,
            ],
            totalUnits: 2,
        });
    });

    it('falls back to the PNG record with a warning when bilevel metadata points to a missing PBM', async () => {
        const fixture = await setup();
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {dpi: number};
                outputs: ICleanupOutput[]
            }>};
            for (const [
                pageIndex,
                page,
            ] of manifest.pages.entries()) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                await writeCleanupOutput(
                    page.outputs[0]!,
                    'single-uncut-page',
                    true,
                    pageIndex === 0,
                    page.options.dpi,
                );
            }
            await unlink(manifest.pages[0]!.outputs[0]!.bilevelOutputPath!);
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            combineManifest = await readFile(args[args.indexOf('--compact-manifest') + 1]!, 'utf8');
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const log = vi.fn();

        const summary = await runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            },
            pipelinePaths(fixture.dir),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            log,
            pipelineDependencies,
        );

        expect(summary.outputPages).toBe(2);
        expect(combineManifest.trim().split('\n').map(line => line.split('\t')[0])).toEqual([
            'image',
            'image',
        ]);
        expect(combineManifest.trim().split('\n')[0]!.split('\t')[3]).toMatch(/clean-1-0\.png$/u);
        expect(log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('Page 1 bilevel output is missing or unreadable; using PNG fallback'),
        );
    });

    it('routes mixed picture pages as layered JPEG and mixed text-only pages as bilevel records', async () => {
        const fixture = await setup();
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {dpi: number};
                outputs: ICleanupOutput[]
            }>};
            for (const [
                pageIndex,
                page,
            ] of manifest.pages.entries()) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                await writeCleanupOutput(
                    page.outputs[0]!,
                    'single-uncut-page',
                    true,
                    pageIndex === 1,
                    page.options.dpi,
                    false,
                    pageIndex === 0,
                    pageIndex === 0,
                );
            }
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            combineManifest = await readFile(args[args.indexOf('--compact-manifest') + 1]!, 'utf8');
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

        await runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: {
                    ...options,
                    outputMode: 'mixed',
                },
            },
            pipelinePaths(fixture.dir),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            undefined,
            pipelineDependencies,
        );

        const records = combineManifest.trim().split('\n').map(line => line.split('\t'));
        expect(records.map(record => record[0])).toEqual([
            'layered-jpeg',
            'image-bilevel',
        ]);
        expect(records[0]![3]).toBe('87');
        expect(records[0]![4]).toMatch(/clean-1-0-background\.png$/u);
        expect(records[0]![5]).toMatch(/clean-1-0-mask\.pbm$/u);
        expect(records[1]![3]).toMatch(/clean-2-0\.pbm$/u);
    });

    it('falls back to composite JPEG when declared mixed layers are missing', async () => {
        const fixture = await setup();
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {dpi: number};
                outputs: ICleanupOutput[]
            }>};
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                await writeCleanupOutput(
                    page.outputs[0]!,
                    'single-uncut-page',
                    true,
                    false,
                    page.options.dpi,
                    false,
                    true,
                );
            }
            await unlink(manifest.pages[0]!.outputs[0]!.backgroundOutputPath!);
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            combineManifest = await readFile(args[args.indexOf('--compact-manifest') + 1]!, 'utf8');
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const log = vi.fn();

        await runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: {
                    ...options,
                    outputMode: 'mixed',
                },
            },
            pipelinePaths(fixture.dir),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            log,
            pipelineDependencies,
        );

        expect(combineManifest.trim().split('\n').map(line => line.split('\t')[0])).toEqual([
            'image-jpeg',
            'layered-jpeg',
        ]);
        expect(combineManifest.trim().split('\n')[1]!.split('\t')[3]).toBe('85');
        expect(log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('Page 1 mixed layers are missing, malformed, or mismatched; using composite JPEG fallback'),
        );
    });

    it('falls back to composite JPEG when a declared PBM layer is malformed', async () => {
        const fixture = await setup();
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {dpi: number};
                outputs: ICleanupOutput[]
            }>};
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                await writeCleanupOutput(
                    page.outputs[0]!,
                    'single-uncut-page',
                    true,
                    false,
                    page.options.dpi,
                    false,
                    true,
                );
            }
            await writeFile(
                manifest.pages[0]!.outputs[0]!.foregroundMaskOutputPath!,
                'P4\nnot-a-size\n',
            );
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            combineManifest = await readFile(args[args.indexOf('--compact-manifest') + 1]!, 'utf8');
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const log = vi.fn();

        const summary = await runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: {
                    ...options,
                    outputMode: 'mixed',
                },
            },
            pipelinePaths(fixture.dir),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            log,
            pipelineDependencies,
        );

        expect(summary.outputPages).toBe(2);
        expect(combineManifest.trim().split('\n').map(line => line.split('\t')[0])).toEqual([
            'image-jpeg',
            'layered-jpeg',
        ]);
        expect(log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('Page 1 mixed layers are missing, malformed, or mismatched; using composite JPEG fallback'),
        );
        expect(await readFile(fixture.outputPdfPath, 'utf8')).toContain('%PDF-1.7');
    });

    it('renders BW pages at their detected source DPI with unchanged physical page size', async () => {
        const fixture = await setup();
        let finalOptions: Array<{
            dpi: number;
            sourceDpi: number;
            requestedRenderDpi: number;
            outputMode: string
        }> = [];
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: typeof finalOptions[number];
                outputs: ICleanupOutput[];
            }>};
            finalOptions = manifest.pages.map(page => page.options);
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                await writeCleanupOutput(
                    page.outputs[0]!,
                    'single-uncut-page',
                    true,
                    true,
                    page.options.dpi,
                    true,
                );
            }
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(720, [
            [
                1,
                720,
            ],
            [
                2,
                640,
            ],
        ]));
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            combineManifest = await readFile(args[args.indexOf('--compact-manifest') + 1]!, 'utf8');
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options,
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        expect(pipelineDependencies.renderPage).not.toHaveBeenCalled();
        expect(finalOptions).toEqual([
            expect.objectContaining({
                dpi: 720,
                sourceDpi: 720,
                requestedRenderDpi: 720,
                outputMode: 'bw',
            }),
            expect.objectContaining({
                dpi: 640,
                sourceDpi: 640,
                requestedRenderDpi: 640,
                outputMode: 'bw',
            }),
        ]);
        const records = combineManifest.trim().split('\n').map(line => line.split('\t'));
        expect(records.map(record => record[0])).toEqual([
            'image-bilevel',
            'image-bilevel',
        ]);
        expect(new Set(records.map(record => `${record[1]}x${record[2]}`)))
            .toEqual(new Set(['240.000000x336.000000']));
    });

    it('caps BW supersampling at the shared 160 MP bilevel handoff limit', async () => {
        const fixture = await setup();
        let finalDpi = 0;
        let requestedRenderDpi = 0;
        const pipelineDependencies = dependencies(vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {
                    dpi: number;
                    requestedRenderDpi: number
                };
                outputs: ICleanupOutput[]
            }>};
            finalDpi = manifest.pages[0]!.options.dpi;
            requestedRenderDpi = manifest.pages[0]!.options.requestedRenderDpi;
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeCleanupOutput(
                manifest.pages[0]!.outputs[0]!,
                'single-uncut-page',
                true,
                true,
                finalDpi,
                true,
            );
        }));
        pipelineDependencies.getPageCount = vi.fn(async () => 1);
        // The detected raster row supplies the guardrail dimensions, so no
        // probe render is needed to clamp a detected page.
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(1_200, [[
            1,
            1_200,
            {
                width: 16_000,
                height: 16_000,
            },
        ]]));

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options,
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        expect(pipelineDependencies.renderPage).not.toHaveBeenCalled();
        expect(requestedRenderDpi).toBe(1_200);
        expect(finalDpi).toBe(948);
        expect(16_000 * 16_000 * (finalDpi / 1_200) ** 2).toBeLessThanOrEqual(160_000_000);
        expect(16_000 * 16_000 * (requestedRenderDpi / 1_200) ** 2).toBeGreaterThan(160_000_000);
    });

    it('floors BW render DPI at 600 only when no source DPI was detected', async () => {
        const fixture = await setup();
        let finalDpi = 0;
        let requestedRenderDpi = 0;
        const pipelineDependencies = dependencies(vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {
                    dpi: number;
                    requestedRenderDpi: number
                };
                outputs: ICleanupOutput[]
            }>};
            finalDpi = manifest.pages[0]!.options.dpi;
            requestedRenderDpi = manifest.pages[0]!.options.requestedRenderDpi;
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeCleanupOutput(
                manifest.pages[0]!.outputs[0]!,
                'single-uncut-page',
                true,
                true,
                finalDpi,
                true,
            );
        }));
        pipelineDependencies.getPageCount = vi.fn(async () => 1);
        // Another page may establish a document summary. A missing
        // page-specific dominant raster still means this page is vector or
        // unprobeable and must retain the synthesis floor.
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(300, []));

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options,
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        // Undetected binary-capable pages keep the bounded 72-DPI guardrail
        // probe before rendering at the synthesis floor.
        expect(pipelineDependencies.renderPage).toHaveBeenCalledOnce();
        expect(vi.mocked(pipelineDependencies.renderPage).mock.calls[0]![5]).toBe(72);
        expect(requestedRenderDpi).toBe(600);
        expect(finalDpi).toBe(600);
    });

    it('renders reliable low-DPI sources at their detected DPI without a floor', async () => {
        const fixture = await setup();
        let finalDpi = 0;
        let requestedRenderDpi = 0;
        const pipelineDependencies = dependencies(vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {
                    dpi: number;
                    requestedRenderDpi: number
                };
                outputs: ICleanupOutput[]
            }>};
            finalDpi = manifest.pages[0]!.options.dpi;
            requestedRenderDpi = manifest.pages[0]!.options.requestedRenderDpi;
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeCleanupOutput(
                manifest.pages[0]!.outputs[0]!,
                'single-uncut-page',
                true,
                true,
                finalDpi,
                true,
            );
        }));
        pipelineDependencies.getPageCount = vi.fn(async () => 1);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(200, [[
            1,
            200,
        ]]));

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options,
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        expect(requestedRenderDpi).toBe(200);
        expect(finalDpi).toBe(200);
    });

    it('renders BW and mixed recommendations at source DPI alongside tonal pages', async () => {
        const fixture = await setup();
        const renderedDpis: number[] = [];
        let combineManifest = '';
        let finalOptions: Array<{
            dpi: number;
            requestedRenderDpi: number;
            outputMode: string
        }> = [];
        const pipelineDependencies = dependencies(vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: typeof finalOptions[number];
                outputs: ICleanupOutput[];
            }>};
            finalOptions = manifest.pages.map(page => page.options);
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                await writeCleanupOutput(
                    page.outputs[0]!,
                    'single-uncut-page',
                    true,
                    false,
                    page.options.dpi,
                );
            }
        }));
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            combineManifest = await readFile(args[args.indexOf('--compact-manifest') + 1]!, 'utf8');
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(720, [
            [
                1,
                720,
            ],
            [
                2,
                640,
            ],
            [
                3,
                300,
            ],
            [
                4,
                150,
            ],
        ]));
        pipelineDependencies.getPageCount = vi.fn(async () => 4);
        pipelineDependencies.renderPagePpm = vi.fn(async (
            _paths,
            _log,
            _page,
            _source,
            outputPath,
            dpi,
        ) => {
            renderedDpis.push(dpi);
            await writeFile(outputPath, PPM);
        });

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                outputMode: 'auto',
            },
            outputModeRecommendations: {
                '1': 'grayscale',
                '2': 'color',
                '3': 'bw',
                '4': 'mixed',
            },
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        expect(pipelineDependencies.renderPage).not.toHaveBeenCalled();
        expect(renderedDpis).toEqual([
            720,
            640,
            300,
            150,
        ]);
        expect(finalOptions).toEqual([
            expect.objectContaining({
                dpi: 720,
                requestedRenderDpi: 720,
                outputMode: 'grayscale',
            }),
            expect.objectContaining({
                dpi: 640,
                requestedRenderDpi: 640,
                outputMode: 'color',
            }),
            expect.objectContaining({
                dpi: 300,
                requestedRenderDpi: 300,
                outputMode: 'bw',
            }),
            expect.objectContaining({
                dpi: 150,
                requestedRenderDpi: 150,
                outputMode: 'mixed',
            }),
        ]);
        expect(combineManifest.trim().split('\n').map(line => {
            const record = line.split('\t');
            return [
                record[0],
                record[3],
            ];
        })).toEqual([
            [
                'image-jpeg',
                '85',
            ],
            [
                'image-jpeg',
                '87',
            ],
            [
                'image',
                expect.stringMatching(/clean-3-0\.png$/u),
            ],
            [
                'image-jpeg',
                '85',
            ],
        ]);
        expect(pipelineDependencies.runSidecar).toHaveBeenCalledOnce();
    });

    it('keys resolved output modes by real page numbers for nonconsecutive selections', async () => {
        const fixture = await setup();
        let combineManifest = '';
        const pipelineDependencies = dependencies(vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {dpi: number};
                outputs: ICleanupOutput[];
            }>};
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                await writeCleanupOutput(
                    page.outputs[0]!,
                    'single-uncut-page',
                    true,
                    false,
                    page.options.dpi,
                );
            }
        }));
        pipelineDependencies.getPageCount = vi.fn(async () => 4);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(300, [[
            3,
            300,
        ]]));
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            combineManifest = await readFile(args[args.indexOf('--compact-manifest') + 1]!, 'utf8');
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                outputMode: 'auto',
            },
            sourcePageNumbers: [3],
            outputModeRecommendations: {'3': 'grayscale'},
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        const record = combineManifest.trim().split('\t');
        expect(record[0]).toBe('image-jpeg');
        expect(record[3]).toBe('85');
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
            pipelinePaths(fixture.dir),
            controller.signal,
            vi.fn(),
            highTierPolicy,
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
            pipelinePaths(fixture.dir, true),
            controller.signal,
            vi.fn(),
            highTierPolicy,
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
            pipelinePaths(fixture.dir),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            undefined,
            dependencies(vi.fn(async () => { throw new NativeScanCleanupError('native-failure', 'fixture'); })),
        );
        await expect(result).rejects.toThrow('fixture');
        expect(classifyScanCleanupError(new NativeScanCleanupError('native-failure', 'fixture'), false)).toBe('native-failure');
        expect(await readFile(fixture.sourcePdfPath, 'utf8')).toBe('ORIGINAL');
        await expect(readFile(fixture.outputPdfPath)).rejects.toMatchObject({code: 'ENOENT'});
    });
});
