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
const PNG = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
));

function pngHeader(width: number, height: number) {
    const header = Buffer.alloc(24);
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
    return header;
}
interface ICleanupOutput {
    outputPath: string;
    metadataPath: string;
    bilevelOutputPath?: string;
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
            await writeFile(outputPath, PNG);
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
) {
    await writeFile(output.outputPath, 'PNG-CLEAN');
    if (bilevelWritten) {
        if (output.bilevelOutputPath === undefined) throw new Error('Missing test bilevel output path');
        await writeFile(output.bilevelOutputPath, 'P4\n1 1\n\x80');
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

    it('turns a spread into two pages and combines auto-resolved BW outputs as bilevel images', async () => {
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
            if (manifest.pages[0]?.outputs.length === 0) {
                for (const [
                    pageIndex,
                    page,
                ] of manifest.pages.entries()) {
                    await writeFile(page.pageMetadataPath, JSON.stringify({recommendedOutputMode: pageIndex === 0 ? 'bw' : 'grayscale'}));
                }
                return;
            }
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
            await writeCleanupOutput(manifest.pages[0]!.outputs[0]!, 'two-page-spread', true, true, Number(manifest.pages[0]!.options.dpi));
            await writeCleanupOutput(manifest.pages[0]!.outputs[1]!, 'two-page-spread', true, true, Number(manifest.pages[0]!.options.dpi));
            await writeFile(manifest.pages[1]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeCleanupOutput(manifest.pages[1]!.outputs[0]!, 'single-uncut-page', false, false, Number(manifest.pages[1]!.options.dpi));
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
                options: {
                    ...options,
                    outputMode: 'auto',
                },
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
            outputMode: 'bw',
            sourceDpi: 300,
            requestedRenderDpi: 600,
            dpi: 600,
            pageAlignment: 'top-center',
        });
        expect(cleanupManifest!.pages[1]!.options).toMatchObject({
            outputMode: 'grayscale',
            sourceDpi: 150,
            requestedRenderDpi: 150,
            dpi: 150,
        });
        expect(runSidecar).toHaveBeenCalledTimes(2);
        expect(cleanupManifest!.pages[0]!.outputs[0]).toMatchObject({
            outputPath: expect.stringMatching(/clean-1-0\.png$/u),
            bilevelOutputPath: expect.stringMatching(/clean-1-0\.pbm$/u),
        });
        const recordKinds = combineManifest.trim().split('\n').map(line => line.split('\t')[0]);
        expect(recordKinds).toEqual([
            'image-bilevel',
            'image-bilevel',
            'image',
        ]);
        const recordPaths = combineManifest.trim().split('\n').map(line => line.split('\t')[3]);
        expect(recordPaths[0]).toMatch(/clean-1-0\.pbm$/u);
        expect(recordPaths[2]).toMatch(/clean-2-0\.png$/u);
        const pageSizes = combineManifest.trim().split('\n').map(line => line.split('\t').slice(1, 3));
        expect(new Set(pageSizes.map(size => size.join('x')))).toEqual(new Set(['240.000000x336.000000']));
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
            {
                qpdfBinary: '/qpdf',
                pdftoppmBinary: '/pdftoppm',
                scanCleanupBinary: '/cleanup',
                pdfImageCombineBinary: '/combine',
                tempDir: fixture.dir,
            },
            new AbortController().signal,
            vi.fn(),
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

    it('routes mixed color pages as PNG and mixed text-only pages as bilevel records', async () => {
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
            pipelineDependencies,
        );

        const records = combineManifest.trim().split('\n').map(line => line.split('\t'));
        expect(records.map(record => record[0])).toEqual([
            'image',
            'image-bilevel',
        ]);
        expect(records[0]![3]).toMatch(/clean-1-0\.png$/u);
        expect(records[1]![3]).toMatch(/clean-2-0\.pbm$/u);
    });

    it('renders BW pages above 600 DPI at 2x source with unchanged physical page size', async () => {
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
        pipelineDependencies.detectSourceDpi = vi.fn(async () => ({
            documentDpi: 720,
            pageDpiByNumber: new Map([
                [
                    1,
                    720,
                ],
                [
                    2,
                    640,
                ],
            ]),
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

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options,
        }, {
            qpdfBinary: '/qpdf',
            pdftoppmBinary: '/pdftoppm',
            scanCleanupBinary: '/cleanup',
            pdfImageCombineBinary: '/combine',
            tempDir: fixture.dir,
        }, new AbortController().signal, vi.fn(), undefined, pipelineDependencies);

        expect(finalOptions).toEqual([
            expect.objectContaining({
                dpi: 1_440,
                sourceDpi: 720,
                requestedRenderDpi: 1_440,
                outputMode: 'bw',
            }),
            expect.objectContaining({
                dpi: 1_280,
                sourceDpi: 640,
                requestedRenderDpi: 1_280,
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
        pipelineDependencies.detectSourceDpi = vi.fn(async () => ({
            documentDpi: 600,
            pageDpiByNumber: new Map([[
                1,
                600,
            ]]),
        }));
        pipelineDependencies.renderPage = vi.fn(async (
            _paths,
            _log,
            _pageNumber,
            _source,
            outputPath,
            dpi,
        ) => {
            const scale = dpi / 72;
            await writeFile(outputPath, pngHeader(
                Math.round(800 * scale),
                Math.round(1_100 * scale),
            ));
        });

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options,
        }, {
            qpdfBinary: '/qpdf',
            pdftoppmBinary: '/pdftoppm',
            scanCleanupBinary: '/cleanup',
            pdfImageCombineBinary: '/combine',
            tempDir: fixture.dir,
        }, new AbortController().signal, vi.fn(), undefined, pipelineDependencies);

        expect(requestedRenderDpi).toBe(1_200);
        expect(finalDpi).toBe(970);
        expect(800 * 1_100 * (finalDpi / 72) ** 2).toBeLessThanOrEqual(160_000_000);
        expect(800 * 1_100 * (requestedRenderDpi / 72) ** 2).toBeGreaterThan(160_000_000);
    });

    it('reuses detect-all tonal recommendations in one pass without supersampling', async () => {
        const fixture = await setup();
        const renderedDpis: number[] = [];
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
        pipelineDependencies.detectSourceDpi = vi.fn(async () => ({
            documentDpi: 720,
            pageDpiByNumber: new Map([
                [
                    1,
                    720,
                ],
                [
                    2,
                    640,
                ],
            ]),
        }));
        pipelineDependencies.renderPage = vi.fn(async (
            _paths,
            _log,
            _page,
            _source,
            outputPath,
            dpi,
        ) => {
            renderedDpis.push(dpi);
            await writeFile(outputPath, PNG);
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
            },
        }, {
            qpdfBinary: '/qpdf',
            pdftoppmBinary: '/pdftoppm',
            scanCleanupBinary: '/cleanup',
            pdfImageCombineBinary: '/combine',
            tempDir: fixture.dir,
        }, new AbortController().signal, vi.fn(), undefined, pipelineDependencies);

        expect(renderedDpis).toEqual([
            720,
            640,
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
        ]);
        expect(pipelineDependencies.runSidecar).toHaveBeenCalledOnce();
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
