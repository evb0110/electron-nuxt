import {
    mkdtemp,
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { createHash } from 'node:crypto';
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
    TScanCleanupOutputMode,
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
    runScanCleanupPipeline,
    type IRunScanCleanupPipelineDependencies,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';
import {
    resolveReusablePagePlan,
    resolveReusablePagePlanResult,
    resolveEffectiveScanCleanupOptions,
    SCAN_CLEANUP_COLOR_JPEG_QUALITY,
    SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
} from '@scan-cleanup-core/policy/effectiveOptions';
import {createPagePlanResolver} from '@scan-cleanup-core/createPagePlanResolver';
import {mapScanCleanupRasterPages} from '@scan-cleanup-core/resolveRasterHandoff';
import {resolveCompactSourcePreservation} from '@scan-cleanup-core/assembleCompactScanCleanupPages';
import {NativeScanCleanupError} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {
    assertScanCleanupCompactSourceBudget,
    resolveScanCleanupCompactSourceBudget,
    SCAN_CLEANUP_COMPACT_SOURCE_FIXED_BYTE_ALLOWANCE,
    SCAN_CLEANUP_COMPACT_SOURCE_MAX_BYTE_RATIO,
    shouldExtractTrustedMrcForeground,
} from '@scan-cleanup-core/policy/scanCleanupRepresentationPolicy';
import {
    ScanCleanupMissingOutputError,
    ScanCleanupPdfValidationError,
} from '@scan-cleanup-core/errors';

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

function pbm(width: number, height: number) {
    return Buffer.concat([
        Buffer.from(`P4\n${width} ${height}\n`, 'ascii'),
        Buffer.alloc(Math.ceil(width / 8) * height),
    ]);
}

function ppm(width: number, height: number) {
    return Buffer.concat([
        Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'),
        Buffer.alloc(width * height * 3),
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
const highTierPolicy: IScanCleanupRuntimePolicy = {
    rasterConcurrency: 3,
    rasterStreaming: true,
    logicalCpus: 11,
    totalRamBytes: 32 * 1024 ** 3,
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

// Every matched run measures the document through `page-sizes` before it
// renders, so a harness that replaces runCommand still has to answer it.
async function answerPageSizesCommand(args: readonly string[], pageCount = 4) {
    if (args[0] !== 'page-sizes') {
        return false;
    }
    await writeFile(args[args.indexOf('--output') + 1]!, JSON.stringify({pages: Array.from(
        {length: pageCount},
        (_, index) => index + 1,
    ).map(pageNumber => ({
        pageNumber,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 240,
        heightPoints: 336,
        rotation: 0,
    }))}));
    return true;
}

function pipelinePaths(dir: string, includePageOps = true, includePdfInfo = false) {
    return {
        qpdfBinary: '/qpdf',
        pdftoppmBinary: '/pdftoppm',
        scanCleanupBinary: '/cleanup',
        pdfImageCombineBinary: '/combine',
        ...(includePageOps ? {pdfPageOpsBinary: '/page-ops'} : {}),
        ...(includePdfInfo ? {pdfinfoBinary: '/pdfinfo'} : {}),
        provenanceStampSupport: false,
        tempDir: dir,
    };
}

// What `pdfinfo -f 1 -l N` reports for a document of identically sized pages:
// the page view Poppler renders, and the rotation it is presented under.
function pdfInfoGeometry(pageCount: number, widthPoints: number, heightPoints: number) {
    return [
        `Pages:           ${String(pageCount)}`,
        ...Array.from({length: pageCount}, (_, index) => [
            `Page    ${String(index + 1)} size:  ${String(widthPoints)} x ${String(heightPoints)} pts`,
            `Page    ${String(index + 1)} rot:   0`,
        ].join('\n')),
    ].join('\n');
}

function dependencies(
    runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'],
): IRunScanCleanupPipelineDependencies {
    const pipelineDependencies: IRunScanCleanupPipelineDependencies = {
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
        renderPage: vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            await writeFile(outputPath, PNG);
        }),
        renderPagePpm: vi.fn(async (_paths, _log, _pageNumber, _source, outputPath) => {
            await writeFile(outputPath, PPM);
        }),
        runSidecar,
        getAvailableScratchBytes: vi.fn(async () => null),
        hashNativeBinary: vi.fn(async (path: string) => createHash('sha256').update(path, 'utf8').digest('hex')),
        runCommand: vi.fn(async (_command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputIndex = args.indexOf('--output');
            // Matching measures the document through page-sizes, so the tool
            // answers geometry for however many pages this harness renders.
            const pageCount = await pipelineDependencies.getPageCount('');
            await writeFile(args[outputIndex + 1]!, args[0] === 'page-sizes'
                ? JSON.stringify({pages: Array.from(
                    {length: pageCount},
                    (_value, index) => index + 1,
                ).map(pageNumber => ({
                    pageNumber,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 240,
                    heightPoints: 336,
                    rotation: 0,
                }))})
                : '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        }),
    };
    return pipelineDependencies;
}

async function writeCleanupOutput(
    output: ICleanupOutput,
    classification: string,
    skewApplied = true,
    bilevelWritten = false,
    renderDpi = 300,
    matchedPageSize = false,
    layeredWritten = false,
    _layeredBackgroundIsColor = false,
    outputMode?: string,
) {
    // The sidecar publishes the composite only when no primary raster carried
    // the page, so the fixture must not leave one beside a PBM or a layer pair.
    if (!bilevelWritten && !layeredWritten) {
        await writeFile(output.outputPath, 'PNG-CLEAN');
    }
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
            ppm(
                Math.round(canvasWidth * layeredBackgroundDpi / renderDpi),
                Math.round(canvasHeight * layeredBackgroundDpi / renderDpi),
            ),
        );
        await writeFile(output.foregroundMaskOutputPath, pbm(canvasWidth, canvasHeight));
    }
    await writeFile(output.metadataPath, JSON.stringify({
        outputWidthPx: Math.round(renderDpi / 72 * 240),
        outputHeightPx: Math.round(renderDpi / 72 * 336),
        canvasWidthPx: Math.round(renderDpi / 72 * 240),
        canvasHeightPx: Math.round(renderDpi / 72 * 336),
        placementOffsetXPx: 0,
        placementOffsetYPx: 0,
        forwardTransform: null,
        rotationDegrees: 0,
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
            xPx: 1,
            yPx: 1,
            widthPx: 10,
            heightPx: 10,
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
                    sourceRegion: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 100,
                        heightPx: 100,
                    },
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
    pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
        if (args[0] === '--check') {
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        }
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
        pipelinePaths(fixture.dir),
        new AbortController().signal,
        vi.fn(),
        {
            ...highTierPolicy,
            rasterConcurrency,
        },
        undefined,
        pipelineDependencies,
    );
    return peakRasters;
}

afterEach(async () => {
    vi.unstubAllEnvs();
    clearWorkingCopyOriginalPaths();
    const {rm} = await import('fs/promises');
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        recursive: true,
        force: true,
    })));
});

describe('scan cleanup pipeline', () => {
    it.each([
        [
            'Auto without a page override',
            'auto',
            undefined,
            true,
        ],
        [
            'explicit B/W',
            'bw',
            undefined,
            true,
        ],
        [
            'a B/W page override',
            'grayscale',
            'bw',
            true,
        ],
        [
            'an explicit tonal mode',
            'grayscale',
            undefined,
            false,
        ],
        [
            'a tonal page override',
            'bw',
            'mixed',
            false,
        ],
    ] as const)('extracts trusted MRC foreground for %s', (
        _case,
        documentOutputMode,
        pageOutputModeOverride,
        expected,
    ) => {
        expect(shouldExtractTrustedMrcForeground(
            documentOutputMode,
            pageOutputModeOverride,
        )).toBe(expected);
    });

    it('treats locked Auto Color as preservation while explicit Color may normalize', () => {
        const pageOverride = {
            rotationDegrees: 0 as const,
            layoutOverride: 'auto' as const,
            excluded: false,
            manualSplit: null,
        };
        const common = {
            pageOverride,
            dpi: 300,
            qualityPath: 'raster' as const,
        };
        const automatic = resolveEffectiveScanCleanupOptions({
            ...common,
            options: {
                ...options,
                outputMode: 'auto',
                normalizeIllumination: true,
            },
            resolvedOutputMode: 'color',
        });
        const explicit = resolveEffectiveScanCleanupOptions({
            ...common,
            options: {
                ...options,
                outputMode: 'color',
                normalizeIllumination: true,
            },
            resolvedOutputMode: 'color',
        });

        expect(automatic.outputMode).toBe('color');
        expect(automatic.normalizeIllumination).toBe(false);
        expect(explicit.normalizeIllumination).toBe(true);
    });

    it('budgets full-document Auto cleanup when the source is predominantly compact layered pages', () => {
        const sourceBytes = 40 * 1024 * 1024;
        const budget = resolveScanCleanupCompactSourceBudget({
            documentPageCount: 4,
            options: {
                ...options,
                outputMode: 'auto',
            },
            pageRasterByNumber: new Map([
                [
                    1,
                    {
                        dpi: 600,
                        width: 5_100,
                        height: 6_600,
                        hasBilevelLayer: true,
                        backgroundDpi: 150,
                    },
                ],
                [
                    2,
                    {
                        dpi: 600,
                        width: 5_100,
                        height: 6_600,
                        hasBilevelLayer: true,
                        backgroundDpi: 150,
                    },
                ],
            ]),
            partialRun: false,
            sourceBytes,
        });

        expect(budget).toEqual({
            compactLayeredPages: 2,
            sourceBytes,
            maxOutputBytes: Math.ceil(Math.max(
                sourceBytes * SCAN_CLEANUP_COMPACT_SOURCE_MAX_BYTE_RATIO,
                sourceBytes + SCAN_CLEANUP_COMPACT_SOURCE_FIXED_BYTE_ALLOWANCE,
            )),
        });
    });

    it('does not apply the compact-source budget to partial, manual, or non-layered cleanup', () => {
        const layeredPages = new Map([[
            1,
            {
                dpi: 600,
                width: 5_100,
                height: 6_600,
                hasBilevelLayer: true,
                backgroundDpi: 150,
            },
        ]]);
        const base = {
            documentPageCount: 1,
            options: {
                ...options,
                outputMode: 'auto' as const,
            },
            pageRasterByNumber: layeredPages,
            sourceBytes: 40 * 1024 * 1024,
        };
        expect(resolveScanCleanupCompactSourceBudget({
            ...base,
            partialRun: true,
        })).toBeNull();
        expect(resolveScanCleanupCompactSourceBudget({
            ...base,
            options: {
                ...base.options,
                outputMode: 'grayscale',
            },
            partialRun: false,
        })).toBeNull();
        expect(resolveScanCleanupCompactSourceBudget({
            ...base,
            pageRasterByNumber: new Map(),
            partialRun: false,
        })).toBeNull();
    });

    it('fails closed before publishing a compact layered Auto result over budget', () => {
        const budget = {
            compactLayeredPages: 392,
            sourceBytes: 40_000_000,
            maxOutputBytes: 100_000_000,
        };
        expect(() => assertScanCleanupCompactSourceBudget(
            100_000_000,
            budget,
        )).not.toThrow();
        expect(() => assertScanCleanupCompactSourceBudget(
            647_200_000,
            budget,
        )).toThrow(
            'Automatic scan cleanup refused to publish a compact layered source',
        );
    });

    it('admits automatic page plans only for the same rotation and observed layout', () => {
        const request = {
            sourcePdfPath: '/source.pdf',
            outputPdfPath: '/output.pdf',
            options,
            layoutByPage: {'1': 'single-uncut-page' as const},
            pagePlanEvidenceByPage: {'1': {
                pageNumber: 1,
                rotationDegrees: 0 as const,
                layoutClassification: 'single-uncut-page' as const,
                automaticSplit: {
                    xNormalized: 0.48,
                    rotationDegrees: 0 as const,
                },
                outputs: {full: {
                    contentBox: {
                        xNormalized: 0.1,
                        yNormalized: 0.2,
                        widthNormalized: 0.7,
                        heightNormalized: 0.6,
                        rotationDegrees: 0 as const,
                    },
                    detectedSkewDegrees: -0.2,
                }},
            }},
        };
        expect(resolveReusablePagePlan(
            request.options,
            request.layoutByPage,
            request.pagePlanEvidenceByPage,
            1,
        )).toEqual({
            automaticSplit: request.pagePlanEvidenceByPage['1'].automaticSplit,
            automaticContentBoxes: {full: request.pagePlanEvidenceByPage['1'].outputs.full.contentBox},
            automaticSkewDegrees: {full: -0.2},
        });
        expect(resolveReusablePagePlan(
            request.options,
            {'1': 'two-page-spread'},
            request.pagePlanEvidenceByPage,
            1,
        )).toEqual({});
        expect(resolveReusablePagePlan(
            {
                ...options,
                pageOverrides: {'1': {
                    rotationDegrees: 90,
                    layoutOverride: 'auto',
                    excluded: false,
                    manualSplit: null,
                }},
            },
            request.layoutByPage,
            request.pagePlanEvidenceByPage,
            1,
        )).toEqual({});
        expect(resolveReusablePagePlanResult(
            request.options,
            {'1': 'two-page-spread'},
            request.pagePlanEvidenceByPage,
            1,
        )).toEqual({
            plan: {},
            status: 'layout-mismatch',
        });
        expect(resolveReusablePagePlanResult(
            request.options,
            request.layoutByPage,
            request.pagePlanEvidenceByPage,
            2,
        )).toEqual({
            plan: {},
            status: 'absent',
        });
    });

    it('counts pinned plans and rejects stale evidence instead of silently reanalyzing', () => {
        const evidence = {'1': {
            pageNumber: 1,
            rotationDegrees: 0 as const,
            layoutClassification: 'single-uncut-page' as const,
            outputs: {},
        }};
        const log = vi.fn();
        const resolver = createPagePlanResolver({
            options,
            layoutByPage: {'1': 'single-uncut-page'},
            pagePlanEvidenceByPage: evidence,
        }, log, 'final');
        expect(resolver.resolve(1)).toEqual({});
        expect(resolver.resolve(2)).toEqual({});
        resolver.report();
        expect(log).toHaveBeenCalledWith(
            'debug',
            'Scan cleanup final page-plan evidence: pinned=1 absent=1 mismatched=0',
        );

        const stale = createPagePlanResolver({
            options,
            layoutByPage: {'1': 'two-page-spread'},
            pagePlanEvidenceByPage: evidence,
        }, log, 'final');
        expect(() => stale.resolve(1)).toThrow(
            'Stale scan cleanup page-plan evidence for page 1: layout-mismatch',
        );
    });

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
        let losslessUsesCanonicalPair = false;
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                inputPath: string;
                analysisInputPath?: string;
                analysisDpi?: number;
                pageMetadataPath: string;
                options: Record<string, unknown>
            }>};
            analyzedOptions = manifest.pages[0]!.options;
            losslessUsesCanonicalPair = manifest.pages.every(page =>
                page.analysisInputPath === page.inputPath && page.analysisDpi === 150,
            );
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
                        // The half of the rotated sheet this output was cut
                        // from, which is the paper it owns.
                        sourceRegion: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 250,
                            heightPx: 1000,
                        },
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
                        sourceRegion: {
                            xPx: 250,
                            yPx: 0,
                            widthPx: 250,
                            heightPx: 1000,
                        },
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
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputPath = args[args.indexOf('--output') + 1]!;
            if (args[0] === 'page-sizes') {
                await writeFile(outputPath, JSON.stringify({pages: [
                    {
                        pageNumber: 1,
                        xPoints: 0,
                        yPoints: 0,
                        widthPoints: 200,
                        heightPoints: 100,
                        rotation: 0,
                    },
                    {
                        pageNumber: 2,
                        xPoints: 0,
                        yPoints: 0,
                        widthPoints: 200,
                        heightPoints: 100,
                        rotation: 0,
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
            dpi: 150,
            outputMode: 'color',
            thickness: 0,
            despeckle: false,
            skipBlankPages: false,
            experimental: {autoDewarp: false},
        });
        expect(losslessUsesCanonicalPair).toBe(true);
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

    it('does not render a redundant guardrail probe when trusted PDF geometry is available', async () => {
        await expect(measurePipelineRasterPeak('probe', 3)).resolves.toBe(0);
    });

    it('rejects an Auto run before rendering when an included page has no locked decision', async () => {
        const fixture = await setup();
        const pipelineDependencies = dependencies(vi.fn());

        await expect(runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: {
                    ...options,
                    outputMode: 'auto',
                },
            },
            pipelinePaths(fixture.dir, true),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            undefined,
            pipelineDependencies,
        )).rejects.toThrow('no locked Auto output-mode decision');
        expect(pipelineDependencies.runSidecar).not.toHaveBeenCalled();
    });

    it('renders locked Auto decisions once at mode-appropriate density and assembles native metadata', async () => {
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
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputIndex = args.indexOf('--output');
            if (args[0] === 'page-sizes') {
                await writeFile(args[outputIndex + 1]!, JSON.stringify({pages: [
                    1,
                    2,
                ].map(pageNumber => ({
                    pageNumber,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 612,
                    heightPoints: 792,
                    rotation: 0,
                }))}));
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const manifestIndex = args.indexOf('--compact-manifest');
            combineManifest = await readFile(args[manifestIndex + 1]!, 'utf8');
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
                outputModeRecommendations: {
                    1: 'bw',
                    2: 'grayscale',
                },
            },
            pipelinePaths(fixture.dir, true),
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
        // Locked Auto decisions reach the native render as concrete modes on
        // the one grid matched output promises for the document.
        expect(runSidecar).toHaveBeenCalledOnce();
        expect(pipelineDependencies.renderPage).not.toHaveBeenCalled();
        const renderedDpis = vi.mocked(pipelineDependencies.renderPagePpm).mock.calls
            .map(call => call[5]);
        expect(renderedDpis.toSorted((left, right) => left - right)).toEqual([
            150,
            150,
            300,
            300,
        ]);
        expect(cleanupManifest).not.toBeNull();
        expect(cleanupManifest!.pages[0]!.options).toMatchObject({
            matchPageSize: true,
            outputMode: 'bw',
            sourceDpi: 300,
            requestedRenderDpi: 300,
            dpi: 300,
            pageAlignment: 'top-center',
        });
        expect(cleanupManifest!.pages[1]!.options).toMatchObject({
            outputMode: 'grayscale',
            sourceDpi: 150,
            requestedRenderDpi: 150,
            dpi: 300,
        });
        expect(cleanupManifest!.pages[0]!.outputs[0]).toMatchObject({
            outputPath: expect.stringMatching(/clean-1-0\.png$/u),
            bilevelOutputPath: expect.stringMatching(/clean-1-0\.pbm$/u),
            backgroundOutputPath: expect.stringMatching(/clean-1-0-background\.ppm$/u),
            foregroundMaskOutputPath: expect.stringMatching(/clean-1-0-mask\.pbm$/u),
        });
        expect(cleanupManifest!.pages[0]!.inputPath).toMatch(/source-1\.ppm$/u);
        expect(cleanupManifest!.pages[0]).toMatchObject({
            analysisInputPath: expect.stringMatching(/source-1-analysis-150dpi\.ppm$/u),
            analysisDpi: 150,
        });
        const recordKinds = combineManifest.trim().split('\n').map(line => line.split('\t')[0]);
        expect(recordKinds).toEqual([
            'image-bilevel',
            'image-bilevel',
            'image-jpeg',
        ]);
        const recordPaths = combineManifest.trim().split('\n').map(line => line.split('\t').at(-1));
        expect(recordPaths[0]).toMatch(/clean-1-0\.pbm$/u);
        expect(recordPaths[2]).toMatch(/clean-2-0\.png$/u);
        expect(combineManifest.trim().split('\n')[2]!.split('\t')[3]).toBe(
            String(SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY),
        );
        const pageSizes = combineManifest.trim().split('\n').map(line => line.split('\t').slice(1, 3));
        expect(new Set(pageSizes.map(size => size.join('x')))).toEqual(new Set(['240.000000x336.000000']));
    });

    it('preserves an unchanged compact Auto Color source page', async () => {
        const fixture = await setup();
        const evidenceDir = join(fixture.dir, 'evidence');
        vi.stubEnv('EVB_SCAN_CLEANUP_EVIDENCE_DIR', evidenceDir);
        let pageOpsInstructions: unknown = null;
        let qpdfArgs: readonly string[] = [];
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                outputs: ICleanupOutput[];
            }>};
            const page = manifest.pages[0]!;
            await writeFile(page.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeFile(page.outputs[0]!.outputPath, PNG);
            await writeFile(page.outputs[0]!.metadataPath, JSON.stringify({
                sourcePageIndex: 0,
                half: 'full',
                sourceRegion: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1_200,
                    heightPx: 1_680,
                },
                cropRect: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1_200,
                    heightPx: 1_680,
                },
                inputWidthPx: 1_200,
                inputHeightPx: 1_680,
                outputWidthPx: 1_200,
                outputHeightPx: 1_680,
                canvasWidthPx: 1_200,
                canvasHeightPx: 1_680,
                renderDpi: 360,
                layoutClassification: 'single-uncut-page',
                skewApplied: false,
                dewarpModel: null,
                outputMode: 'color',
                contentBox: null,
                warnings: [],
            }));
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.getPageCount = vi.fn(async () => 1);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => ({
            documentDpi: 360,
            pageDpiByNumber: new Map([[
                1,
                360,
            ]]),
            pageRasterByNumber: new Map([[
                1,
                {
                    dpi: 360,
                    width: 1_200,
                    height: 1_680,
                    hasBilevelLayer: true,
                    backgroundDpi: 120,
                },
            ]]),
        }));
        pipelineDependencies.runCommand = vi.fn(async (command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputIndex = args.indexOf('--output');
            if (command === '/combine') {
                await writeFile(args[outputIndex + 1]!, '%PDF-1.7\nRASTER\n%%EOF\n');
            } else if (command === '/page-ops') {
                pageOpsInstructions = JSON.parse(await readFile(args[args.indexOf('--instructions-file') + 1]!, 'utf8'));
                await writeFile(args[outputIndex + 1]!, '%PDF-1.7\nPRESERVED\n%%EOF\n');
            } else if (command === '/qpdf') {
                qpdfArgs = args;
                await writeFile(args.at(-1)!, '%PDF-1.7\nHYBRID\n%%EOF\n');
            } else {
                throw new Error(`Unexpected command ${command}`);
            }
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
                    outputMode: 'auto',
                    matchPageSize: false,
                },
                outputModeRecommendations: {1: 'color'},
                sourcePageMetadataByPage: {1: {
                    pageNumber: 1,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 240,
                    heightPoints: 336,
                    rotation: 0,
                    sourceDpi: 360,
                }},
            },
            pipelinePaths(fixture.dir, true),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            undefined,
            pipelineDependencies,
        );
        expect(pageOpsInstructions).toEqual({pages: [{
            sourcePageIndex: 0,
            rotationQuarterTurns: 0,
            outputs: [{
                cropRect: {
                    x: 0,
                    y: 0,
                    width: 240,
                    height: 336,
                },
                contentTransform: {
                    scale: 1,
                    translateX: 0,
                    translateY: 0,
                },
            }],
        }]});
        expect(qpdfArgs.some(argument => argument.endsWith('/preserved-source-pages.pdf'))).toBe(true);
        expect(await readFile(fixture.outputPdfPath, 'utf8')).toContain('HYBRID');
        expect(JSON.parse(await readFile(
            join(evidenceDir, 'scan-cleanup-representation-report.json'),
            'utf8',
        ))).toMatchObject({
            compactSourceBudget: {compactLayeredPages: 1},
            pages: [{
                semanticMode: 'color',
                representation: 'preserved-compact-source',
                preservationReason: 'auto-color-compact-layered-no-raster-change',
                sourceDpi: 360,
                sourceBackgroundDpi: 120,
                renderDpi: 360,
                illuminationNormalized: false,
            }],
        });
    });

    it('retains an Auto Mixed source page only when native reports its MRC tone unchanged', () => {
        const preserved = resolveCompactSourcePreservation(
            {
                sourcePdfPath: '/source.pdf',
                outputPdfPath: '/cleaned.pdf',
                options: {
                    ...options,
                    outputMode: 'auto',
                    matchPageSize: false,
                },
            },
            1,
            {
                layoutClassification: 'single-uncut-page',
                outputCount: 1,
                rotationDegrees: 0,
            } as Parameters<typeof resolveCompactSourcePreservation>[2],
            {
                sourcePageNumber: 1,
                path: '/clean-1-0.png',
                dpi: 360,
                resolvedOutputMode: 'mixed',
                metadata: {
                    half: 'full',
                    cropRect: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 1_200,
                        heightPx: 1_680,
                    },
                    inputWidthPx: 1_200,
                    inputHeightPx: 1_680,
                    outputWidthPx: 1_200,
                    outputHeightPx: 1_680,
                    canvasWidthPx: 1_200,
                    canvasHeightPx: 1_680,
                    placementOffsetXPx: 0,
                    placementOffsetYPx: 0,
                    rotationDegrees: 0,
                    skewApplied: false,
                    dewarpModel: null,
                    // Mixed analysis still records how its text foreground was
                    // classified. That diagnostic must not prevent whole-page
                    // source preservation when the MRC cleanup abstains.
                    binarizationMode: 'otsu',
                    outputMode: 'mixed',
                    trustedMrcBackgroundPreserved: true,
                    illuminationNormalized: true,
                    textToneDiagnostics: {applied: true},
                },
            } as Parameters<typeof resolveCompactSourcePreservation>[3],
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 240,
                heightPoints: 336,
                rotation: 0,
            },
            {
                dpi: 360,
                width: 1_200,
                height: 1_680,
                hasBilevelLayer: true,
                backgroundDpi: 120,
            },
        );

        expect(preserved).toMatchObject({
            reason: 'auto-mixed-trusted-mrc-tone-preserved',
            sourcePageIndex: 0,
        });
    });

    async function runOversizedRasterPipeline(availableScratchBytes: number | null) {
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
        pipelineDependencies.getAvailableScratchBytes = vi.fn(async () => availableScratchBytes);
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

        return {
            inputPaths,
            log,
            pipelineDependencies,
        };
    }

    it('falls back to compressed handoff when the full-scope PPM footprint exceeds its scratch budget', async () => {
        const run = await runOversizedRasterPipeline(1024 * 1024 * 1024);

        expect(run.pipelineDependencies.renderPagePpm).not.toHaveBeenCalled();
        expect(run.pipelineDependencies.renderPage).toHaveBeenCalledTimes(4);
        expect(run.inputPaths).toEqual([
            expect.stringMatching(/source-1\.png$/u),
            expect.stringMatching(/source-2\.png$/u),
        ]);
        expect(run.log).toHaveBeenCalledWith(
            'debug',
            expect.stringContaining('final raster handoff uses PNG'),
        );
    });

    it('keeps the raw handoff for a large footprint when the scratch volume has room for it', async () => {
        const run = await runOversizedRasterPipeline(400 * 1024 * 1024 * 1024);

        expect(run.pipelineDependencies.renderPage).not.toHaveBeenCalled();
        expect(run.pipelineDependencies.renderPagePpm).toHaveBeenCalledTimes(4);
        expect(run.inputPaths).toEqual([
            expect.stringMatching(/source-1\.ppm$/u),
            expect.stringMatching(/source-2\.ppm$/u),
        ]);
        expect(run.log).toHaveBeenCalledWith(
            'debug',
            expect.stringContaining('final raster handoff uses PPM'),
        );
    });

    it('reuses typed detection geometry and DPI without reopening the document for matched output', async () => {
        const fixture = await setup();
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(
            async (_binary, manifestPath) => {
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
                        true,
                    );
                }
            },
        );
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            expect(args[0]).not.toBe('page-sizes');
            const outputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(outputPath, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            sourcePageMetadataByPage: Object.fromEntries([
                1,
                2,
            ].map(pageNumber => [
                String(pageNumber),
                {
                    pageNumber,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 240,
                    heightPoints: 336,
                    rotation: 0,
                    sourceDpi: pageNumber === 1 ? 300 : 150,
                    dominantImageWidthPx: pageNumber === 1 ? 1_000 : 500,
                    dominantImageHeightPx: pageNumber === 1 ? 1_400 : 700,
                    dominantImageWidthPoints: 240,
                    dominantImageHeightPoints: 336,
                },
            ])),
            options: {
                ...options,
                outputMode: 'color',
            },
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        expect(pipelineDependencies.detectSourceDpi).not.toHaveBeenCalled();
        expect(pipelineDependencies.runCommand).toHaveBeenCalledTimes(2);
    });

    it.runIf(process.platform !== 'win32')('streams raw rasters to the native consumer before rasterization finishes', async () => {
        const fixture = await setup();
        const rasterStarted = Promise.withResolvers<undefined>();
        const releaseRaster = Promise.withResolvers<undefined>();
        const sidecarStarted = Promise.withResolvers<undefined>();
        const canonicalRendered = Promise.withResolvers<undefined>();
        let canonicalPath = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(
            async (_binary, manifestPath, _signal, _log, onProgress) => {
                sidecarStarted.resolve(undefined);
                const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                    rasterWindow?: number;
                    pages: Array<{
                        analysisInputPath: string;
                        pageMetadataPath: string;
                        options: {dpi: number};
                        outputs: ICleanupOutput[]
                    }>;
                };
                expect(manifest.rasterWindow).toBe(highTierPolicy.rasterConcurrency);
                const page = manifest.pages[0]!;
                canonicalPath = page.analysisInputPath;
                await canonicalRendered.promise;
                await expect(readFile(canonicalPath)).resolves.toEqual(PPM);
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
                onProgress({
                    stage: 'rendering',
                    completedUnits: 1,
                    totalUnits: 1,
                    percent: 100,
                    completedPageNumbers: [1],
                }, {
                    stage: 'page-complete',
                    completedPages: 1,
                    totalPages: 1,
                    pageNumber: 1,
                });
            },
        );
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.getPageCount = vi.fn(async () => 1);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(300, [[
            1,
            300,
        ]]));
        pipelineDependencies.createRasterPipes = vi.fn(async () => undefined);
        pipelineDependencies.renderPagePpm = vi.fn(async (_paths, _log, _pageNumber, _source, outputPath) => {
            if (outputPath.includes('-analysis-')) {
                await writeFile(outputPath, PPM);
                canonicalRendered.resolve(undefined);
            } else {
                rasterStarted.resolve(undefined);
                await releaseRaster.promise;
            }
        });
        const progress = vi.fn();
        const running = runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                matchPageSize: false,
                outputMode: 'color',
            },
        }, pipelinePaths(fixture.dir), new AbortController().signal, progress, highTierPolicy, undefined, pipelineDependencies);

        await rasterStarted.promise;
        await expect(Promise.race([
            sidecarStarted.promise.then(() => true),
            new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
        ])).resolves.toBe(true);
        releaseRaster.resolve(undefined);
        await running;

        await expect(readFile(canonicalPath)).rejects.toMatchObject({code: 'ENOENT'});
        expect(pipelineDependencies.createRasterPipes).toHaveBeenCalledOnce();
        expect(runSidecar).toHaveBeenCalledOnce();
        const progressReports = progress.mock.calls.map(([report]) => report as TScanCleanupProgress);
        expect(progressReports.some(report => report.stage === 'rasterizing')).toBe(false);
        expect(progressReports).toContainEqual(expect.objectContaining({
            stage: 'rendering',
            completedUnits: 1,
        }));
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
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (await answerPageSizesCommand(args)) {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
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
        expect(renderedSourcePages.toSorted()).toEqual([
            2,
            2,
            4,
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
            'rendering',
        ] as const) {
            expect(progress).toContainEqual(expect.objectContaining({
                stage,
                totalUnits: 2,
            }));
        }
        expect(progress.map(entry => entry.stage)).not.toContain('classifying');
        expect(progress.at(-1)).toMatchObject({
            stage: 'handoff',
            completedPageNumbers: [
                2,
                4,
            ],
            totalUnits: 2,
        });
    });

    it('sizes every final page against the whole document rather than a window of it', async () => {
        const fixture = await setup();
        const pageCount = 4;
        let combineManifest = '';
        const manifestPageCounts: number[] = [];
        // Stands in for match_page_sizes: this run names no document canvas, so
        // the uniform page size is the largest output of the manifest the
        // sidecar was handed.
        const intrinsicPoints = (sourcePageIndex: number) => ({
            widthPoints: 240 + sourcePageIndex * 10,
            heightPoints: 336 + sourcePageIndex * 10,
        });
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                sourcePageIndex: number;
                pageMetadataPath: string;
                options: {dpi: number};
                outputs: ICleanupOutput[];
            }>};
            manifestPageCounts.push(manifest.pages.length);
            const target = manifest.pages.reduce((widest, page) => {
                const intrinsic = intrinsicPoints(page.sourcePageIndex);
                return {
                    widthPoints: Math.max(widest.widthPoints, intrinsic.widthPoints),
                    heightPoints: Math.max(widest.heightPoints, intrinsic.heightPoints),
                };
            }, {
                widthPoints: 0,
                heightPoints: 0,
            });
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                const output = page.outputs[0]!;
                const intrinsic = intrinsicPoints(page.sourcePageIndex);
                const {dpi} = page.options;
                await writeFile(output.outputPath, 'PNG-CLEAN');
                await writeFile(output.metadataPath, JSON.stringify({
                    outputWidthPx: Math.round(intrinsic.widthPoints / 72 * dpi),
                    outputHeightPx: Math.round(intrinsic.heightPoints / 72 * dpi),
                    canvasWidthPx: Math.round(target.widthPoints / 72 * dpi),
                    canvasHeightPx: Math.round(target.heightPoints / 72 * dpi),
                    renderDpi: dpi,
                    matchedCanvasTargetWidthPoints: target.widthPoints,
                    matchedCanvasTargetHeightPoints: target.heightPoints,
                    layoutClassification: 'single-uncut-page',
                    skewApplied: true,
                    bilevelWritten: false,
                    layeredWritten: false,
                    contentBox: {
                        xPx: 1,
                        yPx: 1,
                        widthPx: 10,
                        heightPx: 10,
                    },
                    warnings: [],
                }));
            }
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.getPageCount = vi.fn(async () => pageCount);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(
            300,
            Array.from({length: pageCount}, (_value, index) => [
                index + 1,
                300,
            ]),
        ));
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (await answerPageSizesCommand(args)) {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const manifestIndex = args.indexOf('--compact-manifest');
            if (manifestIndex !== -1) combineManifest = await readFile(args[manifestIndex + 1]!, 'utf8');
            const outputIndex = args.indexOf('--output');
            await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
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
                outputMode: 'color',
                matchPageSize: true,
            },
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        const pageSizes = combineManifest.trim().split('\n').map(line => line.split('\t').slice(1, 3).join('x'));
        expect(pageSizes).toEqual(Array.from({length: pageCount}, () => '270.000000x366.000000'));
        expect(manifestPageCounts).toEqual([pageCount]);
    });

    it('threads native continuous-tone PDF placement into an optional compact-line suffix', async () => {
        const fixture = await setup();
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                outputs: ICleanupOutput[];
            }>};
            const page = manifest.pages[0]!;
            await writeFile(page.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            const output = page.outputs[0]!;
            await writeFile(output.outputPath, 'PNG-CLEAN');
            await writeFile(output.metadataPath, JSON.stringify({
                outputWidthPx: 80,
                outputHeightPx: 60,
                canvasWidthPx: 120,
                canvasHeightPx: 100,
                matchedCanvasTargetWidthPoints: 28.8,
                matchedCanvasTargetHeightPoints: 24,
                matchedCanvasContentWidthPx: 120,
                matchedCanvasContentHeightPx: 90,
                placementOffsetXPx: 0,
                placementOffsetYPx: 5,
                pdfImagePlacement: {
                    xPoints: 0,
                    yPoints: 1.2,
                    widthPoints: 28.8,
                    heightPoints: 21.6,
                },
                renderDpi: 300,
                layoutClassification: 'single-uncut-page',
                skewApplied: false,
                outputMode: 'grayscale',
                bilevelWritten: false,
                layeredWritten: false,
                contentBox: null,
                warnings: [],
            }));
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.getPageCount = vi.fn(async () => 1);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(300, [[
            1,
            300,
        ]]));
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (await answerPageSizesCommand(args, 1)) {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
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
                outputMode: 'grayscale',
            },
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        const fields = combineManifest.trim().split('\t');
        expect(fields.slice(0, 4)).toEqual([
            'image-jpeg',
            '28.800000',
            '24.000000',
            String(SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY),
        ]);
        expect(fields[4]).toMatch(/clean-1-0\.png$/u);
        expect(fields.slice(5)).toEqual([
            '0.000000',
            '1.200000',
            '28.800000',
            '21.600000',
        ]);
    });

    it('hands the raster sidecar the document rectangle and the one grid it renders on', async () => {
        const fixture = await setup();
        let manifestCanvas: unknown;
        let manifestPageDpi: number[] = [];
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                documentCanvas?: {
                    widthPoints: number;
                    heightPoints: number;
                    widthPx: number;
                    heightPx: number;
                };
                pages: Array<{
                    pageMetadataPath: string;
                    options: {
                        dpi: number;
                        matchPageSize: boolean
                    };
                    outputs: ICleanupOutput[];
                }>;
            };
            manifestCanvas = manifest.documentCanvas;
            manifestPageDpi = manifest.pages.map(page => page.options.dpi);
            const canvas = manifest.documentCanvas!;
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                const output = page.outputs[0]!;
                await writeFile(output.outputPath, 'PNG-CLEAN');
                // What the sidecar publishes once it has normalized the page:
                // the document's own grid, for every page of the run.
                await writeFile(output.metadataPath, JSON.stringify({
                    outputWidthPx: canvas.widthPx,
                    outputHeightPx: canvas.heightPx,
                    canvasWidthPx: canvas.widthPx,
                    canvasHeightPx: canvas.heightPx,
                    matchedCanvasTargetWidthPx: canvas.widthPx,
                    matchedCanvasTargetHeightPx: canvas.heightPx,
                    matchedCanvasTargetWidthPoints: canvas.widthPoints,
                    matchedCanvasTargetHeightPoints: canvas.heightPoints,
                    renderDpi: page.options.dpi,
                    layoutClassification: 'single-uncut-page',
                    skewApplied: true,
                    outputMode: 'color',
                }));
            }
        });
        const pipelineDependencies = dependencies(runSidecar);
        const pdfimagesDetector = pipelineDependencies.detectSourceDpi;
        const baseRunCommand = pipelineDependencies.runCommand;
        pipelineDependencies.runCommand = vi.fn(async (command, args, commandOptions) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (args[0] === 'page-sizes') {
                const outputPath = args[args.indexOf('--output') + 1]!;
                await writeFile(outputPath, JSON.stringify({pages: [
                    {
                        pageNumber: 1,
                        xPoints: 0,
                        yPoints: 0,
                        widthPoints: 240,
                        heightPoints: 336,
                        rotation: 0,
                        dominantImageWidthPx: 1000,
                        dominantImageHeightPx: 1400,
                        dominantImageWidthPoints: 240,
                        dominantImageHeightPoints: 336,
                    },
                    {
                        pageNumber: 2,
                        xPoints: 0,
                        yPoints: 0,
                        widthPoints: 240,
                        heightPoints: 336,
                        rotation: 0,
                        dominantImageWidthPx: 500,
                        dominantImageHeightPx: 700,
                        dominantImageWidthPoints: 240,
                        dominantImageHeightPoints: 336,
                    },
                ]}));
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const manifestIndex = args.indexOf('--compact-manifest');
            if (manifestIndex !== -1) combineManifest = await readFile(args[manifestIndex + 1]!, 'utf8');
            return baseRunCommand(command, args, commandOptions);
        });

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                outputMode: 'color',
                matchPageSize: true,
            },
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        // The default raster path measures the document and hands the plan
        // over: 240 x 336 points, on the grid of the finest page the run
        // renders (page one at 300 DPI; page two is raised from 150).
        expect(manifestPageDpi).toEqual([
            300,
            300,
        ]);
        expect(manifestCanvas).toEqual({
            widthPoints: 240,
            heightPoints: 336,
            widthPx: Math.floor(240 / 72 * 300),
            heightPx: Math.floor(336 / 72 * 300),
        });
        expect(pdfimagesDetector).not.toHaveBeenCalled();
        // And every assembled page is that one rectangle, in absolute points.
        expect(combineManifest.trim().split('\n').map(line => line.split('\t').slice(1, 3).join('x')))
            .toEqual([
                '240.000000x336.000000',
                '240.000000x336.000000',
            ]);
    });

    it('records the composite for pages whose bilevel raster the sidecar could not publish', async () => {
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
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (await answerPageSizesCommand(args, 2)) {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            combineManifest = await readFile(args[args.indexOf('--compact-manifest') + 1]!, 'utf8');
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });

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
            vi.fn(),
            pipelineDependencies,
        );

        expect(summary.outputPages).toBe(2);
        const records = combineManifest.trim().split('\n').map(line => line.split('\t'));
        expect(records.map(record => record[0])).toEqual([
            'image',
            'image-bilevel',
        ]);
        expect(records[0]![3]).toMatch(/clean-1-0\.png$/u);
        expect(records[1]![3]).toMatch(/clean-2-0\.pbm$/u);
    });

    it('fails the run when a published bilevel raster has vanished', async () => {
        const fixture = await setup();
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
                    true,
                    page.options.dpi,
                );
            }
            await unlink(manifest.pages[0]!.outputs[0]!.bilevelOutputPath!);
        });

        const missingRasterRun = runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            },
            pipelinePaths(fixture.dir),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            vi.fn(),
            dependencies(runSidecar),
        );
        await expect(missingRasterRun).rejects.toMatchObject({
            name: 'ScanCleanupMissingOutputError',
            code: 'SCAN_CLEANUP_OUTPUT_MISSING',
            sourcePageNumber: 1,
        });
        await expect(missingRasterRun).rejects.toThrow(/source page 1 is missing: bilevel output/u);
    });

    it('fails the run with a typed source-page error when produced output metadata is missing', async () => {
        const fixture = await setup();
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string;}>};
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
            }
        });

        let caught: unknown;
        try {
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
                vi.fn(),
                dependencies(runSidecar),
            );
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(ScanCleanupMissingOutputError);
        expect(caught).toMatchObject({
            code: 'SCAN_CLEANUP_OUTPUT_MISSING',
            sourcePageNumber: 1,
            role: 'output metadata',
        });
        expect((caught as Error).message).toMatch(/source page 1 is missing: output metadata/u);
    });

    it('aborts publication and preserves the staged PDF when qpdf rejects its structure', async () => {
        const fixture = await setup();
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
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
                await writeCleanupOutput(page.outputs[0]!, 'single-uncut-page', true, false, page.options.dpi);
            }
        });
        const pipelineDependencies = dependencies(runSidecar);
        const baseRunCommand = pipelineDependencies.runCommand;
        let stagedPdfPath: string | undefined;
        pipelineDependencies.runCommand = vi.fn(async (command, args, commandOptions) => {
            if (args[0] === '--check') {
                stagedPdfPath = args[1];
                return {
                    exitCode: 2,
                    stdout: '',
                    stderr: 'malformed xref',
                };
            }
            return baseRunCommand(command, args, commandOptions);
        });

        let caught: unknown;
        try {
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
                vi.fn(),
                pipelineDependencies,
            );
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(ScanCleanupPdfValidationError);
        expect(caught).toMatchObject({
            code: 'SCAN_CLEANUP_PDF_VALIDATION_FAILED',
            stagedPdfPath,
        });
        expect(stagedPdfPath).toBeDefined();
        expect((await readFile(stagedPdfPath!)).toString('utf8')).toContain('%PDF-1.7');
        await expect(readFile(fixture.outputPdfPath)).rejects.toMatchObject({code: 'ENOENT'});
        expect(pipelineDependencies.runCommand).toHaveBeenCalledWith(
            '/qpdf',
            [
                '--check',
                stagedPdfPath,
            ],
            expect.objectContaining({allowedExitCodes: [
                0,
                3,
            ]}),
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
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (await answerPageSizesCommand(args, 2)) {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
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
        expect(records[0]![3]).toBe(String(SCAN_CLEANUP_COLOR_JPEG_QUALITY));
        expect(records[0]![4]).toMatch(/clean-1-0-background\.ppm$/u);
        expect(records[0]![5]).toMatch(/clean-1-0-mask\.pbm$/u);
        expect(records[1]![3]).toMatch(/clean-2-0\.pbm$/u);
    });

    it('reuses an Auto MRC foreground without rasterizing or upscaling it', async () => {
        const fixture = await setup();
        let combineManifest = '';
        let cleanupManifest: {pages: Array<{
            trustedForegroundMaskPath?: string;
            trustedMrcBackgroundPath?: string;
            pageMetadataPath: string;
            outputs: ICleanupOutput[]
        }>} | null = null;
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(
            async (_binary, manifestPath) => {
                cleanupManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof cleanupManifest;
                const page = cleanupManifest!.pages[0]!;
                expect(page.trustedForegroundMaskPath).toMatch(/source-1-mrc-selection\.jb2e$/u);
                expect(page.trustedMrcBackgroundPath).toMatch(/source-1-mrc-background\.ppm$/u);
                const output = page.outputs[0]!;
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                await writeFile(output.backgroundOutputPath!, ppm(333, 467));
                await writeFile(output.foregroundMaskOutputPath!, pbm(1_000, 1_400));
                await writeFile(output.metadataPath, JSON.stringify({
                    sourcePageIndex: 0,
                    half: 'full',
                    sourceRegion: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 1_000,
                        heightPx: 1_400,
                    },
                    cropRect: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 1_000,
                        heightPx: 1_400,
                    },
                    inputWidthPx: 1_000,
                    inputHeightPx: 1_400,
                    outputWidthPx: 1_000,
                    outputHeightPx: 1_400,
                    canvasWidthPx: 1_000,
                    canvasHeightPx: 1_400,
                    placementOffsetXPx: 0,
                    placementOffsetYPx: 0,
                    renderDpi: 300,
                    layoutClassification: 'single-uncut-page',
                    rotationDegrees: 0,
                    skewApplied: false,
                    dewarpModel: null,
                    dewarpMapping: null,
                    outputMode: 'mixed',
                    layeredWritten: true,
                    layeredBackgroundDpi: 100,
                    layeredForegroundDpi: 300,
                    layeredForegroundKind: 'source-mrc',
                    backgroundIsColor: true,
                    forwardTransform: {matrix: [
                        [
                            1,
                            0,
                            0,
                        ],
                        [
                            0,
                            1,
                            0,
                        ],
                        [
                            0,
                            0,
                            1,
                        ],
                    ]},
                    contentBox: null,
                    warnings: [],
                }));
            },
        );
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.getPageCount = vi.fn(async () => 1);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => ({
            documentDpi: 300,
            pageDpiByNumber: new Map([[
                1,
                300,
            ]]),
            pageRasterByNumber: new Map([[
                1,
                {
                    dpi: 300,
                    width: 1_000,
                    height: 1_400,
                    hasBilevelLayer: true,
                    backgroundDpi: 100,
                },
            ]]),
        }));
        pipelineDependencies.extractMrcLayers = vi.fn();
        pipelineDependencies.extractMrcLayersBatch = vi.fn(async input => {
            const layers = new Map();
            for (const target of input.targets) {
                await Promise.all([
                    writeFile(target.backgroundOutputPath, PNG),
                    writeFile(target.foregroundOutputPath, 'JP2-SOURCE'),
                    writeFile(target.selectionMaskOutputPath, PNG),
                ]);
                layers.set(target.pageNumber, {
                    backgroundDpi: 100,
                    backgroundPath: target.backgroundOutputPath,
                    foregroundDpi: 600,
                    foregroundHeight: 2_800,
                    foregroundPath: target.foregroundOutputPath,
                    foregroundWidth: 2_000,
                    selectionMaskDecode: 'default',
                    selectionMaskPath: target.selectionMaskOutputPath,
                });
            }
            input.onProgress?.(input.targets.length, input.targets.length);
            return layers;
        });
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const manifestIndex = args.indexOf('--compact-manifest');
            if (manifestIndex !== -1) {
                combineManifest = await readFile(args[manifestIndex + 1]!, 'utf8');
            }
            const outputIndex = args.indexOf('--output');
            await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
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
                matchPageSize: false,
            },
            outputModeRecommendations: {'1': 'mixed'},
            sourcePageMetadataByPage: {'1': {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 240,
                heightPoints: 336,
                rotation: 0,
                sourceDpi: 300,
            }},
        }, {
            ...pipelinePaths(fixture.dir),
            pdfimagesBinary: '/pdfimages',
        }, new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        expect(pipelineDependencies.extractMrcLayersBatch).toHaveBeenCalledTimes(1);
        expect(pipelineDependencies.extractMrcLayers).not.toHaveBeenCalled();
        const record = combineManifest.trim().split('\t');
        expect(record.slice(0, 4)).toEqual([
            'affine-masked-layered-jpeg',
            '240.000000',
            '336.000000',
            String(SCAN_CLEANUP_COLOR_JPEG_QUALITY),
        ]);
        expect(record[5]).toMatch(/source-1-mrc-foreground\.jp2$/u);
        expect(record[6]).toMatch(/source-1-mrc-selection\.jb2e$/u);
        expect(record.slice(7, 13).map(Number)).toEqual([
            240,
            0,
            0,
            336,
            0,
            0,
        ]);
        expect(record[13]).toBe('default');
    });

    it('rejects malformed final geometry before extracting reusable MRC layers', async () => {
        const fixture = await setup();
        const pipelineDependencies = dependencies(vi.fn());
        pipelineDependencies.getPageCount = vi.fn(async () => 1);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => ({
            documentDpi: 300,
            pageDpiByNumber: new Map([[
                1,
                300,
            ]]),
            pageRasterByNumber: new Map([[
                1,
                {
                    dpi: 300,
                    width: 1_000,
                    height: 1_400,
                    hasBilevelLayer: true,
                    backgroundDpi: 100,
                },
            ]]),
        }));
        pipelineDependencies.extractMrcLayers = vi.fn();
        pipelineDependencies.extractMrcLayersBatch = vi.fn();

        await expect(runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                outputMode: 'auto',
                matchPageSize: false,
            },
            outputModeRecommendations: {'1': 'mixed'},
            layoutByPage: {'1': 'single-uncut-page'},
            pagePlanEvidenceByPage: {'1': {
                pageNumber: 1,
                rotationDegrees: 0,
                layoutClassification: 'single-uncut-page',
                outputs: {right: {contentBox: {
                    xNormalized: 0.72,
                    yNormalized: 0.1,
                    widthNormalized: 0.29,
                    heightNormalized: 0.8,
                    rotationDegrees: 0,
                }}},
            }},
        }, {
            ...pipelinePaths(fixture.dir),
            pdfimagesBinary: '/pdfimages',
        }, new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies))
            .rejects.toThrow(
                'Scan cleanup page 1 has invalid automatic right content box geometry',
            );
        expect(pipelineDependencies.extractMrcLayers).not.toHaveBeenCalled();
        expect(pipelineDependencies.extractMrcLayersBatch).not.toHaveBeenCalled();
    });

    it.each([
        [
            'vanished',
            async (output: ICleanupOutput) => {
                await unlink(output.backgroundOutputPath!);
            },
            /source page 1 is missing: mixed background layer/u,
        ],
        [
            'malformed',
            async (output: ICleanupOutput) => {
                await writeFile(output.foregroundMaskOutputPath!, 'P4\nnot-a-size\n');
            },
            /Invalid PBM width/u,
        ],
    ] as const)('fails the run when a published mixed layer is %s', async (_case, corrupt, expected) => {
        const fixture = await setup();
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
            await corrupt(manifest.pages[0]!.outputs[0]!);
        });

        await expect(runScanCleanupPipeline(
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
            vi.fn(),
            dependencies(runSidecar),
        )).rejects.toThrow(expected);
    });

    it('falls back to the composite when published mixed-layer dimensions are inconsistent', async () => {
        const fixture = await setup();
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {dpi: number};
                outputs: ICleanupOutput[]
            }>};
            const page = manifest.pages[0]!;
            await writeFile(page.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            const output = page.outputs[0]!;
            await writeCleanupOutput(
                output,
                'single-uncut-page',
                true,
                false,
                page.options.dpi,
                false,
                true,
            );
            // A successfully layered native publication normally omits the
            // composite. Keep one here to pin the TS boundary's non-MRC path.
            await writeFile(output.outputPath, 'PNG-CLEAN');
            await writeFile(output.backgroundOutputPath!, ppm(999, 1_400));
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.getPageCount = vi.fn(async () => 1);
        pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(300, [[
            1,
            300,
        ]]));
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const manifestIndex = args.indexOf('--compact-manifest');
            if (manifestIndex !== -1) {
                combineManifest = await readFile(args[manifestIndex + 1]!, 'utf8');
            }
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
                    matchPageSize: false,
                },
                sourcePageMetadataByPage: {'1': {
                    pageNumber: 1,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 240,
                    heightPoints: 336,
                    rotation: 0,
                    sourceDpi: 300,
                }},
            },
            pipelinePaths(fixture.dir),
            new AbortController().signal,
            vi.fn(),
            highTierPolicy,
            log,
            pipelineDependencies,
        );

        expect(summary.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Page 1 mixed layer dimensions do not match metadata')]));
        expect(log).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('Page 1 mixed layer dimensions do not match metadata'),
        );
        expect(combineManifest.trim().split('\t')[0]).toBe('image-jpeg');
        expect(combineManifest).not.toContain('layered-jpeg');
    });

    it('keeps detected BW rasters on the finest measured source grid', async () => {
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
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (await answerPageSizesCommand(args, 2)) {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
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
                dpi: 720,
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

    it('caps an oversized detected BW raster at the shared 160 MP handoff limit', async () => {
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

    it('floors an undetected BW source at 600 DPI', async () => {
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

        // Trusted PDF geometry bounds the synthesis raster without a redundant
        // low-DPI probe render.
        expect(pipelineDependencies.renderPage).not.toHaveBeenCalled();
        expect(requestedRenderDpi).toBe(600);
        expect(finalDpi).toBe(600);
    });

    it('keeps a reliable low-DPI raster on its measured source grid', async () => {
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

    it('renders BW and mixed recommendations on the finest matched document grid', async () => {
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
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (await answerPageSizesCommand(args, 4)) {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
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
        expect(renderedDpis.toSorted((left, right) => left - right)).toEqual([
            150,
            150,
            150,
            150,
            720,
            720,
            720,
            720,
        ]);
        expect(finalOptions).toEqual([
            expect.objectContaining({
                dpi: 720,
                requestedRenderDpi: 720,
                outputMode: 'grayscale',
            }),
            expect.objectContaining({
                dpi: 720,
                requestedRenderDpi: 640,
                outputMode: 'color',
            }),
            expect.objectContaining({
                dpi: 720,
                requestedRenderDpi: 300,
                outputMode: 'bw',
            }),
            expect.objectContaining({
                dpi: 720,
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
                String(SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY),
            ],
            [
                'image-jpeg',
                String(SCAN_CLEANUP_COLOR_JPEG_QUALITY),
            ],
            [
                'image',
                expect.stringMatching(/clean-3-0\.png$/u),
            ],
            [
                'image-jpeg',
                String(SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY),
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
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (await answerPageSizesCommand(args)) {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
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
        expect(record[3]).toBe(String(SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY));
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
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (await answerPageSizesCommand(args, 2)) {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(outputPath, JSON.stringify({pages: [
                {
                    pageNumber: 1,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 200,
                    heightPoints: 100,
                    rotation: 0,
                },
                {
                    pageNumber: 2,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 200,
                    heightPoints: 100,
                    rotation: 0,
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

    it('places every matched output on one rotation-aware document canvas', async () => {
        const fixture = await setup();
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
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string;}>};
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
                    // The first page's content is a quarter of the sheet, so a
                    // canvas taken from the outputs rather than from the
                    // document would frame it by its own crop.
                    outputs: [{
                        half: 'full',
                        // The whole sheet: the page was not cut, so the paper
                        // it owns is the raster it was rendered from.
                        sourceRegion: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 400,
                            heightPx: 200,
                        },
                        cropRect: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: index === 0 ? 200 : 400,
                            heightPx: index === 0 ? 100 : 200,
                        },
                        inputWidthPx: 400,
                        inputHeightPx: 200,
                    }],
                }));
            }
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputPath = args[args.indexOf('--output') + 1]!;
            if (args[0] === 'page-sizes') {
                // A landscape page, and the same paper stored as a rotated
                // portrait page. Both are presented 400 x 200.
                await writeFile(outputPath, JSON.stringify({pages: [
                    {
                        pageNumber: 1,
                        xPoints: 0,
                        yPoints: 0,
                        widthPoints: 400,
                        heightPoints: 200,
                        rotation: 0,
                    },
                    {
                        pageNumber: 2,
                        xPoints: 0,
                        yPoints: 0,
                        widthPoints: 200,
                        heightPoints: 400,
                        rotation: 90,
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

        await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                preserveOriginalQuality: true,
                crop: false,
                matchPageSize: true,
                pageAlignment: 'top-left',
            },
        }, pipelinePaths(fixture.dir, true), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        // The canvas is 400 x 200 as presented. The rotated page carries it
        // with the axes swapped, because split-pages writes the box in the
        // page's own unrotated space and keeps its rotation, so both pages
        // display at exactly the same size.
        expect(splitInstructions).toEqual({pages: [
            {
                sourcePageIndex: 0,
                rotationQuarterTurns: 0,
                outputs: [{cropRect: {
                    x: 0,
                    y: 0,
                    width: 400,
                    height: 200,
                }}],
            },
            {
                sourcePageIndex: 1,
                rotationQuarterTurns: 0,
                outputs: [{cropRect: {
                    x: 0,
                    y: 0,
                    width: 200,
                    height: 400,
                }}],
            },
        ]});
    });

    it('measures a matched run through pdfinfo when page-ops is unavailable', async () => {
        const fixture = await setup();
        let manifestOptions: Record<string, unknown> | null = null;
        let manifestCanvas: unknown;
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                documentCanvas?: unknown;
                pages: Array<{
                    pageMetadataPath: string;
                    options: Record<string, unknown>;
                    outputs: Array<{
                        outputPath: string;
                        metadataPath: string
                    }>;
                }>;
            };
            manifestOptions = manifest.pages[0]!.options;
            manifestCanvas = manifest.documentCanvas;
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                const output = page.outputs[0]!;
                await writeFile(output.outputPath, PNG);
                await writeFile(output.metadataPath, JSON.stringify({
                    outputWidthPx: 1,
                    outputHeightPx: 1,
                    canvasWidthPx: 1,
                    canvasHeightPx: 1,
                    layoutClassification: 'single-uncut-page',
                    skewApplied: false,
                    outputMode: 'bw',
                }));
            }
        });

        // Matched page size is a default setting, and the geometry it needs is
        // something every PDF tool can report. An installation without
        // evb-pdf-page-ops — or one where it is disabled — measures the document
        // through Poppler instead of failing the feature or, worse, quietly
        // producing pages of differing size.
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (command === '/pdfinfo') {
                return {
                    exitCode: 0,
                    stdout: pdfInfoGeometry(2, 240, 336),
                    stderr: '',
                };
            }
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
        }, pipelinePaths(fixture.dir, false, true), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        expect(manifestOptions).toMatchObject({matchPageSize: true});
        expect(manifestCanvas).toEqual({
            widthPoints: 240,
            heightPoints: 336,
            widthPx: Math.ceil(240 / 72 * 300),
            heightPx: Math.ceil(336 / 72 * 300),
        });
    });

    // Every raster mode now needs trusted page geometry before Poppler starts.
    // Missing or failed measurement is therefore a deterministic preflight
    // error rather than an unbounded render with matched-page-size disabled.
    for (const [
        label,
        withPdfInfo,
        breakPageOps,
        expectedError,
    ] of [
            [
                'nothing can measure the document',
                false,
                false,
                /no PDF tool is available to read page geometry/u,
            ],
            [
                'the measurement itself fails',
                false,
                true,
                /evb-pdf-page-ops crashed/u,
            ],
        ] as const) {
        it(`rejects before rasterization when ${label}`, async () => {
            const fixture = await setup();
            const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn();
            const pipelineDependencies = dependencies(runSidecar);
            if (breakPageOps) {
                const baseRunCommand = pipelineDependencies.runCommand;
                pipelineDependencies.runCommand = vi.fn(async (command, args, commandOptions) => {
                    if (args[0] === '--check') {
                        return {
                            exitCode: 0,
                            stdout: '',
                            stderr: '',
                        };
                    }
                    if (args[0] === 'page-sizes') throw new Error('evb-pdf-page-ops crashed');
                    return baseRunCommand(command, args, commandOptions);
                });
            }

            await expect(runScanCleanupPipeline({
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            }, pipelinePaths(fixture.dir, breakPageOps, withPdfInfo), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies))
                .rejects.toThrow(expectedError);
            expect(runSidecar).not.toHaveBeenCalled();
            expect(pipelineDependencies.renderPage).not.toHaveBeenCalled();
            expect(pipelineDependencies.renderPagePpm).not.toHaveBeenCalled();
        });
    }

    /**
     * A source-DPI detector that answers only about the pages it was asked
     * about, the way pdfimages does: a scan of the whole document when the run
     * passes no page numbers, and a scan of the scope when it does. A mock that
     * answers about the whole document either way cannot tell a run that
     * measures the document from one that measures its own selection.
     */
    function scopedDetector(
        pageGeometry: Array<{
            widthPoints: number;
            heightPoints: number
        }>,
        sourceDpiByPage: ReadonlyMap<number, number>,
    ): IRunScanCleanupPipelineDependencies['detectSourceDpi'] {
        return vi.fn(async (
            _pdfPath,
            _binary,
            _log,
            _unused,
            _signal,
            pageNumbers,
        ) => {
            const visible: readonly number[] = pageNumbers
                ?? pageGeometry.map((_geometry, index) => index + 1);
            const rows = visible
                .filter(pageNumber => sourceDpiByPage.has(pageNumber))
                .map(pageNumber => {
                    const dpi = sourceDpiByPage.get(pageNumber)!;
                    const geometry = pageGeometry[pageNumber - 1]!;
                    return [
                        pageNumber,
                        dpi,
                        {
                            width: Math.round(geometry.widthPoints / 72 * dpi),
                            height: Math.round(geometry.heightPoints / 72 * dpi),
                        },
                    ] as [number, number, {
                        width: number;
                        height: number
                    }];
                });
            return dpiDetails(
                rows.length === 0 ? null : Math.max(...rows.map(row => row[1])),
                rows,
            );
        });
    }

    // What the raster sidecar is told to normalize onto, for a document whose
    // page geometry, source resolutions and run scope the caller chooses.
    async function measuredCanvas(
        pageGeometry: Array<{
            widthPoints: number;
            heightPoints: number
        }>,
        runOptions: Partial<IScanCleanupOptions>,
        request: Partial<Parameters<typeof runScanCleanupPipeline>[0]> = {},
        sourceDpiByPage?: ReadonlyMap<number, number>,
    ) {
        const fixture = await setup();
        let manifestCanvas: {
            widthPoints: number;
            heightPoints: number;
            widthPx: number;
            heightPx: number
        } | undefined;
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                documentCanvas?: typeof manifestCanvas;
                pages: Array<{
                    pageMetadataPath: string;
                    options: {dpi: number};
                    outputs: ICleanupOutput[];
                }>;
            };
            manifestCanvas = manifest.documentCanvas;
            for (const page of manifest.pages) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                }));
                const output = page.outputs[0]!;
                await writeFile(output.outputPath, PNG);
                await writeFile(output.metadataPath, JSON.stringify({
                    outputWidthPx: 1,
                    outputHeightPx: 1,
                    canvasWidthPx: 1,
                    canvasHeightPx: 1,
                    renderDpi: page.options.dpi,
                    layoutClassification: 'single-uncut-page',
                    skewApplied: false,
                    outputMode: 'bw',
                }));
            }
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.getPageCount = vi.fn(async () => pageGeometry.length);
        if (sourceDpiByPage) {
            pipelineDependencies.detectSourceDpi = scopedDetector(pageGeometry, sourceDpiByPage);
        }
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputPath = args[args.indexOf('--output') + 1]!;
            if (args[0] === 'page-sizes') {
                await writeFile(outputPath, JSON.stringify({pages: pageGeometry.map((geometry, index) => ({
                    pageNumber: index + 1,
                    xPoints: 0,
                    yPoints: 0,
                    ...geometry,
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

        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                ...runOptions,
            },
            ...request,
        }, pipelinePaths(fixture.dir), new AbortController().signal, vi.fn(), highTierPolicy, undefined, pipelineDependencies);

        return {
            canvas: manifestCanvas,
            warnings: summary.warnings,
        };
    }

    it('stays quiet about a canvas a document with no page left on it never had', async () => {
        // Every page excluded answers no rectangle, but for a reason the user
        // chose: there is no page to normalize. That is not the document whose
        // geometry could not be read, and reporting it as one names a problem
        // the document does not have.
        const excluded = {
            rotationDegrees: 0 as const,
            layoutOverride: 'auto' as const,
            excluded: true,
            manualSplit: null,
        };
        const measured = await measuredCanvas([
            {
                widthPoints: 400,
                heightPoints: 200,
            },
            {
                widthPoints: 400,
                heightPoints: 200,
            },
        ], {pageOverrides: {
            '1': excluded,
            '2': excluded,
        }});

        expect(measured.canvas).toBeUndefined();
        expect(measured.warnings.filter(warning => /Matched page size was dropped/u.test(warning)))
            .toEqual([]);
    });

    it('says when the pixel budget lowered the grid the finest page asked for', async () => {
        // A large sheet and a small one scanned far finer. The shared grid is
        // the large sheet's rectangle at the finest resolution the document
        // carries, which is more pixels than any output may have — so the
        // budget lowers it, and the run names the resolution it actually
        // normalized at instead of shipping one nobody chose.
        const measured = await measuredCanvas([
            {
                widthPoints: 3_000,
                heightPoints: 4_000,
            },
            {
                widthPoints: 100,
                heightPoints: 100,
            },
        ], {outputMode: 'bw'}, {}, new Map([
            [
                1,
                150,
            ],
            [
                2,
                1_200,
            ],
        ]));

        const canvasDpi = measured.canvas!.widthPx / measured.canvas!.widthPoints * 72;
        expect(canvasDpi).toBeLessThan(1_200);
        expect(measured.warnings.filter(warning => /normalized this document at/u.test(warning)))
            .toEqual([`Matched page size normalized this document at ${String(Math.round(canvasDpi))} DPI `
                + 'instead of the 1200 DPI its finest page was rendered at, '
                + 'to keep one shared page inside the output pixel budget']);
    });

    it('measures a document of spreads by the half sheets it produces', async () => {
        const sheets = [
            {
                widthPoints: 400,
                heightPoints: 200,
            },
            {
                widthPoints: 400,
                heightPoints: 200,
            },
        ];

        // Each sheet carries two book pages, so the document's page is half of
        // it. Measuring the sheet would hand the sidecar a rectangle twice as
        // wide as the pages it produces and leave every half on an empty sheet.
        expect((await measuredCanvas(sheets, {layoutMode: 'force-two-page'})).canvas).toMatchObject({
            widthPoints: 200,
            heightPoints: 200,
        });
        // The same document on automatic layout, measured from what detection
        // has already told the caller about it.
        expect((await measuredCanvas(sheets, {}, {layoutByPage: {
            '1': 'two-page-spread',
            '2': 'two-page-spread',
        }})).canvas).toMatchObject({
            widthPoints: 200,
            heightPoints: 200,
        });
        // And nothing is assumed about a document nobody has classified.
        expect((await measuredCanvas(sheets, {})).canvas).toMatchObject({
            widthPoints: 400,
            heightPoints: 200,
        });
    });

    it('measures a page detection has not reached as the whole sheet it is, and reports it', async () => {
        const sheets = [
            {
                widthPoints: 400,
                heightPoints: 200,
            },
            {
                widthPoints: 400,
                heightPoints: 200,
            },
        ];

        // Run before detection settled: page 1 came back a spread, page 2 has
        // not come back at all. Taking page 1's answer for page 2 would halve
        // the document rectangle, and every page of this document that is not
        // a spread would then be scaled down to half the document's scale for
        // no reason but the order the classifications happened to land in.
        const partialEvidence = await measuredCanvas(sheets, {}, {layoutByPage: {'1': 'two-page-spread'}});

        expect(partialEvidence.canvas).toMatchObject({
            widthPoints: 400,
            heightPoints: 200,
        });
        // A page measured that way can still turn out to be a spread, which
        // lands it on the rectangle without being scaled to it, so the run
        // names it rather than leaving it to be found.
        expect(partialEvidence.warnings).toEqual([expect.stringContaining('Matched page size measured 1 page(s) as whole sheets')]);
        // Once detection has settled there is nothing left to report.
        expect((await measuredCanvas(sheets, {}, {layoutByPage: {
            '1': 'two-page-spread',
            '2': 'single-uncut-page',
        }})).warnings).toEqual([]);
    });

    it('measures the whole document whether the run cleans all of it or one page', async () => {
        const pages = [
            {
                widthPoints: 240,
                heightPoints: 336,
            },
            {
                widthPoints: 480,
                heightPoints: 672,
            },
        ];
        const full = (await measuredCanvas(pages, {})).canvas;
        // The smaller page, cleaned on its own: a rectangle measured from the
        // selection would be that page's own 240 x 336.
        const partial = (await measuredCanvas(pages, {}, {sourcePageNumbers: [1]})).canvas;

        // Cleaning one page of a document has to produce a page that belongs
        // beside the others, so the rectangle is the document's, not the
        // selection's.
        expect(full).toMatchObject({
            widthPoints: 480,
            heightPoints: 672,
        });
        expect(partial).toEqual(full);
    });

    it('gives a partial run the pixel grid the whole document is rendered on', async () => {
        // One document, two Letter pages, scanned at different resolutions:
        // page 1 at 300 DPI and page 2 at 150. Existing rasters use the finest
        // measured source grid, independent of which page is selected.
        const letter = [
            {
                widthPoints: 612,
                heightPoints: 792,
            },
            {
                widthPoints: 612,
                heightPoints: 792,
            },
        ];
        const sourceDpiByPage = new Map([
            [
                1,
                300,
            ],
            [
                2,
                150,
            ],
        ]);
        const documentGrid = {
            widthPoints: 612,
            heightPoints: 792,
            widthPx: Math.ceil(612 / 72 * 300),
            heightPx: Math.ceil(792 / 72 * 300),
        };

        const full = (await measuredCanvas(letter, {}, {}, sourceDpiByPage)).canvas;
        // The low-resolution page, cleaned on its own. Its own render is
        // 1275 x 1650 at source resolution, and a grid derived from the run's
        // scope still has to match the complete document's source-aware grid.
        const partialLowDpiPage = (await measuredCanvas(
            letter,
            {},
            {sourcePageNumbers: [2]},
            sourceDpiByPage,
        )).canvas;
        const partialHighDpiPage = (await measuredCanvas(
            letter,
            {},
            {sourcePageNumbers: [1]},
            sourceDpiByPage,
        )).canvas;

        expect(full).toEqual(documentGrid);
        expect(partialLowDpiPage).toEqual(documentGrid);
        expect(partialHighDpiPage).toEqual(documentGrid);
    });

    // Once Auto decisions are locked, run scope must not change the document
    // grid. Cleaning one page now and another later must still write pages with
    // identical physical and pixel dimensions.
    async function canvasAcrossScopeAndRecommendations(
        pageGeometry: Array<{
            widthPoints: number;
            heightPoints: number
        }>,
        runOptions: Partial<IScanCleanupOptions>,
        sourceDpiByPage: ReadonlyMap<number, number>,
        recommendations: Partial<Record<string, TScanCleanupOutputMode>>,
    ) {
        const variants = [
            {outputModeRecommendations: recommendations},
            {
                sourcePageNumbers: [1],
                outputModeRecommendations: recommendations,
            },
        ];
        const measured = [];
        for (const variant of variants) {
            measured.push((await measuredCanvas(pageGeometry, runOptions, variant, sourceDpiByPage)).canvas);
        }
        return measured;
    }

    it('measures the shared grid from locked continuous-tone Auto decisions', async () => {
        const letter = [
            {
                widthPoints: 612,
                heightPoints: 792,
            },
            {
                widthPoints: 612,
                heightPoints: 792,
            },
        ];
        // Both pages are locked to Color, so a raster-free vector page must not
        // trigger the binary synthesis floor.
        const [
            completeRun,
            selectedRun,
        ] = await canvasAcrossScopeAndRecommendations(
            letter,
            {outputMode: 'auto'},
            new Map([[
                1,
                150,
            ]]),
            {
                '1': 'color',
                '2': 'color',
            },
        );

        expect(completeRun).toEqual({
            widthPoints: 612,
            heightPoints: 792,
            widthPx: Math.ceil(612 / 72 * 150),
            heightPx: Math.ceil(792 / 72 * 150),
        });
        expect(selectedRun).toEqual(completeRun);
    });

    it('holds locked continuous-tone Auto decisions to their pixel budget across run scopes', async () => {
        const letter = [
            {
                widthPoints: 612,
                heightPoints: 792,
            },
            {
                widthPoints: 612,
                heightPoints: 792,
            },
        ];
        // Page 1 was scanned at 1200 DPI, which is past what one continuous-tone
        // output may be — and `auto` is a continuous-tone budget, because the
        // engine may resolve any of these pages to colour. A recommendation
        // that names the colour it already could have been must not change the
        // budget, and neither must the run's scope.
        const [
            completeRun,
            selectedRun,
        ] = await canvasAcrossScopeAndRecommendations(
            letter,
            {outputMode: 'auto'},
            new Map([
                [
                    1,
                    1_200,
                ],
                [
                    2,
                    150,
                ],
            ]),
            {
                '1': 'color',
                '2': 'color',
            },
        );

        // The budget bound the grid: it is below what the finest page asked for.
        expect(completeRun!.widthPx).toBeLessThan(Math.ceil(612 / 72 * 1_200));
        expect(completeRun!.widthPx * completeRun!.heightPx).toBeLessThanOrEqual(80_000_000);
        expect(selectedRun).toEqual(completeRun);
    });

    it('follows a page output mode override rather than the document default', async () => {
        const letter = [
            {
                widthPoints: 612,
                heightPoints: 792,
            },
            {
                widthPoints: 612,
                heightPoints: 792,
            },
        ];
        // The same raster-free page 2, this time configured as colour outright:
        // it can carry no binary layer, so it asks for nothing past the
        // resolution the document was scanned at and the grid stays there.
        const measured = await measuredCanvas(
            letter,
            {
                outputMode: 'auto',
                pageOverrides: {'2': {
                    rotationDegrees: 0,
                    layoutOverride: 'auto',
                    excluded: false,
                    manualSplit: null,
                    outputModeOverride: 'color',
                }},
            },
            {outputModeRecommendations: {'1': 'color'}},
            new Map([[
                1,
                150,
            ]]),
        );

        expect(measured.canvas).toEqual({
            widthPoints: 612,
            heightPoints: 792,
            widthPx: Math.ceil(612 / 72 * 150),
            heightPx: Math.ceil(792 / 72 * 150),
        });
    });

    // A lossless run of a document whose pages carry the same paper needs no
    // scaling at all, so it stays on the split assembler; one whose pages were
    // scanned at different sizes cannot reach one pixel grid without
    // re-rendering, and matched page size is what the user asked for.
    function losslessMatchedHarness(
        pageGeometry: Array<{
            widthPoints: number;
            heightPoints: number
        }>,
        // What the engine says survived cropping, in the pixels the page was
        // analyzed at. It is the whole sheet unless a test asks for content
        // that margins pushed past the paper it was measured on.
        cropRect = {
            xPx: 0,
            yPx: 0,
            widthPx: 400,
            heightPx: 200,
        },
    ) {
        let splitInstructions: {pages: Array<{
            sourcePageIndex: number;
            rotationQuarterTurns: number;
            outputs: Array<{
                cropRect: {
                    x: number;
                    y: number;
                    width: number;
                    height: number;
                };
                contentTransform?: {
                    scale: number;
                    translateX: number;
                    translateY: number;
                };
            }>;
        }>} | null = null;
        let renderedManifest: {documentCanvas?: unknown} | null = null;
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (
            _binary,
            manifestPath,
            _signal,
            _log,
            onProgress,
        ) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                operation: string;
                documentCanvas?: unknown;
                pages: Array<{
                    pageMetadataPath: string;
                    outputs?: Array<{
                        outputPath: string;
                        metadataPath: string
                    }>;
                }>;
            };
            if (manifest.operation !== 'analyze') renderedManifest = manifest;
            for (const [
                index,
                page,
            ] of manifest.pages.entries()) {
                onProgress?.(0, {
                    stage: 'page-complete',
                    pageNumber: index + 1,
                });
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    layoutClassification: 'single-uncut-page',
                    cutterXPx: null,
                    rotationDegrees: 0,
                    canvasScope: 'document',
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                    outputs: [{
                        half: 'full',
                        sourceRegion: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 400,
                            heightPx: 200,
                        },
                        cropRect,
                        contentBox: cropRect,
                        inputWidthPx: 400,
                        inputHeightPx: 200,
                    }],
                }));
                for (const output of page.outputs ?? []) {
                    await writeFile(output.outputPath, PNG);
                    await writeFile(output.metadataPath, JSON.stringify({
                        outputWidthPx: 1,
                        outputHeightPx: 1,
                        canvasWidthPx: 1,
                        canvasHeightPx: 1,
                        layoutClassification: 'single-uncut-page',
                        skewApplied: false,
                        outputMode: 'color',
                        renderDpi: 300,
                        matchedCanvasTargetWidthPoints: pageGeometry[index]?.widthPoints ?? null,
                        matchedCanvasTargetHeightPoints: pageGeometry[index]?.heightPoints ?? null,
                    }));
                }
            }
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputPath = args[args.indexOf('--output') + 1]!;
            if (args[0] === 'page-sizes') {
                await writeFile(outputPath, JSON.stringify({pages: pageGeometry.map((geometry, index) => ({
                    pageNumber: index + 1,
                    xPoints: 0,
                    yPoints: 0,
                    ...geometry,
                    rotation: 0,
                }))}));
            } else if (args[0] === 'split-pages') {
                const instructionsPath = args[args.indexOf('--instructions-file') + 1]!;
                splitInstructions = JSON.parse(await readFile(instructionsPath, 'utf8')) as typeof splitInstructions;
                await writeFile(outputPath, '%PDF-1.7\n%%EOF\n');
            } else {
                await writeFile(outputPath, '%PDF-1.7\n%%EOF\n');
            }
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        return {
            pipelineDependencies,
            readSplitInstructions: () => splitInstructions,
            readRenderedManifest: () => renderedManifest,
        };
    }

    it('renders a matched run instead of claiming lossless when a page has to change resolution', async () => {
        const fixture = await setup();
        const harness = losslessMatchedHarness([
            {
                widthPoints: 400,
                heightPoints: 200,
            },
            {
                widthPoints: 200,
                heightPoints: 100,
            },
        ]);

        const reported: Array<{
            stage: string;
            percent: number
        }> = [];
        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                preserveOriginalQuality: true,
                crop: false,
                matchPageSize: true,
            },
        }, {
            ...pipelinePaths(fixture.dir, true),
            pdfimagesBinary: '/pdfimages',
        }, new AbortController().signal, progress => reported.push({
            stage: progress.stage,
            percent: progress.percent,
        }), highTierPolicy, undefined, harness.pipelineDependencies);

        // The split assembler never ran: a half-size scanned page cannot reach
        // the document's pixel grid by being re-boxed.
        expect(harness.readSplitInstructions()).toBeNull();
        expect(harness.readRenderedManifest()).not.toBeNull();
        // The rectangle *and* the grid: the document's own paper at the finest
        // resolution any of its pages was scanned at, which is the page that
        // stayed at 300 DPI rather than the half-size one being re-rendered.
        expect(harness.readRenderedManifest()!.documentCanvas).toEqual({
            widthPoints: 400,
            heightPoints: 200,
            widthPx: Math.ceil(400 / 72 * 300),
            heightPx: Math.ceil(200 / 72 * 300),
        });
        // And the run says which pages it re-rendered rather than letting the
        // user believe nothing was touched.
        expect(summary.warnings).toContain(
            'Matched page size re-rendered 1 page(s) that do not share the document\'s pixel grid: 2',
        );
        // The meter follows the run that actually happened. On the lossless
        // weights `rendering` is not a stage at all, so a profile fixed before
        // the fallback would freeze the percentage through the longest stage.
        const rendering = reported.filter(entry => entry.stage === 'rendering');
        expect(rendering.length).toBeGreaterThan(0);
        expect(Math.max(...rendering.map(entry => entry.percent)))
            .toBeGreaterThan(Math.max(...reported
                .filter(entry => entry.stage === 'rasterizing')
                .map(entry => entry.percent)));
    });

    it('reaches the same verdict for one page of a document it cannot keep lossless', async () => {
        const fixture = await setup();
        const harness = losslessMatchedHarness([
            {
                widthPoints: 400,
                heightPoints: 200,
            },
            {
                widthPoints: 200,
                heightPoints: 100,
            },
        ]);

        // Only page one is cleaned, and page one is the canvas: nothing in the
        // selection needs resampling. The document still cannot hold one pixel
        // grid, which is the answer the preview gave the user, so this run gives
        // the same one instead of quietly producing a page cleaned another way.
        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            sourcePageNumbers: [1],
            options: {
                ...options,
                preserveOriginalQuality: true,
                crop: false,
                matchPageSize: true,
            },
        }, {
            ...pipelinePaths(fixture.dir, true),
            pdfimagesBinary: '/pdfimages',
        }, new AbortController().signal, vi.fn(), highTierPolicy, undefined, harness.pipelineDependencies);

        expect(harness.readSplitInstructions()).toBeNull();
        // The rectangle *and* the grid: the document's own paper at the finest
        // resolution any of its pages was scanned at, which is the page that
        // stayed at 300 DPI rather than the half-size one being re-rendered.
        expect(harness.readRenderedManifest()!.documentCanvas).toEqual({
            widthPoints: 400,
            heightPoints: 200,
            widthPx: Math.ceil(400 / 72 * 300),
            heightPx: Math.ceil(200 / 72 * 300),
        });
        expect(summary.warnings).toContain(
            'Matched page size re-rendered 1 page(s) that do not share the document\'s pixel grid: 2',
        );
    });

    it('scales a smaller page onto the canvas with a content transform when nothing has to be resampled', async () => {
        const fixture = await setup();
        const harness = losslessMatchedHarness([
            {
                widthPoints: 400,
                heightPoints: 200,
            },
            {
                widthPoints: 200,
                heightPoints: 100,
            },
        ]);
        // No page carries a raster, so scaling costs nothing: the split
        // assembler carries the page's own objects onto the shared rectangle.
        harness.pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(null, []));

        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                preserveOriginalQuality: true,
                crop: false,
                matchPageSize: true,
                pageAlignment: 'center',
                marginsMm: {
                    leftMm: 0,
                    topMm: 0,
                    rightMm: 0,
                    bottomMm: 0,
                },
            },
            // Detection has settled, so the run measures a document it knows
            // the shape of and has nothing to report about it.
            layoutByPage: {
                '1': 'single-uncut-page',
                '2': 'single-uncut-page',
            },
        }, {
            ...pipelinePaths(fixture.dir, true),
            pdfimagesBinary: '/pdfimages',
        }, new AbortController().signal, vi.fn(), highTierPolicy, undefined, harness.pipelineDependencies);

        expect(summary.warnings).toEqual([]);
        const instructions = harness.readSplitInstructions();
        // The page that already is the canvas is re-boxed and nothing else;
        // the half-size page is doubled onto the same rectangle, and its box
        // is the canvas exactly rather than the canvas around unscaled content.
        expect(instructions!.pages[0]!.outputs[0]).toEqual({cropRect: {
            x: 0,
            y: 0,
            width: 400,
            height: 200,
        }});
        expect(instructions!.pages[1]!.outputs[0]).toEqual({
            cropRect: {
                x: 0,
                y: 0,
                width: 400,
                height: 200,
            },
            contentTransform: {
                scale: 2,
                translateX: 0,
                translateY: 0,
            },
        });
    });

    it('uses one pair-wide fit when either lossless spread leaf reaches the margin box', async () => {
        const fixture = await setup();
        const harness = losslessMatchedHarness([{
            widthPoints: 400,
            heightPoints: 200,
        }]);
        harness.pipelineDependencies.getPageCount = vi.fn(async () => 1);
        harness.pipelineDependencies.runSidecar = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>};
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'two-page-spread',
                cutterXPx: 240,
                rotationDegrees: 0,
                canvasScope: 'document',
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 2,
                outputs: [
                    {
                        half: 'left',
                        sourceRegion: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 240,
                            heightPx: 200,
                        },
                        cropRect: {
                            xPx: 10,
                            yPx: 10,
                            widthPx: 220,
                            heightPx: 180,
                        },
                        contentBox: {
                            xPx: 10,
                            yPx: 10,
                            widthPx: 220,
                            heightPx: 180,
                        },
                        inputWidthPx: 400,
                        inputHeightPx: 200,
                    },
                    {
                        half: 'right',
                        sourceRegion: {
                            xPx: 240,
                            yPx: 0,
                            widthPx: 160,
                            heightPx: 200,
                        },
                        cropRect: {
                            xPx: 250,
                            yPx: 11,
                            widthPx: 100,
                            heightPx: 178,
                        },
                        contentBox: {
                            xPx: 250,
                            yPx: 11,
                            widthPx: 100,
                            heightPx: 178,
                        },
                        inputWidthPx: 400,
                        inputHeightPx: 200,
                    },
                ],
            }));
        });

        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                preserveOriginalQuality: true,
                crop: true,
                matchPageSize: true,
                pageAlignment: 'center',
                marginsMm: {
                    leftMm: 0,
                    topMm: 0,
                    rightMm: 0,
                    bottomMm: 0,
                },
            },
            layoutByPage: {'1': 'two-page-spread'},
        }, {
            ...pipelinePaths(fixture.dir, true),
            pdfimagesBinary: '/pdfimages',
        }, new AbortController().signal, vi.fn(), highTierPolicy, undefined, harness.pipelineDependencies);

        const outputs = harness.readSplitInstructions()!.pages[0]!.outputs;
        expect(outputs).toHaveLength(2);
        const scales = outputs.map(output => output.contentTransform?.scale);
        expect(scales[0]).toBeCloseTo(200 / 220, 6);
        expect(scales[1]).toBeCloseTo(scales[0]!, 12);
        expect(summary.warnings.filter(warning => warning.startsWith(
            'Page 1: Matched page size fitted this page',
        ))).toHaveLength(2);
    });

    it('names the raster pages a layout it was told before analysis left it scaling', async () => {
        const fixture = await setup();
        const harness = losslessMatchedHarness([
            {
                widthPoints: 400,
                heightPoints: 200,
            },
            {
                widthPoints: 200,
                heightPoints: 100,
            },
        ]);

        // The run is told page one is a spread, so it plans the document
        // against the half sheets that page would produce — 200 x 200 — and
        // every page shares that grid, which is what keeps the run lossless.
        // Analysis then reports page one as one uncut page, so its whole 400 pt
        // sheet has to be scaled onto the 200 pt rectangle. The page carries a
        // raster, so that scale is the one case where a matched lossless
        // document holds two visual resolutions, and the run says so rather
        // than shipping it silently.
        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                preserveOriginalQuality: true,
                crop: false,
                matchPageSize: true,
                pageAlignment: 'center',
                marginsMm: {
                    leftMm: 0,
                    topMm: 0,
                    rightMm: 0,
                    bottomMm: 0,
                },
            },
            layoutByPage: {
                '1': 'two-page-spread',
                '2': 'single-uncut-page',
            },
        }, {
            ...pipelinePaths(fixture.dir, true),
            pdfimagesBinary: '/pdfimages',
        }, new AbortController().signal, vi.fn(), highTierPolicy, undefined, harness.pipelineDependencies);

        // It stayed lossless: the assembler carried the page's own objects.
        expect(harness.readSplitInstructions()).not.toBeNull();
        expect(harness.readSplitInstructions()!.pages[0]!.outputs[0]!.contentTransform)
            .toMatchObject({scale: 0.5});
        expect(summary.warnings).toContain(
            'Matched page size scaled 1 page(s) that carry their own raster without re-rendering them: 1',
        );
    });

    it('names a lossless page whose sheet is larger than the rectangle the run measured', async () => {
        const fixture = await setup();
        const harness = losslessMatchedHarness([
            {
                widthPoints: 400,
                heightPoints: 200,
            },
            {
                widthPoints: 400,
                heightPoints: 200,
            },
        ]);
        // No page carries a raster, so nothing is re-rendered and nothing is
        // clipped: the sheets simply land on the canvas at half the document's
        // scale, with a uniform grid and no overflow to report. That is the
        // case this pins — the run was told both sheets were spreads, so it
        // measured the document by the half sheets they would produce, and
        // analysis then cut each sheet as one whole page.
        harness.pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(null, []));

        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                preserveOriginalQuality: true,
                crop: false,
                matchPageSize: true,
                pageAlignment: 'center',
                marginsMm: {
                    leftMm: 0,
                    topMm: 0,
                    rightMm: 0,
                    bottomMm: 0,
                },
            },
            layoutByPage: {
                '1': 'two-page-spread',
                '2': 'two-page-spread',
            },
        }, {
            ...pipelinePaths(fixture.dir, true),
            pdfimagesBinary: '/pdfimages',
        }, new AbortController().signal, vi.fn(), highTierPolicy, undefined, harness.pipelineDependencies);

        // The geometry is untouched by the report: the page is placed on the
        // shared rectangle exactly as before, at half the document's scale.
        const output = harness.readSplitInstructions()!.pages[0]!.outputs[0]!;
        expect(output.cropRect).toEqual({
            x: 0,
            y: 0,
            width: 200,
            height: 200,
        });
        expect(output.contentTransform!.scale).toBeCloseTo(0.5, 6);
        expect(summary.warnings).toEqual([
            'Page 1: Matched page size placed this page at 50.0% of the document\'s scale because its '
            + '400.0x200.0 pt paper is larger than the 200.0x200.0 pt document canvas, '
            + 'which was measured from a different layout for this page',
            'Page 2: Matched page size placed this page at 50.0% of the document\'s scale because its '
            + '400.0x200.0 pt paper is larger than the 200.0x200.0 pt document canvas, '
            + 'which was measured from a different layout for this page',
        ]);
    });

    it('reserves exact final-canvas margins for a lossless matched page and says when content is fitted', async () => {
        const fixture = await setup();
        const harness = losslessMatchedHarness([{
            widthPoints: 400,
            heightPoints: 200,
        }]);
        harness.pipelineDependencies.getPageCount = vi.fn(async () => 1);
        harness.pipelineDependencies.detectSourceDpi = vi.fn(async () => dpiDetails(null, []));

        const summary = await runScanCleanupPipeline({
            sourcePdfPath: fixture.sourcePdfPath,
            outputPdfPath: fixture.outputPdfPath,
            options: {
                ...options,
                preserveOriginalQuality: true,
                matchPageSize: true,
                pageAlignment: 'center',
            },
            layoutByPage: {'1': 'single-uncut-page'},
        }, {
            ...pipelinePaths(fixture.dir, true),
            pdfimagesBinary: '/pdfimages',
        }, new AbortController().signal, vi.fn(), highTierPolicy, undefined, harness.pipelineDependencies);

        // The page rectangle stays fixed. Five millimetres is removed from
        // each final edge before fitting, rather than being padded around the
        // content and then scaled back down with it.
        const output = harness.readSplitInstructions()!.pages[0]!.outputs[0]!;
        expect(output.cropRect).toEqual({
            x: 0,
            y: 0,
            width: 400,
            height: 200,
        });
        const fiveMillimetersPoints = 5 / 25.4 * 72;
        expect(output.contentTransform!.scale).toBeCloseTo(
            (200 - 2 * fiveMillimetersPoints) / 200,
            6,
        );
        expect(output.contentTransform!.translateY).toBeCloseTo(fiveMillimetersPoints, 6);
        // And a page that ended up below the document's scale is named rather
        // than left to be found.
        expect(summary.warnings).toEqual([expect.stringContaining('Page 1: Matched page size fitted this page to 343.3x171.7 pt inside the 371.7x171.7 pt margin box')]);
    });
});
