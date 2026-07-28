import {
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    truncate,
    writeFile,
} from 'fs/promises';
import {tmpdir} from 'os';
import {
    join,
    sep,
} from 'path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {reactive} from 'vue';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupPreviewRequest,
} from '@contracts/electronApiScanCleanup';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {
    forgetRetiredWorkingCopyOriginal,
    rememberRetiredWorkingCopyOriginal,
} from '@electron/file-access/workingCopyStore';
import {
    createScanCleanupPreviewService,
    type IScanCleanupDetectionSubscriber,
    type IScanCleanupPreviewDependencies,
    type IScanCleanupPreviewService,
} from '@electron/features/scan-cleanup/createScanCleanupPreviewService';
import {
    decodeScanCleanupDetectionJobState,
    decodeScanCleanupPreviewResult,
} from '@contracts/scan-cleanup/ipcResultCodecs';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {
    configureMainJobBroker,
    mainJobBroker,
} from '@electron/resources/jobBroker';

configureMainJobBroker({
    logicalCpus: 11,
    totalRamBytes: 32 * 1024 ** 3,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
});

const SCAN_CLEANUP_CHANNELS = SCAN_CLEANUP_PLATFORM_FEATURE.invokeChannels;
const SCAN_CLEANUP_IPC_CODECS = SCAN_CLEANUP_PLATFORM_FEATURE.ipcCodecs;

type TDetailPreviewManifest = Record<'pages', Array<{
    options: Record<string, unknown>;
    detailRenderPlan?: {
        sourceCrop: {
            xPx: number;
            yPx: number;
            widthPx: number;
            heightPx: number;
        };
        renderRegion: {
            xPx: number;
            yPx: number;
            widthPx: number;
            heightPx: number;
        };
    };
    outputs: Array<{
        outputPath: string;
        metadataPath: string;
    }>;
}>>;

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

function pngWithDimensions(width: number, height: number) {
    const png = PNG.slice();
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return png;
}

// pdftoppm rasterizes the same pixels whichever container it is asked for, so
// the fake renderers write one deterministic pattern in either format.
function rasterPixels(width: number, height: number) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
        pixels[index * 3] = index % 251;
        pixels[index * 3 + 1] = (index * 7) % 253;
        pixels[index * 3 + 2] = (index * 13) % 257 % 256;
    }
    return pixels;
}

function ppmWithDimensions(width: number, height: number) {
    return Buffer.concat([
        Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'),
        rasterPixels(width, height),
    ]);
}

function decodePpm(bytes: Buffer) {
    const match = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(bytes.subarray(0, 64).toString('ascii'));
    if (!match) throw new Error('not a P6 raster');
    const width = Number(match[1]);
    const height = Number(match[2]);
    return {
        width,
        height,
        pixels: bytes.subarray(match[0].length, match[0].length + width * height * 3),
    };
}
const dirs: string[] = [];
const request: IScanCleanupPreviewRequest = {
    ownerId: 'preview-owner',
    documentRevision: 'revision-1',
    requestId: 'preview-request-1',
    sourcePdfPath: '/document.pdf',
    pageNumber: 1,
    options: {
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
    },
};
const detectionRequest: IScanCleanupDetectionRequest = {
    ownerId: request.ownerId,
    documentRevision: request.documentRevision,
    sourcePdfPath: request.sourcePdfPath,
    options: request.options,
};
const documentPrior = {
    dominantLayout: 'two-page-spread' as const,
    cutterRatioMedian: 0.5,
    clusterDims: {
        widthPx: 1,
        heightPx: 1,
    },
    agreementStrength: 0.8,
};

function sender(id = 1) {
    return {
        id,
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
    } satisfies IScanCleanupDetectionSubscriber;
}

// Cancellation is a result rather than a rejection on this service, so a test
// that expects a rendered preview says so once instead of narrowing everywhere.
function previewOf(
    service: IScanCleanupPreviewService,
    subscriber: IScanCleanupDetectionSubscriber,
    previewRequest: IScanCleanupPreviewRequest,
) {
    const pending = (async () => {
        const result = await service.preview(subscriber, previewRequest);
        // Cancellation is reported to the renderer as a result; a test that
        // asked for a rendered preview still wants to see it as the abort it is.
        if (result.canceled === true) throw new DOMException('Canceled scan cleanup preview', 'AbortError');
        return result;
    })();
    // The service holds its own handler on the underlying run, so this derived
    // promise carries one too: a test attaches its assertion a turn later.
    void pending.catch(() => undefined);
    return pending;
}

async function retainedRasterCount(dir: string) {
    const entries = await readdir(dir, {recursive: true});
    return entries.filter(entry => entry.split(sep)[0]?.startsWith('scan-cleanup-rasters-') === true
        && entry.endsWith('.png')).length;
}

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'scan-cleanup-preview-test-'));
    dirs.push(dir);
    return dir;
}

async function waitForRelease(release: Promise<unknown>, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, {once: true});
        void release.then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, reject);
    });
}

// The paper the source pages carry. The request's 5 mm margins are added
// around a cropped content box, so the canvas a matched preview and a matched
// run both place their output on is that paper plus the room those margins can
// ever need.
const DOCUMENT_PAGE_SIZES = [
    1,
    2,
    3,
].map(pageNumber => ({
    pageNumber,
    xPoints: 0,
    yPoints: 0,
    widthPoints: 612,
    heightPoints: 792,
    rotation: 0,
}));
// The rectangle the document actually carries, on the grid a 150 DPI preview
// renders it at. Margins are laid out inside it, so they no longer grow it.
const PREVIEW_DPI = 150;
const DOCUMENT_CANVAS = {
    widthPoints: 612,
    heightPoints: 792,
    widthPx: Math.floor(612 / 72 * PREVIEW_DPI),
    heightPx: Math.floor(792 / 72 * PREVIEW_DPI),
};

function dependencies(dir: string): IScanCleanupPreviewDependencies {
    return {
        getPageCount: vi.fn(async () => 3),
        getPageSizes: vi.fn(async () => DOCUMENT_PAGE_SIZES),
        publishRaster: atomicReplace,
        // pdftoppm names its own output by dropping the extension and adding
        // the format's, so a caller that asks for anything else gets nothing.
        renderPage: vi.fn(async (_paths, _log, _page, _source, outputPath) => {
            await writeFile(`${outputPath.replace(/\.png$/u, '')}.png`, PNG);
        }),
        renderPagePpm: vi.fn(async (_paths, _log, _page, _source, outputPath, _dpi, _env, _signal, crop) => {
            await writeFile(
                `${outputPath.replace(/\.ppm$/u, '')}.ppm`,
                ppmWithDimensions(crop?.width ?? 1, crop?.height ?? 1),
            );
        }),
        runSidecar: vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {outputMode: 'auto' | 'bw' | 'mixed' | 'grayscale' | 'color'};
                outputs: Array<{
                    outputPath: string;
                    metadataPath: string
                }>
            }>};
            const page = manifest.pages[0]!;
            const output = page.outputs[0]!;
            await writeFile(page.pageMetadataPath, JSON.stringify({
                canvasScope: 'page',
                layoutClassification: 'single-uncut-page',
                detectedSkewDegrees: 0.4,
                skewConfidence: 2.4,
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
                recommendedOutputMode: 'mixed',
                recommendedOutputModeConfidence: 0.92,
                recommendedOutputModeReason: 'text-with-pictures',
            }));
            await writeFile(output.outputPath, PNG);
            await writeFile(output.metadataPath, JSON.stringify({
                canvasScope: 'page',
                half: 'full',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                detectedSkewDegrees: 0.4,
                skewConfidence: 2.4,
                skewApplied: true,
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
                contentDiagnostics: {
                    sideConfidence: {
                        left: 0.7,
                        top: 0.6,
                        right: 0.8,
                        bottom: 0.5,
                    },
                    textMask: {
                        analysisWidthPx: 1,
                        analysisHeightPx: 1,
                        inkPixels: 1,
                        lineCount: 1,
                        bounds: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 1,
                            heightPx: 1,
                        },
                    },
                    acceptedTrims: [{
                        side: 'top',
                        iteration: 1,
                        score: 0.9,
                        threshold: 0.4,
                        contentDistanceSum: 90,
                        garbageDistanceSum: 10,
                        removedBlocks: [{
                            bounds: {
                                xPx: 0,
                                yPx: 0,
                                widthPx: 1,
                                heightPx: 1,
                            },
                            pictureMaskOverlapPixels: 0,
                            headingEvidence: false,
                            grayscaleEvidence: false,
                        }],
                    }],
                    protectedBlocks: [{
                        bounds: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 1,
                            heightPx: 1,
                        },
                        pictureMaskOverlapPixels: 1,
                        headingEvidence: true,
                        grayscaleEvidence: false,
                    }],
                },
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                outputWidthPx: 1,
                outputHeightPx: 1,
                canvasWidthPx: 1,
                canvasHeightPx: 1,
                placementOffsetXPx: 0,
                placementOffsetYPx: 0,
                cutterXPx: null,
                inputWidthPx: 1,
                inputHeightPx: 1,
                rotationDegrees: 0,
                resamplePasses: 1,
                outputMode: page.options.outputMode === 'auto' ? 'mixed' : page.options.outputMode,
                illuminationNormalized: true,
                despeckleFallback: true,
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
                inverseTransform: {matrix: [
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
                warnings: [],
            }));
        }),
        resolveBinary: () => '/cleanup',
        resolvePageOpsBinary: () => '/page-ops',
        getTempDir: () => dir,
        getPdftoppmBinary: () => '/pdftoppm',
        materializeWorkingCopy: vi.fn(async sourcePdfPath => ({
            logicalRef: sourcePdfPath,
            physicalWorkingCopyPath: sourcePdfPath,
            sourceFingerprint: '',
        })),
    };
}

async function writeDetectionMetadata(manifestPath: string) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
        pageMetadataPath: string;
        sourcePageIndex: number;
    }>};
    await Promise.all(manifest.pages.map(page => writeFile(page.pageMetadataPath, JSON.stringify({outputs: [{cropRect: {
        xPx: 0,
        yPx: 0,
        widthPx: 100 + page.sourcePageIndex * 10,
        heightPx: 200 + page.sourcePageIndex * 10,
    }}]}))));
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        recursive: true,
        force: true,
    })));
});

describe('scan cleanup preview', () => {
    it('accepts four in-range margins and rejects invalid or incomplete margin shapes', () => {
        const validRequest = {
            ...request,
            options: {
                ...request.options,
                marginsMm: {
                    leftMm: 0,
                    topMm: 6.5,
                    rightMm: 12,
                    bottomMm: 25,
                },
                pageOverrides: {'1': {
                    rotationDegrees: 0,
                    layoutOverride: 'auto',
                    excluded: false,
                    manualSplit: null,
                    marginsMm: {
                        leftMm: 1,
                        topMm: 2,
                        rightMm: 3,
                        bottomMm: 4,
                    },
                }},
            },
        };
        const codec = SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview];
        expect(codec.decodeArgs([validRequest])).toEqual([validRequest]);

        const invalidMargins = [
            {
                leftMm: -1,
                topMm: 2,
                rightMm: 3,
                bottomMm: 4,
            },
            {
                leftMm: 1,
                topMm: Number.NaN,
                rightMm: 3,
                bottomMm: 4,
            },
            {
                leftMm: 1,
                topMm: 2,
                rightMm: 26,
                bottomMm: 4,
            },
            {
                leftMm: 1,
                topMm: 2,
                rightMm: 3,
            },
        ];
        for (const marginsMm of invalidMargins) {
            expect(() => codec.decodeArgs([{
                ...request,
                options: {
                    ...request.options,
                    marginsMm,
                },
            }])).toThrow('invalid scan-cleanup margins');
        }

        const legacyMarginKey = `margin${'Mm'}`;
        const {
            marginsMm: _marginsMm,
            ...optionsWithoutMargins
        } = request.options;
        expect(() => codec.decodeArgs([{
            ...request,
            options: {
                ...optionsWithoutMargins,
                [legacyMarginKey]: 5,
            },
        }])).toThrow('invalid scan-cleanup margins');
    });

    it('round-trips normalized override geometry through the IPC codec', () => {
        const normalizedRequest: IScanCleanupPreviewRequest = {
            ...request,
            outputModeRecommendation: 'bw',
            options: {
                ...request.options,
                pageOverrides: {'2': {
                    rotationDegrees: 270,
                    layoutOverride: 'spread',
                    excluded: false,
                    manualSplit: {
                        xNormalized: 0.375,
                        rotationDegrees: 270,
                    },
                    manualContentBoxes: {right: {
                        xNormalized: 0.04,
                        yNormalized: 0.12,
                        widthNormalized: 0.42,
                        heightNormalized: 0.7,
                        rotationDegrees: 270,
                    }},
                    manualZones: {
                        picture: [{
                            polygon: {
                                points: [
                                    {
                                        xNormalized: 0.1,
                                        yNormalized: 0.2,
                                    },
                                    {
                                        xNormalized: 0.8,
                                        yNormalized: 0.2,
                                    },
                                    {
                                        xNormalized: 0.8,
                                        yNormalized: 0.9,
                                    },
                                ],
                                rotationDegrees: 270,
                            },
                            layer: 'painter2',
                        }],
                        fill: [],
                    },
                }},
            },
        };

        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([normalizedRequest]))
            .toEqual([normalizedRequest]);
    });

    it('validates high-detail viewport requests', () => {
        const detailRequest: IScanCleanupPreviewRequest = {
            ...request,
            detail: {
                viewports: {left: {
                    xNormalized: 0.125,
                    yNormalized: 0.25,
                    widthNormalized: 0.5,
                    heightNormalized: 0.4,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        };

        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([detailRequest]))
            .toEqual([detailRequest]);
        expect(() => SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([{
            ...detailRequest,
            detail: {
                ...detailRequest.detail!,
                viewports: {},
            },
        }])).toThrow('invalid scan-cleanup detail preview request');
        expect(() => SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([{
            ...detailRequest,
            detail: {
                ...detailRequest.detail!,
                viewports: {left: undefined},
            },
        }])).toThrow('invalid scan-cleanup detail preview request');
    });

    it('validates the retained navigation window on a preview cancellation', () => {
        const codec = SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.cancelPreview];
        const cancelRequest = {
            sourcePdfPath: request.sourcePdfPath,
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            invalidateRawCache: false,
            retainPages: [
                199,
                200,
                201,
            ],
        };

        expect(codec.decodeArgs([cancelRequest])).toEqual([cancelRequest]);
        for (const retainPages of [
            [0],
            [1.5],
            ['200'],
            Array.from({length: 17}, (_unused, index) => index + 1),
            'all',
        ]) {
            expect(() => codec.decodeArgs([{
                ...cancelRequest,
                retainPages,
            }])).toThrow('invalid scan-cleanup retained preview pages');
        }
    });

    it('serializes nested reactive page overrides for every IPC request', () => {
        const reactiveOptions = reactive({
            ...request.options,
            outputMode: 'auto' as const,
            pageOverrides: {
                '2': {
                    rotationDegrees: 90 as const,
                    layoutOverride: 'spread' as const,
                    excluded: false,
                    outputModeOverride: 'mixed' as const,
                    manualSplit: {
                        xNormalized: 0.4,
                        rotationDegrees: 90 as const,
                    },
                    manualContentBoxes: {left: {
                        xNormalized: 0.01,
                        yNormalized: 0.02,
                        widthNormalized: 0.32,
                        heightNormalized: 0.54,
                        rotationDegrees: 90 as const,
                    }},
                    placementOverrides: {left: 'bottom-right' as const},
                },
                '3': {
                    rotationDegrees: 0 as const,
                    layoutOverride: 'auto' as const,
                    excluded: false,
                    outputModeOverride: 'color' as const,
                    manualSplit: null,
                },
            },
        });
        const options = toPlainScanCleanupOptions(reactiveOptions);
        const previewRequest = {
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            requestId: request.requestId,
            sourcePdfPath: request.sourcePdfPath,
            pageNumber: request.pageNumber,
            options,
        };
        const startRequest = {
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
            options,
            sourcePageNumbers: [
                1,
                3,
            ],
        };

        expect(() => structuredClone(previewRequest)).not.toThrow();
        expect(() => structuredClone(startRequest)).not.toThrow();
        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([previewRequest]))
            .toEqual([previewRequest]);
        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.cancelPreview].decodeArgs([{
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
            invalidateRawCache: false,
        }])).toEqual([{
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
            invalidateRawCache: false,
        }]);
        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.start].decodeArgs([startRequest]))
            .toEqual([startRequest]);
        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.detectAll].decodeArgs([{
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
            options,
        }])).toEqual([{
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
            options,
        }]);
    });

    it('rejects asymmetric start errors and impossible job progress', () => {
        expect(() => SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.start].decodeResult({
            started: false,
            jobId: 'job-1',
            error: 'failed',
            errorCode: 'untyped-code',
        })).toThrow('typed error');
        expect(() => SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.getJobState].decodeResult({
            jobId: 'job-1',
            status: 'running',
            progress: {
                stage: 'rendering',
                completedUnits: 2,
                totalUnits: 1,
                percent: 50,
            },
            updatedAtMs: Date.now(),
        })).toThrow('invalid scan-cleanup progress');
    });

    it('demand-materializes lazy-original input before scan-cleanup preview', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        vi.mocked(deps.materializeWorkingCopy).mockResolvedValue({
            logicalRef: request.sourcePdfPath,
            physicalWorkingCopyPath: '/managed/document.pdf',
            sourceFingerprint: 'source-fingerprint',
        });

        await previewOf(createScanCleanupPreviewService(deps), sender(), request);

        expect(deps.materializeWorkingCopy).toHaveBeenCalledWith(request.sourcePdfPath, {
            ownerWebContentsId: 1,
            reason: 'scan-cleanup',
            signal: expect.any(AbortSignal),
        });
        expect(deps.renderPage).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Function),
            1,
            '/managed/document.pdf',
            expect.any(String),
            expect.any(Number),
            undefined,
            expect.any(AbortSignal),
        );
    });

    it('cancels preview work whose working copy registration was retired', async () => {
        const previewSender = sender();
        rememberRetiredWorkingCopyOriginal(request.sourcePdfPath, '/original.pdf', previewSender.id);
        try {
            const service = createScanCleanupPreviewService();

            await expect(service.preview(previewSender, request)).resolves.toEqual({canceled: true});
        } finally {
            forgetRetiredWorkingCopyOriginal(request.sourcePdfPath);
        }
    });

    it('reports preview work for a source this owner never held as a failure', async () => {
        const service = createScanCleanupPreviewService();

        // A path nothing registered is not a page the user navigated away from:
        // reporting it as a cancellation would leave the renderer spinning on a
        // request that will never be answered.
        await expect(service.preview(sender(), request)).rejects.toThrow(/not managed by this owner/u);
    });

    it('skips materialization for queued preview work canceled before it dequeues', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalRenderPage = deps.renderPage;
        const firstEntered = Promise.withResolvers<undefined>();
        const releaseFirst = Promise.withResolvers<undefined>();
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            firstEntered.resolve(undefined);
            await waitForRelease(releaseFirst.promise, args[7]!);
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();

        const first = previewOf(service, previewSender, request);
        await firstEntered.promise;
        const queued = previewOf(service, previewSender, {
            ...request,
            pageNumber: 2,
        });
        service.cancel(previewSender, {
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
        });
        releaseFirst.resolve(undefined);

        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        await expect(queued).rejects.toMatchObject({name: 'AbortError'});
        expect(deps.materializeWorkingCopy).toHaveBeenCalledTimes(1);
    });

    it('keeps eager scan-cleanup preview paths unchanged', async () => {
        const dir = await setup();
        const deps = dependencies(dir);

        await previewOf(createScanCleanupPreviewService(deps), sender(), request);

        expect(deps.renderPage).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Function),
            1,
            request.sourcePdfPath,
            expect.any(String),
            expect.any(Number),
            undefined,
            expect.any(AbortSignal),
        );
    });

    it('returns real sidecar bytes and validated metadata', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const runSidecar = deps.runSidecar;
        let previewMatchPageSize: boolean | undefined;
        let previewMode = false;
        let previewDocumentPrior: unknown;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                renderMode?: string;
                pages: Array<{
                    options: {matchPageSize: boolean};
                    documentPrior?: unknown
                }>;
            };
            previewMatchPageSize = manifest.pages[0]?.options.matchPageSize;
            previewMode = manifest.renderMode === 'preview';
            previewDocumentPrior = manifest.pages[0]?.documentPrior;
            await runSidecar(binary, manifestPath, signal, log, onProgress);
        });
        const result = await previewOf(createScanCleanupPreviewService(deps), sender(), {
            ...request,
            documentPrior,
        });
        expect(deps.runSidecar).toHaveBeenCalledOnce();
        expect(previewMatchPageSize).toBe(true);
        expect(previewMode).toBe(true);
        expect(previewDocumentPrior).toEqual(documentPrior);
        expect(decodeScanCleanupPreviewResult(result)).toMatchObject({
            pageNumber: 1,
            totalPages: 3,
            rawWidthPx: 1,
            rawHeightPx: 1,
            outputs: [{metadata: {
                half: 'full',
                skewConfidence: 2.4,
                illuminationNormalized: true,
                despeckleFallback: true,
                contentDiagnostics: {
                    sideConfidence: {left: 0.7},
                    textMask: {lineCount: 1},
                    acceptedTrims: [{
                        side: 'top',
                        iteration: 1,
                        removedBlocks: [{pictureMaskOverlapPixels: 0}],
                    }],
                    protectedBlocks: [{
                        pictureMaskOverlapPixels: 1,
                        headingEvidence: true,
                    }],
                },
            }}],
            pageMetadata: {
                skewConfidence: 2.4,
                recommendedOutputModeReason: 'text-with-pictures',
                outputDiagnostics: [{
                    half: 'full',
                    contentDiagnostics: {
                        sideConfidence: {left: 0.7},
                        acceptedTrims: [{side: 'top'}],
                        protectedBlocks: [{headingEvidence: true}],
                    },
                }],
            },
        });
    });

    it('does not upscale a proven 72-DPI raster document for its base preview', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.getPageSizes = vi.fn(async () => DOCUMENT_PAGE_SIZES.map(page => ({
            ...page,
            dominantImageWidthPx: 612,
            dominantImageHeightPx: 792,
            dominantImageWidthPoints: 612,
            dominantImageHeightPoints: 792,
        })));
        const originalSidecar = deps.runSidecar;
        let manifest: {
            documentCanvas?: {
                widthPx: number;
                heightPx: number
            };
            pages: Array<{options: {
                dpi: number;
                sourceDpi: number;
                requestedRenderDpi: number
            }}>;
        } | null = null;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });

        await previewOf(createScanCleanupPreviewService(deps), sender(), request);

        expect(vi.mocked(deps.renderPage).mock.calls[0]?.[5]).toBe(72);
        expect(manifest).toMatchObject({
            documentCanvas: {
                widthPx: 612,
                heightPx: 792,
            },
            pages: [{options: {
                dpi: 72,
                sourceDpi: 72,
                requestedRenderDpi: 72,
            }}],
        });
    });

    it('bounds a physically oversized scan preview before Poppler rasterizes it', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.getPageSizes = vi.fn(async () => [{
            pageNumber: 1,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 4_676,
            heightPoints: 3_328,
            rotation: 0,
            dominantImageWidthPx: 4_676,
            dominantImageHeightPx: 3_328,
            dominantImageWidthPoints: 4_676,
            dominantImageHeightPoints: 3_328,
        }]);
        const originalSidecar = deps.runSidecar;
        let manifest: {
            documentCanvas?: {
                widthPx: number;
                heightPx: number
            };
            pages: Array<{options: {
                dpi: number;
                sourceDpi: number;
                requestedRenderDpi: number
            }}>;
        } | null = null;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });

        await previewOf(createScanCleanupPreviewService(deps), sender(), request);

        expect(vi.mocked(deps.renderPage).mock.calls[0]?.[5]).toBe(36);
        expect(manifest).toMatchObject({
            documentCanvas: {
                widthPx: 2_338,
                heightPx: 1_664,
            },
            pages: [{options: {
                dpi: 36,
                sourceDpi: 72,
                requestedRenderDpi: 36,
            }}],
        });
        expect(2_338 * 1_664).toBeLessThanOrEqual(4_000_000);
    });

    it('renders only the requested zoom region at true output DPI within the tile budget', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const renderCalls: Array<{
            dpi: number;
            crop?: {
                x: number;
                y: number;
                width: number;
                height: number;
            };
        }> = [];
        deps.detectSourceDpi = vi.fn(async () => 300);
        deps.renderPage = vi.fn(async (
            _paths,
            _log,
            _page,
            _source,
            outputPath,
            dpi,
            _environment,
            _signal,
            crop,
        ) => {
            renderCalls.push({
                dpi,
                ...(crop === undefined ? {} : {crop}),
            });
            await writeFile(outputPath, pngWithDimensions(
                crop?.width ?? Math.round(1_000 * dpi / 150),
                crop?.height ?? Math.round(1_500 * dpi / 150),
            ));
        });
        deps.renderPagePpm = vi.fn(async (
            _paths,
            _log,
            _page,
            _source,
            outputPath,
            dpi,
            _environment,
            _signal,
            crop,
        ) => {
            renderCalls.push({
                dpi,
                ...(crop === undefined ? {} : {crop}),
            });
            await writeFile(outputPath, ppmWithDimensions(
                crop?.width ?? Math.round(1_000 * dpi / 150),
                crop?.height ?? Math.round(1_500 * dpi / 150),
            ));
        });
        const originalSidecar = deps.runSidecar;
        let manifestOptions: Record<string, unknown> | undefined;
        let detailPlan: TDetailPreviewManifest['pages'][number]['detailRenderPlan'];
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TDetailPreviewManifest;
            manifestOptions = manifest.pages[0]?.options;
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
            const output = manifest.pages[0]!.outputs[0]!;
            const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as Record<string, unknown>;
            detailPlan = manifest.pages[0]?.detailRenderPlan;
            if (!detailPlan) {
                await writeFile(output.outputPath, pngWithDimensions(1_000, 1_500));
                await writeFile(output.metadataPath, JSON.stringify({
                    ...metadata,
                    sourceRegion: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 1_000,
                        heightPx: 1_500,
                    },
                    contentBox: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 1_000,
                        heightPx: 1_500,
                    },
                    outputWidthPx: 1_000,
                    outputHeightPx: 1_500,
                    canvasWidthPx: 1_000,
                    canvasHeightPx: 1_500,
                    inputWidthPx: 1_000,
                    inputHeightPx: 1_500,
                }));
                return;
            }
            const region = detailPlan.renderRegion;
            const renderDpi = Number(manifestOptions?.dpi ?? 150);
            const outputWidthPx = Math.round(1_000 * renderDpi / 150);
            const outputHeightPx = Math.round(1_500 * renderDpi / 150);
            await writeFile(output.outputPath, pngWithDimensions(region.widthPx, region.heightPx));
            await writeFile(output.metadataPath, JSON.stringify({
                ...metadata,
                outputWidthPx,
                outputHeightPx,
                canvasWidthPx: outputWidthPx,
                canvasHeightPx: outputHeightPx,
                sourceDpi: 300,
                renderDpi,
                requestedRenderDpi: 300,
                renderRegion: region,
            }));
        });

        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        await previewOf(service, previewSender, request);
        const result = await previewOf(service, previewSender, {
            ...request,
            detail: {
                viewports: {full: {
                    xNormalized: 0.25,
                    yNormalized: 0.2,
                    widthNormalized: 0.5,
                    heightNormalized: 0.45,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        });

        expect(renderCalls).toHaveLength(2);
        expect(renderCalls[0]).toEqual({dpi: 150});
        expect(renderCalls[1]).toMatchObject({
            dpi: 300,
            crop: {
                x: expect.any(Number),
                y: expect.any(Number),
                width: expect.any(Number),
                height: expect.any(Number),
            },
        });
        expect(renderCalls[1]!.crop!.width * renderCalls[1]!.crop!.height)
            .toBeLessThan(4_000 * 6_000);
        expect(result.rawWidthPx * result.rawHeightPx).toBeLessThanOrEqual(4_000_000);
        const detailPng = new DataView(
            result.outputs[0]!.imageData.buffer,
            result.outputs[0]!.imageData.byteOffset,
            result.outputs[0]!.imageData.byteLength,
        );
        expect(detailPng.getUint32(16) * detailPng.getUint32(20)).toBeLessThanOrEqual(4_000_000);
        expect(manifestOptions).toMatchObject({
            sourceDpi: 300,
            dpi: 300,
            requestedRenderDpi: 300,
            outputMode: 'bw',
            matchPageSize: false,
        });
        expect(manifestOptions).not.toHaveProperty('renderCrop');
        expect(detailPlan?.sourceCrop).toEqual({
            xPx: renderCalls[1]!.crop!.x,
            yPx: renderCalls[1]!.crop!.y,
            widthPx: renderCalls[1]!.crop!.width,
            heightPx: renderCalls[1]!.crop!.height,
        });
        expect(detailPlan!.renderRegion.widthPx / 2_000).toBeLessThanOrEqual(0.5);
        expect(detailPlan!.renderRegion.heightPx / 3_000).toBeLessThanOrEqual(0.45);
        expect(
            (detailPlan!.renderRegion.xPx + detailPlan!.renderRegion.widthPx / 2) / 2_000,
        ).toBeCloseTo(0.5, 2);
        expect(
            (detailPlan!.renderRegion.yPx + detailPlan!.renderRegion.heightPx / 2) / 3_000,
        ).toBeCloseTo(0.425, 2);
        expect(result.outputs[0]?.metadata).toMatchObject({
            renderDpi: 300,
            requestedRenderDpi: 300,
            renderRegion: {
                xPx: expect.any(Number),
                yPx: expect.any(Number),
                widthPx: expect.any(Number),
                heightPx: expect.any(Number),
            },
        });

        const budgetedResult = await previewOf(service, previewSender, {
            ...request,
            detail: {
                viewports: {full: {
                    xNormalized: 0,
                    yNormalized: 0,
                    widthNormalized: 1,
                    heightNormalized: 1,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        });
        expect(renderCalls[2]?.dpi).toBe(242);
        expect(manifestOptions).toMatchObject({
            dpi: 242,
            sourceDpi: 300,
            requestedRenderDpi: 300,
        });
        expect(detailPlan?.renderRegion).toEqual({
            xPx: 0,
            yPx: 0,
            widthPx: 1_613,
            heightPx: 2_420,
        });
        expect(budgetedResult.outputs[0]?.metadata).toMatchObject({
            outputWidthPx: 1_613,
            outputHeightPx: 2_420,
            renderDpi: 242,
            requestedRenderDpi: 300,
            renderRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 1_613,
                heightPx: 2_420,
            },
        });

        const mixedFallback = await previewOf(service, previewSender, {
            ...request,
            detail: {
                viewports: {full: {
                    xNormalized: 0.25,
                    yNormalized: 0.2,
                    widthNormalized: 0.5,
                    heightNormalized: 0.45,
                    rotationDegrees: 0,
                }},
                outputMode: 'mixed',
            },
        });
        expect(renderCalls[3]).toEqual({dpi: 204});
        expect(detailPlan).toBeUndefined();
        expect(manifestOptions).toMatchObject({
            dpi: 204,
            sourceDpi: 300,
            requestedRenderDpi: 300,
            outputMode: 'mixed',
        });
        expect(mixedFallback.outputs).toHaveLength(1);
        expect(mixedFallback.outputs[0]?.metadata.renderRegion).toBeUndefined();

        const manualZoneOptions = {
            ...request.options,
            pageOverrides: {'1': {
                rotationDegrees: 0 as const,
                layoutOverride: 'auto' as const,
                excluded: false,
                manualSplit: null,
                manualZones: {
                    picture: [{
                        layer: 'painter2' as const,
                        polygon: {
                            points: [
                                {
                                    xNormalized: 0.25,
                                    yNormalized: 0.25,
                                },
                                {
                                    xNormalized: 0.75,
                                    yNormalized: 0.25,
                                },
                                {
                                    xNormalized: 0.75,
                                    yNormalized: 0.75,
                                },
                            ],
                            rotationDegrees: 0 as const,
                        },
                    }],
                    fill: [],
                },
            }},
        };
        await previewOf(service, previewSender, {
            ...request,
            options: manualZoneOptions,
        });
        const manualZoneFallback = await previewOf(service, previewSender, {
            ...request,
            options: manualZoneOptions,
            detail: {
                viewports: {full: {
                    xNormalized: 0.25,
                    yNormalized: 0.2,
                    widthNormalized: 0.5,
                    heightNormalized: 0.45,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        });
        expect(renderCalls).toHaveLength(4);
        expect(detailPlan).toBeUndefined();
        expect(manifestOptions).toMatchObject({
            dpi: 204,
            outputMode: 'bw',
        });
        expect(manualZoneFallback.outputs[0]?.metadata.renderRegion).toBeUndefined();
    });

    it('accepts unbounded nonnegative skew evidence and rejects invalid values at both metadata boundaries', async () => {
        const dir = await setup();
        const result = await previewOf(createScanCleanupPreviewService(dependencies(dir)), sender(), request);
        expect(decodeScanCleanupPreviewResult(result)).toMatchObject({
            outputs: [{metadata: {skewConfidence: 2.4}}],
            pageMetadata: {skewConfidence: 2.4},
        });

        for (const invalid of [
            -0.01,
            Number.NaN,
            Number.POSITIVE_INFINITY,
        ]) {
            expect(() => decodeScanCleanupPreviewResult({
                ...result,
                outputs: result.outputs.map(output => ({
                    ...output,
                    metadata: {
                        ...output.metadata,
                        skewConfidence: invalid,
                    },
                })),
            })).toThrow('invalid scan-cleanup preview skew confidence');
            expect(() => decodeScanCleanupPreviewResult({
                ...result,
                pageMetadata: {
                    ...result.pageMetadata,
                    skewConfidence: invalid,
                },
            })).toThrow('invalid scan-cleanup preview page skew confidence');
        }
    });

    it('validates additive render-region metadata against the full intrinsic output', async () => {
        const dir = await setup();
        const result = await previewOf(createScanCleanupPreviewService(dependencies(dir)), sender(), request);
        const withRegion = {
            ...result,
            outputs: result.outputs.map(output => ({
                ...output,
                metadata: {
                    ...output.metadata,
                    outputWidthPx: 10,
                    outputHeightPx: 20,
                    canvasWidthPx: 10,
                    canvasHeightPx: 20,
                    renderRegion: {
                        xPx: 2,
                        yPx: 3,
                        widthPx: 4,
                        heightPx: 5,
                    },
                },
            })),
        };

        const decodedWithRegion = decodeScanCleanupPreviewResult(withRegion);
        if (decodedWithRegion.canceled === true) throw new Error('unexpected canceled preview');
        expect(decodedWithRegion.outputs[0]?.metadata.renderRegion)
            .toEqual({
                xPx: 2,
                yPx: 3,
                widthPx: 4,
                heightPx: 5,
            });
        expect(() => decodeScanCleanupPreviewResult({
            ...withRegion,
            outputs: withRegion.outputs.map(output => ({
                ...output,
                metadata: {
                    ...output.metadata,
                    renderRegion: {
                        xPx: 8,
                        yPx: 3,
                        widthPx: 4,
                        heightPx: 5,
                    },
                },
            })),
        })).toThrow('render region');
    });

    it('hands the detail tile to the sidecar through the shared raster handoff', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.detectSourceDpi = vi.fn(async () => 300);
        deps.renderPage = vi.fn(async (_paths, _log, _page, _source, outputPath, dpi, _environment, _signal, crop) => {
            await writeFile(outputPath, pngWithDimensions(
                crop?.width ?? Math.round(1_000 * dpi / 150),
                crop?.height ?? Math.round(1_500 * dpi / 150),
            ));
        });
        const originalSidecar = deps.runSidecar;
        let detailPlan: TDetailPreviewManifest['pages'][number]['detailRenderPlan'];
        let tileInputPath: string | undefined;
        let tileInputBytes: Buffer | undefined;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TDetailPreviewManifest & {pages: Array<{inputPath: string}>;};
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
            const page = manifest.pages[0]!;
            const output = page.outputs[0]!;
            const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as Record<string, unknown>;
            detailPlan = page.detailRenderPlan;
            if (!detailPlan) {
                await writeFile(output.outputPath, pngWithDimensions(1_000, 1_500));
                await writeFile(output.metadataPath, JSON.stringify({
                    ...metadata,
                    sourceRegion: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 1_000,
                        heightPx: 1_500,
                    },
                    contentBox: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 1_000,
                        heightPx: 1_500,
                    },
                    outputWidthPx: 1_000,
                    outputHeightPx: 1_500,
                    canvasWidthPx: 1_000,
                    canvasHeightPx: 1_500,
                    inputWidthPx: 1_000,
                    inputHeightPx: 1_500,
                }));
                return;
            }
            tileInputPath = page.inputPath;
            tileInputBytes = await readFile(page.inputPath);
            const region = detailPlan.renderRegion;
            await writeFile(output.outputPath, pngWithDimensions(region.widthPx, region.heightPx));
            await writeFile(output.metadataPath, JSON.stringify({
                ...metadata,
                outputWidthPx: 2_000,
                outputHeightPx: 3_000,
                canvasWidthPx: 2_000,
                canvasHeightPx: 3_000,
                sourceDpi: 300,
                renderDpi: 300,
                requestedRenderDpi: 300,
                renderRegion: region,
            }));
        });

        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        await previewOf(service, previewSender, request);
        const result = await previewOf(service, previewSender, {
            ...request,
            detail: {
                viewports: {full: {
                    xNormalized: 0.25,
                    yNormalized: 0.2,
                    widthNormalized: 0.5,
                    heightNormalized: 0.45,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        });

        // The tile crop is sidecar input only: it reaches native raw, and the
        // dimensions the render plan carries come from that raw header.
        expect(tileInputPath).toMatch(/\.ppm$/);
        const decoded = decodePpm(tileInputBytes!);
        expect(detailPlan?.sourceCrop).toMatchObject({
            widthPx: decoded.width,
            heightPx: decoded.height,
        });
        expect(decoded.pixels.equals(rasterPixels(decoded.width, decoded.height))).toBe(true);
        expect(vi.mocked(deps.renderPagePpm).mock.calls).toHaveLength(1);
        expect(vi.mocked(deps.renderPagePpm).mock.calls[0]?.[8]).toEqual({
            x: expect.any(Number),
            y: expect.any(Number),
            width: decoded.width,
            height: decoded.height,
        });
        // The base page still renders in the format the renderer displays.
        expect(vi.mocked(deps.renderPage).mock.calls.map(call => call[8])).toEqual([undefined]);
        expect(result.outputs[0]?.metadata.renderRegion).toEqual(detailPlan?.renderRegion);
    });

    it('keeps intrinsic page canvases when the document geometry cannot be read', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.getPageSizes = vi.fn(async () => []);
        const originalSidecar = deps.runSidecar;
        let matchPageSize: boolean | undefined;
        let documentCanvas: unknown;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                documentCanvas?: unknown;
                pages: Array<{options: {matchPageSize: boolean}}>;
            };
            matchPageSize = manifest.pages[0]?.options.matchPageSize;
            documentCanvas = manifest.documentCanvas;
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });

        const result = await previewOf(createScanCleanupPreviewService(deps), sender(), request);

        expect(matchPageSize).toBe(false);
        expect(documentCanvas).toBeUndefined();
        expect(result.outputs[0]?.metadata).toMatchObject({
            canvasWidthPx: 1,
            canvasHeightPx: 1,
        });
    });

    it('presents a classified spread on a half-sheet canvas without forcing an unmeasured cut', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        // A document of spread sheets: every sheet carries two book pages.
        deps.getPageSizes = vi.fn(async () => DOCUMENT_PAGE_SIZES.map(pageSize => ({
            ...pageSize,
            widthPoints: 1_224,
        })));
        const originalSidecar = deps.runSidecar;
        let documentCanvas: unknown;
        let observedPageLayout: unknown;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                documentCanvas?: unknown;
                pages: Array<{options: {layout: string}}>;
            };
            documentCanvas = manifest.documentCanvas;
            observedPageLayout = manifest.pages[0]?.options.layout;
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });
        const service = createScanCleanupPreviewService(deps);

        // Nothing has classified the document yet, so no page is assumed to be
        // cut and the sheet is the page.
        await previewOf(service, sender(), request);
        expect(documentCanvas).toMatchObject({
            widthPoints: 1_224,
            heightPoints: 792,
        });

        // Once the caller knows these are spreads, the frame is the half sheet
        // each output actually carries. The classification is sufficient for
        // document-canvas geometry, but it must not become a destructive
        // force-two-page instruction without the measured cutter evidence.
        await previewOf(service, sender(), {
            ...request,
            pageNumber: 2,
            layoutByPage: {
                '1': 'two-page-spread',
                '2': 'two-page-spread',
                '3': 'two-page-spread',
            },
        });
        expect(documentCanvas).toEqual({
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1_241,
            heightPx: 1_606,
        });
        expect(observedPageLayout).toBe('auto');
    });

    it('reuses the detected output mode for an automatic preview', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalSidecar = deps.runSidecar;
        let outputMode: unknown;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{options: {outputMode: string}}>;};
            outputMode = manifest.pages[0]?.options.outputMode;
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });

        await previewOf(createScanCleanupPreviewService(deps), sender(), {
            ...request,
            options: {
                ...request.options,
                outputMode: 'auto',
            },
            outputModeRecommendation: 'bw',
        });

        expect(outputMode).toBe('bw');
    });

    it('reuses base geometry for detail after detection resolves Auto', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const automaticRequest = {
            ...request,
            requestId: 'recommended-base',
            options: {
                ...request.options,
                outputMode: 'auto' as const,
            },
            outputModeRecommendation: 'color' as const,
        };
        await previewOf(service, previewSender, automaticRequest);
        const {
            outputModeRecommendation: _outputModeRecommendation,
            ...detailBase
        } = automaticRequest;

        await expect(previewOf(service, previewSender, {
            ...detailBase,
            requestId: 'recommended-detail',
            detail: {
                viewports: {full: {
                    xNormalized: 0,
                    yNormalized: 0,
                    widthNormalized: 1,
                    heightNormalized: 1,
                    rotationDegrees: 0,
                }},
                outputMode: 'color',
            },
        })).resolves.toMatchObject({
            pageNumber: 1,
            outputs: [{metadata: {outputMode: 'color'}}],
        });
    });

    it('renders a matched lossless page the final run cannot keep lossless', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        // The document was scanned at two scales, and both pages carry their own
        // raster: matched page size cannot put them on one grid without
        // re-rendering, so the run will render — and so must the preview.
        deps.getPageSizes = vi.fn(async () => [
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 612,
                heightPoints: 792,
                rotation: 0,
            },
            {
                pageNumber: 2,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 306,
                heightPoints: 396,
                rotation: 0,
            },
        ]);
        deps.detectRasterPages = vi.fn(async () => ({
            detected: true,
            pages: new Set([
                1,
                2,
            ]),
        }));
        const originalSidecar = deps.runSidecar;
        const operations: Array<string | undefined> = [];
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {operation?: string};
            operations.push(manifest.operation);
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });
        const losslessRequest = {
            ...request,
            options: {
                ...request.options,
                preserveOriginalQuality: true,
            },
        };

        const result = await previewOf(createScanCleanupPreviewService(deps), sender(), losslessRequest);

        // A cleaned raster, not an analysis-only answer that shows the page as
        // it arrived and calls that the output.
        expect(operations).toEqual(['render']);
        expect(result.outputs[0]?.metadata).toMatchObject({canvasScope: 'page'});
        expect(deps.detectRasterPages).toHaveBeenCalledOnce();
    });

    it('keeps a matched lossless page lossless when the document shares one grid', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.detectRasterPages = vi.fn(async () => ({
            detected: true,
            pages: new Set([
                1,
                2,
                3,
            ]),
        }));
        const originalSidecar = deps.runSidecar;
        const operations: Array<string | undefined> = [];
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {operation?: string};
            operations.push(manifest.operation);
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });

        await previewOf(createScanCleanupPreviewService(deps), sender(), {
            ...request,
            options: {
                ...request.options,
                preserveOriginalQuality: true,
            },
        });

        // Every page of this document is the canvas already, so nothing has to
        // be resampled and the original pixels are what the run will publish.
        expect(operations).toEqual(['analyze']);
    });

    it('uses analysis-only output metadata for the lossless original-page preview', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        let manifestOptions: Record<string, unknown> | null = null;
        let classifyOnly = false;
        deps.runSidecar = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                operation?: string;
                pages: Array<{
                    pageMetadataPath: string;
                    options: Record<string, unknown>;
                }>;
            };
            classifyOnly = manifest.operation === 'analyze';
            manifestOptions = manifest.pages[0]!.options;
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                canvasScope: 'page',
                layoutClassification: 'two-page-spread',
                layoutConfidence: 0.94,
                cutterXPx: 1,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 2,
                outputs: [
                    {
                        half: 'left',
                        sourceRegion: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 120,
                            heightPx: 80,
                        },
                        contentBox: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 120,
                            heightPx: 80,
                        },
                        cropRect: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 120,
                            heightPx: 80,
                        },
                        appliedMargins: {
                            leftPx: 0,
                            topPx: 0,
                            rightPx: 0,
                            bottomPx: 0,
                        },
                        inputWidthPx: 120,
                        inputHeightPx: 80,
                    },
                    {
                        half: 'right',
                        sourceRegion: {
                            xPx: 1,
                            yPx: 0,
                            widthPx: 1,
                            heightPx: 1,
                        },
                        contentBox: null,
                        cropRect: {
                            xPx: 1,
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
                        inputWidthPx: 2,
                        inputHeightPx: 1,
                    },
                ],
            }));
        });

        const result = await previewOf(createScanCleanupPreviewService(deps), sender(), {
            ...request,
            options: {
                ...request.options,
                preserveOriginalQuality: true,
                thickness: 4,
                skipBlankPages: true,
            },
        });

        expect(classifyOnly).toBe(true);
        expect(manifestOptions).toMatchObject({
            outputMode: 'color',
            thickness: 0,
            despeckle: false,
            skipBlankPages: false,
            experimental: {autoDewarp: false},
        });
        // The matched canvas is the document-wide plan at preview DPI, the same
        // rectangle for both halves and for every other page.
        expect(decodeScanCleanupPreviewResult(result)).toMatchObject({outputs: [
            {metadata: {
                half: 'left',
                canvasWidthPx: DOCUMENT_CANVAS.widthPx,
                canvasHeightPx: DOCUMENT_CANVAS.heightPx,
                outputWidthPx: 120,
                outputHeightPx: 80,
                // A lossless run scales the original page objects onto the
                // canvas without resampling them, so the preview presents the
                // content at the size the output page will carry: this half's
                // paper is 120x80 of a 1275x1650 canvas, so its content is
                // scaled by 1275/120 and the sheet is filled rather than the
                // page sitting unscaled in a corner of it.
                matchedCanvasContentWidthPx: 1_275,
                matchedCanvasContentHeightPx: 850,
                resamplePasses: 0,
            }},
            {metadata: {
                half: 'right',
                resamplePasses: 0,
            }},
        ]});
    });

    it('fits a lossless preview whose margins overflow the document rectangle and says so', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.runSidecar = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>;};
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                canvasScope: 'page',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
                outputs: [{
                    half: 'full',
                    // The page's own paper, and content cropped to its ink and
                    // then laid out with a tenth of the page in margins around
                    // it, which asks for more room than the paper has.
                    sourceRegion: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 120,
                        heightPx: 80,
                    },
                    contentBox: null,
                    cropRect: {
                        xPx: -6,
                        yPx: -4,
                        widthPx: 132,
                        heightPx: 88,
                    },
                    appliedMargins: {
                        leftPx: 6,
                        topPx: 4,
                        rightPx: 6,
                        bottomPx: 4,
                    },
                    inputWidthPx: 120,
                    inputHeightPx: 80,
                }],
            }));
        });

        const result = await previewOf(createScanCleanupPreviewService(deps), sender(), {
            ...request,
            options: {
                ...request.options,
                preserveOriginalQuality: true,
            },
        });

        const metadata = decodeScanCleanupPreviewResult(result);
        const output = 'outputs' in metadata ? metadata.outputs[0]!.metadata : null;
        // The page is fitted inside the document rectangle whole, keeping the
        // shape it asked for, rather than having its margins clipped at the
        // edge of the box — the policy the raster path applies to the same
        // overflow, reported the same way.
        expect(output).toMatchObject({
            canvasWidthPx: DOCUMENT_CANVAS.widthPx,
            canvasHeightPx: DOCUMENT_CANVAS.heightPx,
            canvasOverflow: true,
            warnings: [expect.stringContaining('below the document\'s scale')],
        });
        expect(output!.matchedCanvasContentWidthPx).toBe(DOCUMENT_CANVAS.widthPx);
        expect(output!.matchedCanvasContentHeightPx! / output!.matchedCanvasContentWidthPx!)
            .toBeCloseTo(88 / 132, 2);
    });

    it('lets a visible request run beside the adjacent prefetch instead of aborting it', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<undefined>();
        const releasePrefetch = Promise.withResolvers<undefined>();
        const originalRenderPage = deps.renderPage;
        let calls = 0;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            calls += 1;
            if (calls === 1) {
                entered.resolve(undefined);
                await waitForRelease(releasePrefetch.promise, args[7]!);
            }
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const prefetch = previewOf(service, previewSender, {
            ...request,
            pageNumber: 2,
        });
        await entered.promise;
        const visible = previewOf(service, previewSender, {
            ...request,
            options: {
                ...request.options,
                thickness: 1,
            },
        });

        // The visible page does not queue behind the neighbour's raster.
        await expect(visible).resolves.toMatchObject({pageNumber: 1});
        releasePrefetch.resolve(undefined);
        await expect(prefetch).resolves.toMatchObject({pageNumber: 2});
    });

    it('adopts an identical in-flight preview instead of rendering the page a second time', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const originalRenderPage = deps.renderPage;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            entered.resolve(undefined);
            await release.promise;
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const prefetch = previewOf(service, previewSender, {
            ...request,
            pageNumber: 2,
        });
        await entered.promise;
        const navigatedTo = previewOf(service, previewSender, {
            ...request,
            pageNumber: 2,
        });

        release.resolve(undefined);
        await expect(prefetch).resolves.toMatchObject({pageNumber: 2});
        await expect(navigatedTo).resolves.toMatchObject({pageNumber: 2});
        expect(deps.renderPage).toHaveBeenCalledOnce();
        expect(deps.runSidecar).toHaveBeenCalledOnce();
    });

    it('supersedes an in-flight Auto preview when detection resolves another output mode', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<undefined>();
        const originalRenderPage = deps.renderPage;
        let calls = 0;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            calls += 1;
            if (calls === 1) {
                entered.resolve(undefined);
                await waitForRelease(Promise.withResolvers<never>().promise, args[7]!);
                return;
            }
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const stale = previewOf(service, previewSender, {
            ...request,
            options: {
                ...request.options,
                outputMode: 'auto',
            },
            outputModeRecommendation: 'bw',
        });
        await entered.promise;
        const current = previewOf(service, previewSender, {
            ...request,
            options: {
                ...request.options,
                outputMode: 'auto',
            },
            outputModeRecommendation: 'color',
        });

        await expect(stale).rejects.toMatchObject({name: 'AbortError'});
        await expect(current).resolves.toMatchObject({
            pageNumber: 1,
            outputs: [{metadata: {outputMode: 'color'}}],
        });
        expect(deps.renderPage).toHaveBeenCalledTimes(2);
    });

    it('supersedes a stale options generation for the page it is rendering', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<undefined>();
        const originalRenderPage = deps.renderPage;
        let calls = 0;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            calls += 1;
            if (calls === 1) {
                entered.resolve(undefined);
                await waitForRelease(Promise.withResolvers<never>().promise, args[7]!);
                return;
            }
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const stale = previewOf(service, previewSender, request);
        await entered.promise;
        const current = previewOf(service, previewSender, {
            ...request,
            options: {
                ...request.options,
                thickness: 1,
            },
        });

        await expect(stale).rejects.toMatchObject({name: 'AbortError'});
        await expect(current).resolves.toMatchObject({pageNumber: 1});
    });

    it('cancels only the preview pages a navigation no longer wants', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered: Array<Promise<undefined>> = [];
        const enteredPages = new Map<number, PromiseWithResolvers<undefined>>();
        deps.renderPage = vi.fn(async (_paths, _log, pageNumber, _source, _outputPath, _dpi, _env, signal) => {
            enteredPages.get(pageNumber)?.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, signal!);
        });
        for (const pageNumber of [
            1,
            2,
            3,
        ]) {
            const resolvers = Promise.withResolvers<undefined>();
            enteredPages.set(pageNumber, resolvers);
            entered.push(resolvers.promise);
        }
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const pages = [
            1,
            2,
            3,
        ].map(pageNumber => previewOf(service, previewSender, {
            ...request,
            pageNumber,
        }));
        await Promise.all(entered);

        expect(service.cancel(previewSender, {
            ...request,
            invalidateRawCache: false,
            retainPages: [
                2,
                3,
            ],
        })).toBe(true);

        await expect(pages[0]).rejects.toMatchObject({name: 'AbortError'});
        expect(await Promise.race([
            pages[1]!.then(() => 'settled', () => 'settled'),
            Promise.resolve('pending'),
        ])).toBe('pending');
        expect(service.cancel(previewSender, request)).toBe(true);
        await expect(pages[1]).rejects.toMatchObject({name: 'AbortError'});
        await expect(pages[2]).rejects.toMatchObject({name: 'AbortError'});
    });

    it('leaves the raster of a retained navigation alone and retires it on a full cancellation', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<undefined>();
        deps.renderPage = vi.fn(async (_paths, _log, _page, _source, _outputPath, _dpi, _env, signal) => {
            entered.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, signal!);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const raw = previewOf(service, previewSender, {
            ...request,
            visible: true,
        });
        await entered.promise;

        service.cancel(previewSender, {
            ...request,
            invalidateRawCache: false,
            retainPages: [1],
        });
        expect(await Promise.race([
            raw.then(() => 'settled', () => 'settled'),
            Promise.resolve('pending'),
        ])).toBe('pending');

        expect(service.cancel(previewSender, request)).toBe(true);
        await expect(raw).rejects.toMatchObject({name: 'AbortError'});
    });

    it('runs detail tiles in a separate lane that never cancels the visible base preview', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.detectSourceDpi = vi.fn(async () => 300);
        const baseRenderEntered = Promise.withResolvers<undefined>();
        const releaseBaseRender = Promise.withResolvers<undefined>();
        const originalSidecar = deps.runSidecar;
        let sidecarCalls = 0;
        const pendingBaseSignals: AbortSignal[] = [];
        deps.runSidecar = vi.fn(async (...args: Parameters<typeof originalSidecar>) => {
            sidecarCalls += 1;
            if (sidecarCalls === 2) {
                pendingBaseSignals.push(args[2]);
                baseRenderEntered.resolve(undefined);
                await waitForRelease(releaseBaseRender.promise, args[2]);
            }
            await originalSidecar(...args);
        });
        const originalRenderPage = deps.renderPage;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            if (args[5] !== 150) {
                throw new Error('detail lane executed');
            }
            await originalRenderPage(...args);
        });
        deps.renderPagePpm = vi.fn(async () => {
            throw new Error('detail lane executed');
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();

        await previewOf(service, previewSender, request);
        const pendingBase = previewOf(service, previewSender, {
            ...request,
            options: {
                ...request.options,
                thickness: 1,
            },
        });
        await baseRenderEntered.promise;
        const detail = previewOf(service, previewSender, {
            ...request,
            detail: {
                viewports: {full: {
                    xNormalized: 0.25,
                    yNormalized: 0.2,
                    widthNormalized: 0.5,
                    heightNormalized: 0.45,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        });

        await expect(detail).rejects.toThrow('detail lane executed');
        expect(pendingBaseSignals[0]?.aborted).toBe(false);
        releaseBaseRender.resolve(undefined);
        await expect(pendingBase).resolves.toMatchObject({pageNumber: 1});
    });

    it('does not republish an invalidated raw raster after its renderer ignores cancellation', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalRenderPage = deps.renderPage;
        const rasterEntered = Promise.withResolvers<undefined>();
        const releaseRaster = Promise.withResolvers<undefined>();
        let renderCalls = 0;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            renderCalls += 1;
            if (renderCalls === 1) {
                rasterEntered.resolve(undefined);
                await releaseRaster.promise;
            }
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const pending = previewOf(service, previewSender, request);
        await rasterEntered.promise;

        expect(service.cancel(previewSender, request)).toBe(true);
        releaseRaster.resolve(undefined);
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await expect(previewOf(service, previewSender, request)).resolves.toMatchObject({pageNumber: 1});

        expect(deps.renderPage).toHaveBeenCalledTimes(2);
    });

    it('does not republish invalidated base geometry after its sidecar ignores cancellation', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalSidecar = deps.runSidecar;
        const sidecarEntered = Promise.withResolvers<undefined>();
        const releaseSidecar = Promise.withResolvers<undefined>();
        deps.runSidecar = vi.fn(async (...args: Parameters<typeof originalSidecar>) => {
            sidecarEntered.resolve(undefined);
            await releaseSidecar.promise;
            await originalSidecar(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const pending = previewOf(service, previewSender, request);
        await sidecarEntered.promise;

        expect(service.cancel(previewSender, request)).toBe(true);
        releaseSidecar.resolve(undefined);
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await expect(previewOf(service, previewSender, {
            ...request,
            detail: {
                viewports: {full: {
                    xNormalized: 0,
                    yNormalized: 0,
                    widthNormalized: 1,
                    heightNormalized: 1,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        })).rejects.toThrow('detail geometry is unavailable');

        expect(deps.runSidecar).toHaveBeenCalledOnce();
    });

    it('aborts a cleaned request when the same owner moves to another source path', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalRenderPage = deps.renderPage;
        const staleEntered = Promise.withResolvers<undefined>();
        const currentEntered = Promise.withResolvers<undefined>();
        const releaseCurrent = Promise.withResolvers<undefined>();
        const currentSignals: AbortSignal[] = [];
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            const signal = args[7]!;
            if (args[3] === request.sourcePdfPath) {
                staleEntered.resolve(undefined);
                await waitForRelease(Promise.withResolvers<never>().promise, signal);
                return;
            }
            currentSignals.push(signal);
            currentEntered.resolve(undefined);
            await waitForRelease(releaseCurrent.promise, signal);
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const stale = previewOf(service, previewSender, request);
        await staleEntered.promise;
        const currentRequest = {
            ...request,
            sourcePdfPath: '/replacement.pdf',
        };
        const current = previewOf(service, previewSender, currentRequest);
        await currentEntered.promise;

        await expect(stale).rejects.toMatchObject({name: 'AbortError'});
        expect(service.cancel(previewSender, request)).toBe(false);
        expect(currentSignals[0]?.aborted).toBe(false);
        releaseCurrent.resolve(undefined);
        await expect(current).resolves.toMatchObject({pageNumber: 1});
    });

    it('aborts an in-flight request when the same owner moves to another document revision', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalRenderPage = deps.renderPage;
        const staleEntered = Promise.withResolvers<undefined>();
        let renderCalls = 0;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            renderCalls += 1;
            if (renderCalls === 1) {
                staleEntered.resolve(undefined);
                await waitForRelease(Promise.withResolvers<never>().promise, args[7]!);
                return;
            }
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const stale = previewOf(service, previewSender, request);
        await staleEntered.promise;
        const current = previewOf(service, previewSender, {
            ...request,
            documentRevision: 'revision-2',
        });

        await expect(stale).rejects.toMatchObject({name: 'AbortError'});
        await expect(current).resolves.toMatchObject({pageNumber: 1});
    });

    it('reuses the raw page raster across option changes until the dialog session is invalidated', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const service = createScanCleanupPreviewService(deps);

        await previewOf(service, sender(), request);
        service.cancel(sender(), {
            ...request,
            invalidateRawCache: false,
        });
        await previewOf(service, sender(), {
            ...request,
            options: {
                ...request.options,
                thickness: 1,
            },
        });

        expect(deps.renderPage).toHaveBeenCalledOnce();
        expect(deps.runSidecar).toHaveBeenCalledTimes(2);

        service.cancel(sender(), request);
        await previewOf(service, sender(), {
            ...request,
            options: {
                ...request.options,
                thickness: 2,
            },
        });
        expect(deps.renderPage).toHaveBeenCalledTimes(2);
    });

    it('has already published the raw page when cleaned rendering fails', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.runSidecar = vi.fn(async () => {
            throw new Error('invalid cleaned preview');
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();

        await expect(previewOf(service, previewSender, {
            ...request,
            visible: true,
        })).rejects.toThrow('invalid cleaned preview');
        expect(previewSender.send).toHaveBeenCalledWith(
            SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw,
            expect.objectContaining({
                pageNumber: 1,
                totalPages: 3,
                rawWidthPx: 1,
                rawHeightPx: 1,
            }),
        );
        expect(deps.renderPage).toHaveBeenCalledOnce();
    });

    it('invalidates a stale raw raster when the document revision changes', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const service = createScanCleanupPreviewService(deps);

        await previewOf(service, sender(), request);
        await previewOf(service, sender(), {
            ...request,
            documentRevision: 'revision-2',
        });

        expect(deps.renderPage).toHaveBeenCalledTimes(2);
    });

    it('does not cross-cancel previews from two windows on the same document', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalRenderPage = deps.renderPage;
        const firstEntered = Promise.withResolvers<undefined>();
        const secondEntered = Promise.withResolvers<undefined>();
        const releaseSecond = Promise.withResolvers<undefined>();
        let callCount = 0;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            callCount += 1;
            if (callCount === 1) {
                firstEntered.resolve(undefined);
                await new Promise<void>((_resolve, reject) => args[7]?.addEventListener('abort', () => reject(args[7]?.reason), {once: true}));
                return;
            }
            secondEntered.resolve(undefined);
            await releaseSecond.promise;
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const firstSender = sender(1);
        const secondSender = sender(2);
        const first = previewOf(service, firstSender, request);
        await firstEntered.promise;
        const second = previewOf(service, secondSender, {
            ...request,
            ownerId: 'preview-owner-2',
        });
        await secondEntered.promise;

        expect(service.cancel(firstSender, request)).toBe(true);
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        releaseSecond.resolve(undefined);
        await expect(second).resolves.toMatchObject({pageNumber: 1});
    }, 15_000);

    it('rejects oversized encoded image responses at the IPC boundary', () => {
        expect(() => decodeScanCleanupPreviewResult({
            pageNumber: 1,
            totalPages: 1,
            rawWidthPx: 1,
            rawHeightPx: 1,
            rawImageData: PNG,
            outputs: [{
                imageData: new Uint8Array(32 * 1024 * 1024 + 1),
                metadata: {
                    half: 'full',
                    layoutClassification: 'single-uncut-page',
                    layoutConfidence: 0.9,
                    outputWidthPx: 1,
                    outputHeightPx: 1,
                    canvasWidthPx: 1,
                    canvasHeightPx: 1,
                    placementOffsetXPx: 0,
                    placementOffsetYPx: 0,
                },
            }],
        })).toThrow('invalid scan-cleanup preview output image');
    });

    it('rejects layout confidence outside the unit interval at the IPC boundary', async () => {
        const dir = await setup();
        const result = await previewOf(createScanCleanupPreviewService(dependencies(dir)), sender(), request);

        expect(() => decodeScanCleanupPreviewResult({
            ...result,
            outputs: result.outputs.map(output => ({
                ...output,
                metadata: {
                    ...output.metadata,
                    layoutConfidence: 1.1,
                },
            })),
        })).toThrow('invalid scan-cleanup preview layout confidence');
    });

    it('rejects malformed cleanup diagnostic flags at the IPC boundary', async () => {
        const dir = await setup();
        const result = await previewOf(createScanCleanupPreviewService(dependencies(dir)), sender(), request);

        expect(() => decodeScanCleanupPreviewResult({
            ...result,
            outputs: result.outputs.map(output => ({
                ...output,
                metadata: {
                    ...output.metadata,
                    despeckleFallback: 'yes',
                },
            })),
        })).toThrow('invalid scan-cleanup preview metadata');

        expect(() => decodeScanCleanupPreviewResult({
            ...result,
            outputs: result.outputs.map(output => ({
                ...output,
                metadata: {
                    ...output.metadata,
                    contentDiagnostics: {
                        sideConfidence: {
                            left: 1.2,
                            top: 0,
                            right: 0,
                            bottom: 0,
                        },
                        textMask: {
                            analysisWidthPx: 1,
                            analysisHeightPx: 1,
                            inkPixels: 0,
                            lineCount: 0,
                        },
                    },
                },
            })),
        })).toThrow('invalid scan-cleanup preview content left confidence');
    });

    it('requires named finite applied margins at the IPC boundary', async () => {
        const dir = await setup();
        const result = await previewOf(createScanCleanupPreviewService(dependencies(dir)), sender(), request);
        const withMargins = (appliedMargins: unknown) => ({
            ...result,
            outputs: result.outputs.map(output => ({
                ...output,
                metadata: {
                    ...output.metadata,
                    appliedMargins,
                },
            })),
        });

        expect(() => decodeScanCleanupPreviewResult(withMargins([
            1,
            2,
            3,
            4,
        ]))).toThrow('invalid scan-cleanup preview metadata');
        expect(() => decodeScanCleanupPreviewResult(withMargins({
            leftPx: Number.NaN,
            topPx: 2,
            rightPx: 3,
            bottomPx: 4,
        }))).toThrow('invalid scan-cleanup preview applied left margin');
    });

    it('accepts optional detection text-axis and recommendation reasons and rejects malformed values', () => {
        const state = {
            jobId: 'detect-axis',
            status: 'completed',
            progress: {
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 1,
                percent: 100,
                completedPageNumbers: [1],
            },
            results: [{
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
                cutterXPx: null,
                tier1Verdict: 'single-uncut-page',
                reconciled: false,
                clusterAgreement: 0,
                documentPrior: null,
                textAxis: {
                    sideways: true,
                    confidence: 0.98,
                },
                recommendedOutputModeReason: 'blank',
                sourcePageMetadata: {
                    pageNumber: 1,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 612,
                    heightPoints: 792,
                    rotation: 0,
                    sourceDpi: 300,
                    dominantImageWidthPx: 2_550,
                    dominantImageHeightPx: 3_300,
                    dominantImageWidthPoints: 612,
                    dominantImageHeightPoints: 792,
                },
            }],
            updatedAtMs: Date.now(),
        };
        expect(decodeScanCleanupDetectionJobState(state)?.results[0]?.textAxis).toEqual({
            sideways: true,
            confidence: 0.98,
        });
        expect(decodeScanCleanupDetectionJobState(state)?.results[0]?.recommendedOutputModeReason).toBe('blank');
        expect(decodeScanCleanupDetectionJobState(state)?.results[0]?.sourcePageMetadata).toEqual(
            state.results[0]!.sourcePageMetadata,
        );

        const withoutAxis = structuredClone(state);
        delete (withoutAxis.results[0] as {textAxis?: unknown}).textAxis;
        expect(decodeScanCleanupDetectionJobState(withoutAxis)?.results[0]).not.toHaveProperty('textAxis');

        const malformed = structuredClone(state);
        malformed.results[0]!.textAxis.confidence = Number.NaN;
        expect(() => decodeScanCleanupDetectionJobState(malformed)).toThrow('detection result');

        const malformedReason = structuredClone(state);
        malformedReason.results[0]!.recommendedOutputModeReason = 'empty';
        expect(() => decodeScanCleanupDetectionJobState(malformedReason)).toThrow('detection result');

        const mismatchedMetadata = structuredClone(state);
        mismatchedMetadata.results[0]!.sourcePageMetadata.pageNumber = 2;
        expect(() => decodeScanCleanupDetectionJobState(mismatchedMetadata)).toThrow(
            'detection source page metadata',
        );
    });

    it('publishes provisional page results before document reconciliation completes', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalRenderPage = deps.renderPage;
        const remainingRasters = Promise.withResolvers<undefined>();
        deps.renderPage = vi.fn(async (...args) => {
            if (args[2] > 1) await remainingRasters.promise;
            await originalRenderPage(
                args[0],
                args[1],
                args[2],
                args[3],
                args[4],
                args[5],
                args[6],
                args[7],
            );
        });
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        const analysisEntered = Promise.withResolvers<undefined>();
        const remainingAnalysis = Promise.withResolvers<undefined>();
        const reconciliationEntered = Promise.withResolvers<undefined>();
        const finishReconciliation = Promise.withResolvers<undefined>();
        deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            await writeDetectionMetadata(manifestPath);
            onProgress({
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 3,
                percent: 100 / 3,
                completedPageNumbers: [1],
            }, {
                stage: 'page-analyzed',
                completedPages: 1,
                totalPages: 3,
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.8,
                reconciled: false,
            });
            analysisEntered.resolve(undefined);
            await remainingAnalysis.promise;
            for (const pageNumber of [
                2,
                3,
            ]) {
                onProgress({
                    stage: 'detecting',
                    completedUnits: pageNumber,
                    totalUnits: 3,
                    percent: pageNumber / 3 * 100,
                    completedPageNumbers: Array.from({length: pageNumber}, (_, index) => index + 1),
                }, {
                    stage: 'page-analyzed',
                    completedPages: pageNumber,
                    totalPages: 3,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.8,
                    reconciled: false,
                });
            }
            for (const pageNumber of [
                1,
                2,
                3,
            ]) {
                onProgress({
                    stage: 'rendering',
                    completedUnits: pageNumber,
                    totalUnits: 3,
                    percent: pageNumber / 3 * 100,
                    completedPageNumbers: [
                        1,
                        2,
                        3,
                    ],
                }, {
                    stage: 'page-complete',
                    completedPages: pageNumber,
                    totalPages: 3,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
            reconciliationEntered.resolve(undefined);
            await finishReconciliation.promise;
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const started = await service.detectAll(owner, detectionRequest);
        service.subscribeDetectionJob(owner, started.jobId, detectionRequest);

        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.progress).toMatchObject({
            stage: 'rasterizing',
            completedUnits: 1,
            totalUnits: 3,
        }));
        expect(service.getDetectionJobState(owner, started.jobId, detectionRequest)?.results).toEqual([]);

        remainingRasters.resolve(undefined);
        await analysisEntered.promise;
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.progress).toMatchObject({
            stage: 'detecting',
            completedUnits: 1,
            totalUnits: 3,
        }));
        const analyzing = service.getDetectionJobState(owner, started.jobId, detectionRequest);
        expect(analyzing?.results).toEqual([expect.objectContaining({
            pageNumber: 1,
            classification: 'single-uncut-page',
            confidence: 0.8,
            reconciled: false,
        })]);
        expect(decodeScanCleanupDetectionJobState(analyzing)).toEqual(analyzing);

        remainingAnalysis.resolve(undefined);
        await reconciliationEntered.promise;
        await vi.waitFor(() => expect(owner.send.mock.calls
            .filter(([channel]) => channel
                === SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState)
            .map(([
                _channel,
                state,
            ]) => decodeScanCleanupDetectionJobState(state))
            .flatMap(state => state?.results ?? [])
            .filter(result => result.pageNumber === 1)
            .map(result => result.confidence)).toContain(0.9));
        finishReconciliation.resolve(undefined);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.status).toBe('completed'));
        expect(service.getDetectionJobState(owner, started.jobId, detectionRequest)).toMatchObject({
            progress: {
                stage: 'detecting',
                completedUnits: 3,
                totalUnits: 3,
            },
            results: [
                {pageNumber: 1},
                {pageNumber: 2},
                {pageNumber: 3},
            ],
        });
        const streamedPageOneRevisions = owner.send.mock.calls
            .filter(([channel]) => channel
                === SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState)
            .map(([
                _channel,
                state,
            ]) => decodeScanCleanupDetectionJobState(state))
            .flatMap(state => state?.results ?? [])
            .filter(result => result.pageNumber === 1)
            .map(result => result.confidence);
        expect(streamedPageOneRevisions).toContain(0.9);
    });

    it.runIf(process.platform !== 'win32')('starts detection before the remaining document rasters finish', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const firstRasterStarted = Promise.withResolvers<undefined>();
        const remainingRasters = Promise.withResolvers<undefined>();
        let activeRasterizers = 0;
        let peakActiveRasterizers = 0;
        deps.createRasterPipes = vi.fn(async () => undefined);
        deps.renderPagePpm = vi.fn(async (_paths, _log, pageNumber) => {
            activeRasterizers += 1;
            peakActiveRasterizers = Math.max(peakActiveRasterizers, activeRasterizers);
            try {
                if (pageNumber === 1) {
                    firstRasterStarted.resolve(undefined);
                    return;
                }
                await remainingRasters.promise;
            } finally {
                activeRasterizers -= 1;
            }
        });
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            await firstRasterStarted.promise;
            await writeDetectionMetadata(manifestPath);
            onProgress({
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 3,
                percent: 100 / 3,
                completedPageNumbers: [1],
            }, {
                stage: 'page-analyzed',
                completedPages: 1,
                totalPages: 3,
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.8,
                reconciled: false,
            });
            await remainingRasters.promise;
            for (const pageNumber of [
                2,
                3,
            ]) {
                onProgress({
                    stage: 'detecting',
                    completedUnits: pageNumber,
                    totalUnits: 3,
                    percent: pageNumber / 3 * 100,
                    completedPageNumbers: Array.from({length: pageNumber}, (_, index) => index + 1),
                }, {
                    stage: 'page-analyzed',
                    completedPages: pageNumber,
                    totalPages: 3,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.8,
                    reconciled: false,
                });
            }
            for (const pageNumber of [
                1,
                2,
                3,
            ]) {
                onProgress({
                    stage: 'detecting',
                    completedUnits: pageNumber,
                    totalUnits: 3,
                    percent: pageNumber / 3 * 100,
                    completedPageNumbers: Array.from({length: pageNumber}, (_, index) => index + 1),
                }, {
                    stage: 'page-complete',
                    completedPages: pageNumber,
                    totalPages: 3,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const started = await service.detectAll(owner, detectionRequest);

        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.results).toEqual([expect.objectContaining({pageNumber: 1})]));
        expect(deps.createRasterPipes).toHaveBeenCalledOnce();
        expect(peakActiveRasterizers).toBe(1);
        expect(deps.renderPage).not.toHaveBeenCalled();

        remainingRasters.resolve(undefined);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.status).toBe('completed'));
    });

    it('reconciles every detection classification against the whole document, not a window of it', async () => {
        const dir = await setup();
        const totalPages = 8;
        const deps = dependencies(dir);
        deps.getPageCount = vi.fn(async () => totalPages);
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        // Stands in for reconcile_classification_batch: the cluster consensus a
        // page is judged against, and the cutter the sidecar then publishes, are
        // derived from the pages that share its manifest.
        deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                sourcePageIndex: number;
                pageMetadataPath: string;
            }>};
            await writeDetectionMetadata(manifestPath);
            const reconciledPages = manifest.pages.map(page => page.sourcePageIndex + 1);
            const clusterAgreement = reconciledPages.length / totalPages;
            const cutterXPx = Math.max(...reconciledPages);
            for (const [
                index,
                pageNumber,
            ] of reconciledPages.entries()) {
                onProgress({
                    stage: 'detecting',
                    completedUnits: index + 1,
                    totalUnits: reconciledPages.length,
                    percent: (index + 1) / reconciledPages.length * 100,
                    completedPageNumbers: reconciledPages.slice(0, index + 1),
                }, {
                    stage: 'page-complete',
                    completedPages: index + 1,
                    totalPages: reconciledPages.length,
                    pageNumber,
                    classification: 'two-page-spread',
                    confidence: 0.9,
                    cutterXPx,
                    clusterAgreement,
                    documentPrior: {
                        ...documentPrior,
                        agreementStrength: clusterAgreement,
                    },
                });
            }
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const started = await service.detectAll(owner, detectionRequest);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.status).toBe('completed'));

        const results = service.getDetectionJobState(owner, started.jobId, detectionRequest)?.results ?? [];
        expect(results.map(result => result.pageNumber)).toEqual(Array.from(
            {length: totalPages},
            (_value, index) => index + 1,
        ));
        expect([...new Set(results.map(result => result.clusterAgreement))]).toEqual([1]);
        expect([...new Set(results.map(result => result.cutterXPx))]).toEqual([totalPages]);
        expect([...new Set(results.map(result => result.documentPrior?.agreementStrength))]).toEqual([1]);
    });

    it('rasterizes detection pages straight to disk instead of buffering them', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        deps.renderPage = vi.fn(async (_paths, _log, _page, _source, outputPath) => {
            await writeFile(outputPath, pngWithDimensions(883, 1335));
            // Sparse padding well past what the preview path is willing to hold
            // in memory: detection must never read a rendered page back.
            await truncate(outputPath, 48 * 1024 * 1024);
        });
        deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            await writeDetectionMetadata(manifestPath);
            for (const pageNumber of [
                1,
                2,
                3,
            ]) {
                onProgress({
                    stage: 'detecting',
                    completedUnits: pageNumber,
                    totalUnits: 3,
                    percent: pageNumber / 3 * 100,
                    completedPageNumbers: Array.from({length: pageNumber}, (_, index) => index + 1),
                }, {
                    stage: 'page-complete',
                    completedPages: pageNumber,
                    totalPages: 3,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const started = await service.detectAll(owner, detectionRequest);

        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.status).toBe('completed'));
        expect(service.getDetectionJobState(owner, started.jobId, detectionRequest)?.results).toHaveLength(3);
    });

    it('previews a page detection rasterized without a renderer and without a second page count', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            await writeDetectionMetadata(manifestPath);
            for (const pageNumber of [
                1,
                2,
                3,
            ]) {
                onProgress({
                    stage: 'detecting',
                    completedUnits: pageNumber,
                    totalUnits: 3,
                    percent: pageNumber / 3 * 100,
                    completedPageNumbers: Array.from({length: pageNumber}, (_, index) => index + 1),
                }, {
                    stage: 'page-complete',
                    completedPages: pageNumber,
                    totalPages: 3,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const started = await service.detectAll(owner, detectionRequest);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.status).toBe('completed'));
        expect(deps.renderPage).toHaveBeenCalledTimes(3);
        expect(deps.getPageCount).toHaveBeenCalledOnce();

        const pageRequest = (pageNumber: number, documentRevision = request.documentRevision) => ({
            ...request,
            documentRevision,
            pageNumber,
        });
        for (const pageNumber of [
            1,
            2,
            3,
        ]) {
            await expect(previewOf(service, sender(), pageRequest(pageNumber))).resolves.toMatchObject({
                pageNumber,
                totalPages: 3,
                rawWidthPx: 1,
                rawHeightPx: 1,
            });
        }
        // Detection keeps a cheaper 100-DPI cache. Each 150-DPI visible
        // preview is rendered once rather than silently displaying the lower
        // resolution analysis raster.
        expect(deps.renderPage).toHaveBeenCalledTimes(6);
        expect(deps.getPageCount).toHaveBeenCalledOnce();

        await previewOf(service, sender(), pageRequest(1, 'revision-2'));
        expect(deps.renderPage).toHaveBeenCalledTimes(7);
        expect(deps.getPageCount).toHaveBeenCalledTimes(2);

        service.cancel(sender(), {
            ...request,
            documentRevision: 'revision-2',
        });
        await vi.waitFor(async () => expect(await retainedRasterCount(dir)).toBe(0));
    });

    it('streams a brokered detect-all lifecycle and hands its rasters to later preview requests', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalSidecar = deps.runSidecar;
        const originalRenderPage = deps.renderPage;
        const rasterGate = Promise.withResolvers<undefined>();
        let detectionRastersEntered = 0;
        let activeRasters = 0;
        let peakRasters = 0;
        deps.renderPage = vi.fn(async (...args) => {
            activeRasters += 1;
            peakRasters = Math.max(peakRasters, activeRasters);
            try {
                if (args[2] > 1) {
                    detectionRastersEntered += 1;
                    if (detectionRastersEntered === 2) {
                        rasterGate.resolve(undefined);
                    }
                    await rasterGate.promise;
                }
                await originalRenderPage(
                    args[0],
                    args[1],
                    args[2],
                    args[3],
                    args[4],
                    args[5],
                    args[6],
                    args[7],
                );
            } finally {
                activeRasters -= 1;
            }
        });
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                operation?: string;
                analysisPurpose?: string;
                pages: Array<{
                    sourcePageIndex: number;
                    options: {
                        dpi: number;
                        layout: string
                    };
                    outputs?: unknown;
                }>;
            };
            if (manifest.operation !== 'analyze') {
                await originalSidecar(binary, manifestPath, signal, log, onProgress);
                return;
            }
            await writeDetectionMetadata(manifestPath);
            expect(manifest.analysisPurpose).toBe('classification');
            expect(manifest.pages.every(page => page.options.dpi === 100)).toBe(true);
            expect(manifest.pages.every(page => Array.isArray(page.outputs) && page.outputs.length === 0)).toBe(true);
            expect(manifest.pages[1]?.options.layout).toBe('force-two-page');
            for (const page of manifest.pages) {
                const spread = page.sourcePageIndex <= 1;
                const nativeProgress = {
                    stage: 'page-complete',
                    completedPages: page.sourcePageIndex + 1,
                    pageNumber: page.sourcePageIndex + 1,
                    totalPages: manifest.pages.length,
                    classification: spread ? 'two-page-spread' : 'single-uncut-page',
                    confidence: page.sourcePageIndex === 0 ? 0.86 : page.sourcePageIndex === 1 ? 1 : 0.95,
                    ...(spread ? {cutterXPx: 0.5} : {}),
                    tier1Verdict: page.sourcePageIndex === 0
                        ? 'single-uncut-page'
                        : spread ? 'two-page-spread' : 'single-uncut-page',
                    reconciled: page.sourcePageIndex === 0,
                    clusterAgreement: page.sourcePageIndex === 1 ? 0 : 0.8,
                    ...(page.sourcePageIndex === 1 ? {} : {documentPrior}),
                    ...(page.sourcePageIndex === 0 ? {textAxis: {
                        sideways: true,
                        confidence: 0.98,
                    }} : {}),
                } as const;
                onProgress({
                    stage: 'detecting',
                    completedUnits: nativeProgress.completedPages,
                    totalUnits: nativeProgress.totalPages,
                    percent: nativeProgress.completedPages / nativeProgress.totalPages * 100,
                    completedPageNumbers: Array.from({length: nativeProgress.completedPages}, (_, index) => index + 1),
                }, nativeProgress);
            }
        });
        const service = createScanCleanupPreviewService(deps);
        await previewOf(service, sender(), request);
        const started = await service.detectAll(sender(), {
            ...detectionRequest,
            options: {
                ...detectionRequest.options,
                pageOverrides: {'2': {
                    rotationDegrees: 0,
                    layoutOverride: 'spread',
                    excluded: false,
                    manualSplit: null,
                }},
            },
        });
        await vi.waitFor(() => expect(service.getDetectionJobState(sender(), started.jobId, request)?.status).toBe('completed'));

        const state = service.getDetectionJobState(sender(), started.jobId, request);
        expect(decodeScanCleanupDetectionJobState(state)).toEqual(state);
        expect(state).toMatchObject({
            status: 'completed',
            progress: {
                stage: 'detecting',
                completedUnits: 3,
                totalUnits: 3,
                percent: 100,
                completedPageNumbers: [
                    1,
                    2,
                    3,
                ],
            },
            results: [
                {
                    pageNumber: 1,
                    classification: 'two-page-spread',
                    confidence: 0.86,
                    cutterXPx: 0.5,
                    tier1Verdict: 'single-uncut-page',
                    reconciled: true,
                    clusterAgreement: 0.8,
                    documentPrior,
                    textAxis: {
                        sideways: true,
                        confidence: 0.98,
                    },
                },
                {
                    pageNumber: 2,
                    classification: 'two-page-spread',
                    confidence: 1,
                    cutterXPx: 0.5,
                    tier1Verdict: 'two-page-spread',
                    reconciled: false,
                    clusterAgreement: 0,
                    documentPrior: null,
                },
                {
                    pageNumber: 3,
                    classification: 'single-uncut-page',
                    confidence: 0.95,
                    cutterXPx: null,
                    tier1Verdict: 'single-uncut-page',
                    reconciled: false,
                    clusterAgreement: 0.8,
                    documentPrior,
                },
            ],
        });
        expect(deps.acquireDetectionLease).toHaveBeenCalledWith(started.jobId, expect.any(AbortSignal));
        // The visible preview keeps its 150-DPI raster; detection renders its
        // three cheaper 100-DPI analysis rasters independently.
        expect(deps.renderPage).toHaveBeenCalledTimes(4);
        expect(peakRasters).toBe(3);

        await previewOf(service, sender(), {
            ...request,
            pageNumber: 2,
        });
        await previewOf(service, sender(), request);
        expect(deps.renderPage).toHaveBeenCalledTimes(5);
    });

    it('rasterizes detection pages as wide as the 11-core host allows and leases that width', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const acquire = vi.spyOn(mainJobBroker, 'acquire');
        deps.getPageCount = vi.fn(async () => 8);
        const originalRenderPage = deps.renderPage;
        let activeRasters = 0;
        let peakRasters = 0;
        deps.renderPage = vi.fn(async (...args) => {
            activeRasters += 1;
            peakRasters = Math.max(peakRasters, activeRasters);
            try {
                await new Promise(resolve => setTimeout(resolve, 5));
                await originalRenderPage(
                    args[0],
                    args[1],
                    args[2],
                    args[3],
                    args[4],
                    args[5],
                    args[6],
                    args[7],
                );
            } finally {
                activeRasters -= 1;
            }
        });
        deps.runSidecar = vi.fn(async () => {
            throw new Error('detection stopped once every page was rasterized');
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const started = await service.detectAll(owner, detectionRequest);

        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.status).toBe('failed'));
        expect(deps.renderPage).toHaveBeenCalledTimes(8);
        expect(peakRasters).toBe(4);
        expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'scan-cleanup-detect-all',
            resources: expect.objectContaining({nativeProcesses: peakRasters}),
        }));
        acquire.mockRestore();
    });

    it('presents one document canvas before, during and after detection', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const analysis = Promise.withResolvers<undefined>();
        const previewCanvases: unknown[] = [];
        const originalSidecar = deps.runSidecar;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                documentCanvas?: unknown;
                pages: unknown[];
            };
            // The detect-all manifest reads every page at once; anything else
            // is a preview of the page the user is looking at.
            if (manifest.pages.length > 1) {
                await waitForRelease(analysis.promise, signal);
                await writeDetectionMetadata(manifestPath);
                for (const pageNumber of [
                    1,
                    2,
                    3,
                ]) {
                    onProgress({
                        stage: 'detecting',
                        completedUnits: pageNumber,
                        totalUnits: 3,
                        percent: pageNumber / 3 * 100,
                        completedPageNumbers: Array.from({length: pageNumber}, (_value, index) => index + 1),
                    }, {
                        stage: 'page-complete',
                        completedPages: pageNumber,
                        totalPages: 3,
                        pageNumber,
                        classification: 'single-uncut-page',
                        confidence: 0.9,
                    });
                }
                return;
            }
            previewCanvases.push(manifest.documentCanvas);
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const matched = {
            ...request,
            options: {
                ...request.options,
                matchPageSize: true,
            },
        };

        // Before any detection has been asked for.
        await previewOf(service, owner, matched);
        const started = await service.detectAll(owner, {
            ...detectionRequest,
            options: matched.options,
        });
        await vi.waitFor(() => expect(
            service.getDetectionJobState(owner, started.jobId, detectionRequest)?.status,
        ).toBe('running'));
        // While the job is still reading the scan.
        await previewOf(service, owner, {
            ...matched,
            pageNumber: 2,
        });
        analysis.resolve(undefined);
        await vi.waitFor(() => expect(
            service.getDetectionJobState(owner, started.jobId, detectionRequest)?.status,
        ).toBe('completed'));
        // And once it has measured every content crop.
        await previewOf(service, owner, {
            ...matched,
            pageNumber: 3,
        });

        expect(previewCanvases).toEqual([
            DOCUMENT_CANVAS,
            DOCUMENT_CANVAS,
            DOCUMENT_CANVAS,
        ]);
        expect(deps.getPageSizes).toHaveBeenCalledOnce();
    });

    it('leaves every page its own crop when page sizes are not matched', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const previewCanvases: unknown[] = [];
        const originalSidecar = deps.runSidecar;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {documentCanvas?: unknown};
            previewCanvases.push(manifest.documentCanvas);
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();

        await previewOf(service, owner, {
            ...request,
            options: {
                ...request.options,
                matchPageSize: false,
            },
        });

        expect(previewCanvases).toEqual([undefined]);
        expect(deps.getPageSizes).toHaveBeenCalledOnce();
    });

    it('previews without matching when it cannot measure, and measures again next time', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        let measurements = 0;
        deps.getPageSizes = vi.fn(async () => {
            measurements += 1;
            if (measurements === 1) throw new Error('evb-pdf-page-ops is unavailable');
            return DOCUMENT_PAGE_SIZES;
        });
        const canvases: unknown[] = [];
        const matched: Array<boolean | undefined> = [];
        const originalSidecar = deps.runSidecar;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                documentCanvas?: unknown;
                pages: Array<{options: {matchPageSize: boolean}}>;
            };
            canvases.push(manifest.documentCanvas);
            matched.push(manifest.pages[0]?.options.matchPageSize);
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();

        // Geometry is what matching needs and the only thing that needs it, so
        // a document nothing can measure is still cleaned and previewed — with
        // matching off for the request and the page saying so, rather than the
        // whole preview failing over page sizes.
        const unmatched = await previewOf(service, owner, request);

        expect(unmatched.pageNumber).toBe(1);
        expect(matched).toEqual([false]);
        expect(canvases).toEqual([undefined]);
        expect(unmatched.outputs[0]?.metadata.warnings.some(warning => /Matched page size is off/u.test(warning)))
            .toBe(true);

        // The failure is not remembered: it was the measurement's, not the
        // document's, so the next request measures again and matches.
        const recovered = await previewOf(service, owner, request);

        expect(recovered.pageNumber).toBe(1);
        expect(canvases).toEqual([
            undefined,
            DOCUMENT_CANVAS,
        ]);
        expect(matched).toEqual([
            false,
            true,
        ]);
        expect(recovered.outputs[0]?.metadata.warnings.some(warning => /Matched page size is off/u.test(warning)))
            .toBe(false);
        expect(measurements).toBe(2);
    });

    it('measures under the document rather than under the request that asked first', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const measuring = Promise.withResolvers<undefined>();
        const releaseMeasurement = Promise.withResolvers<undefined>();
        let measurementSignal: AbortSignal | undefined;
        deps.getPageSizes = vi.fn(async (_path, measureOptions) => {
            measurementSignal = measureOptions?.signal;
            measuring.resolve(undefined);
            await releaseMeasurement.promise;
            return DOCUMENT_PAGE_SIZES;
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const documentRequest = {
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
        };

        const pending = previewOf(service, owner, {
            ...request,
            visible: true,
        });
        await measuring.promise;
        // The caller goes away; the shared measurement does not, because it is
        // the document's work rather than this request's.
        service.cancel(owner, {
            ...documentRequest,
            invalidateRawCache: false,
            retainPages: [],
        });
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(measurementSignal?.aborted).toBe(false);

        // Closing the document is what stops it, for everyone at once, without
        // any one caller having had to own the cancellation.
        service.cancel(owner, documentRequest);
        expect(measurementSignal?.aborted).toBe(true);
        releaseMeasurement.resolve(undefined);
    });

    it.each([
        {
            label: 'raster',
            lossless: false,
        },
        {
            label: 'lossless',
            lossless: true,
        },
    ])('uses one cache-order-independent document canvas for $label previews', async ({lossless}) => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.getPageCount = vi.fn(async () => 2);
        const originalSidecar = deps.runSidecar;
        const previewManifests: Array<{
            canvasScope: string;
            documentCanvas?: unknown
        }> = [];
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                operation: string;
                canvasScope: string;
                documentCanvas?: {
                    widthPoints: number;
                    heightPoints: number
                };
                pages: Array<{
                    sourcePageIndex: number;
                    pageMetadataPath: string;
                    outputs: Array<{
                        outputPath: string;
                        metadataPath: string
                    }>;
                }>;
            };
            if (manifest.pages.length === 2) {
                for (const page of manifest.pages) {
                    const pageNumber = page.sourcePageIndex + 1;
                    await writeFile(page.pageMetadataPath, JSON.stringify({outputs: [{cropRect: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: pageNumber === 1 ? 60 : 100,
                        heightPx: pageNumber === 1 ? 120 : 140,
                    }}]}));
                    onProgress({
                        stage: 'detecting',
                        completedUnits: pageNumber,
                        totalUnits: 2,
                        percent: pageNumber * 50,
                        completedPageNumbers: Array.from({length: pageNumber}, (_value, index) => index + 1),
                    }, {
                        stage: 'page-complete',
                        completedPages: pageNumber,
                        totalPages: 2,
                        pageNumber,
                        classification: 'single-uncut-page',
                        confidence: 0.9,
                    });
                }
                return;
            }
            previewManifests.push({
                canvasScope: manifest.canvasScope,
                documentCanvas: manifest.documentCanvas,
            });
            const page = manifest.pages[0]!;
            const intrinsicWidth = page.sourcePageIndex === 0 ? 60 : 100;
            const intrinsicHeight = page.sourcePageIndex === 0 ? 120 : 140;
            if (lossless) {
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    canvasScope: 'page',
                    layoutClassification: 'single-uncut-page',
                    layoutConfidence: 0.9,
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
                            widthPx: intrinsicWidth,
                            heightPx: intrinsicHeight,
                        },
                        contentBox: null,
                        cropRect: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: intrinsicWidth,
                            heightPx: intrinsicHeight,
                        },
                        appliedMargins: {
                            leftPx: 0,
                            topPx: 0,
                            rightPx: 0,
                            bottomPx: 0,
                        },
                        inputWidthPx: intrinsicWidth,
                        inputHeightPx: intrinsicHeight,
                    }],
                }));
                return;
            }
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
            const output = page.outputs[0]!;
            const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8'));
            await writeFile(output.metadataPath, JSON.stringify({
                ...metadata,
                outputWidthPx: intrinsicWidth,
                outputHeightPx: intrinsicHeight,
                canvasWidthPx: 100,
                canvasHeightPx: 140,
                matchedCanvasTargetWidthPx: 100,
                matchedCanvasTargetHeightPx: 140,
                canvasPolicy: 'strict-maximum',
            }));
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const detectRequest = {
            ...detectionRequest,
            options: {
                ...detectionRequest.options,
                preserveOriginalQuality: lossless,
            },
        };
        const started = await service.detectAll(owner, detectRequest);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectRequest,
        )?.status).toBe('completed'));

        const second = await previewOf(service, owner, {
            ...request,
            pageNumber: 2,
            options: detectRequest.options,
        });
        const first = await previewOf(service, owner, {
            ...request,
            pageNumber: 1,
            options: detectRequest.options,
        });

        // The raster path reads the canvas the sidecar wrote; the lossless path
        // places the analysed crop on the same document rectangle itself.
        const matchedCanvas = lossless
            ? {
                canvasWidthPx: DOCUMENT_CANVAS.widthPx,
                canvasHeightPx: DOCUMENT_CANVAS.heightPx,
            }
            : {
                canvasWidthPx: 100,
                canvasHeightPx: 140,
            };
        expect([
            first.outputs[0]?.metadata,
            second.outputs[0]?.metadata,
        ]).toEqual([
            expect.objectContaining({
                ...matchedCanvas,
                canvasScope: 'page',
            }),
            expect.objectContaining({
                ...matchedCanvas,
                canvasScope: 'page',
            }),
        ]);
        expect(previewManifests).toEqual([
            {
                canvasScope: 'page',
                documentCanvas: DOCUMENT_CANVAS,
            },
            {
                canvasScope: 'page',
                documentCanvas: DOCUMENT_CANVAS,
            },
        ]);
    });

    it('carries a page the engine fitted below the document scale across the bridge', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalSidecar = deps.runSidecar;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{outputs: Array<{metadataPath: string}>}>};
            const output = manifest.pages[0]!.outputs[0]!;
            const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as Record<string, unknown>;
            // What the engine writes for a page whose margins reach past the
            // paper they were measured on: the raster the preview rendered,
            // which is larger than the canvas because the renderer scales it,
            // and the box that raster occupies on the canvas, which is inside
            // it. Reading the placement from the raster instead of the box is
            // what used to make this page an impossible placement.
            await writeFile(output.metadataPath, JSON.stringify({
                ...metadata,
                outputWidthPx: 252,
                outputHeightPx: 232,
                canvasWidthPx: 200,
                canvasHeightPx: 180,
                canvasPolicy: 'strict-maximum',
                canvasOverflow: true,
                matchedCanvasTargetWidthPx: 200,
                matchedCanvasTargetHeightPx: 180,
                matchedCanvasTargetWidthPoints: 96,
                matchedCanvasTargetHeightPoints: 86.4,
                matchedCanvasContentWidthPx: 196,
                matchedCanvasContentHeightPx: 180,
                placementOffsetXPx: 2,
                placementOffsetYPx: 0,
                warnings: ['Matched page size fitted this page to 196x180 px inside the 200x180 px document canvas, '
                    + 'below the document\'s scale'],
            }));
        });

        const result = await previewOf(createScanCleanupPreviewService(deps), sender(), request);

        // The page arrives whole — no blank frame, no error — and it still
        // says that it had to be fitted.
        expect(decodeScanCleanupPreviewResult(result)).toMatchObject({outputs: [{metadata: {
            outputWidthPx: 252,
            outputHeightPx: 232,
            canvasWidthPx: 200,
            canvasHeightPx: 180,
            matchedCanvasContentWidthPx: 196,
            matchedCanvasContentHeightPx: 180,
            placementOffsetXPx: 2,
            canvasOverflow: true,
            warnings: [expect.stringContaining('below the document\'s scale')],
        }}]});
    });

    it('rejects a matched page whose content box does not fit the canvas it names', () => {
        const metadata = {
            half: 'full',
            layoutClassification: 'single-uncut-page',
            layoutConfidence: 0.9,
            sourceRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 200,
                heightPx: 180,
            },
            contentBox: null,
            cropRect: {
                xPx: 0,
                yPx: 0,
                widthPx: 252,
                heightPx: 232,
            },
            appliedMargins: {
                leftPx: 0,
                topPx: 0,
                rightPx: 0,
                bottomPx: 0,
            },
            outputWidthPx: 252,
            outputHeightPx: 232,
            canvasWidthPx: 200,
            canvasHeightPx: 180,
            canvasPolicy: 'strict-maximum',
            canvasOverflow: true,
            // The box the page is placed in is wider than the canvas it is
            // placed on, which no producer can mean: the content box is what
            // every consumer lays out from.
            matchedCanvasContentWidthPx: 220,
            matchedCanvasContentHeightPx: 180,
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
            forwardTransform: null,
            cutterXPx: null,
            inputWidthPx: 200,
            inputHeightPx: 180,
            rotationDegrees: 0,
            canvasScope: 'page',
            resamplePasses: 1,
            rasterScaleLimited: false,
            warnings: [],
        };

        expect(() => decodeScanCleanupPreviewResult({
            pageNumber: 1,
            totalPages: 1,
            rawImageData: PNG,
            rawWidthPx: 200,
            rawHeightPx: 180,
            pageMetadata: {
                layoutClassification: 'single-uncut-page',
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            },
            outputs: [{
                imageData: PNG,
                metadata,
            }],
        })).toThrow(/intrinsic\/canvas placement/u);
    });

    it('answers the visible page when the prefetch that started the measurement is dropped', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const measuring = Promise.withResolvers<undefined>();
        const releaseMeasurement = Promise.withResolvers<undefined>();
        let measurements = 0;
        // The real reader passes its caller's signal to the native command, so
        // a measurement that carries one dies with that caller.
        deps.getPageSizes = vi.fn(async (_path, options) => {
            measurements += 1;
            measuring.resolve(undefined);
            if (options?.signal) await waitForRelease(releaseMeasurement.promise, options.signal);
            else await releaseMeasurement.promise;
            return DOCUMENT_PAGE_SIZES;
        });
        const canvases = new Map<number, unknown>();
        const originalSidecar = deps.runSidecar;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                documentCanvas?: unknown;
                pages: Array<{sourcePageIndex: number}>;
            };
            canvases.set(manifest.pages[0]!.sourcePageIndex + 1, manifest.documentCanvas);
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();

        const prefetch = previewOf(service, owner, {
            ...request,
            pageNumber: 2,
        });
        await measuring.promise;
        const visible = previewOf(service, owner, {
            ...request,
            visible: true,
        });
        // The prefetch that started the measurement is retired while the page
        // the user is on is still waiting for it.
        service.cancel(owner, {
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
            invalidateRawCache: false,
            retainPages: [1],
        });
        releaseMeasurement.resolve(undefined);

        await expect(prefetch).rejects.toMatchObject({name: 'AbortError'});
        await expect(visible).resolves.toMatchObject({pageNumber: 1});
        // And it got the measured canvas, not the empty answer a cancelled
        // measurement would have left behind.
        expect(canvases.get(1)).toEqual(DOCUMENT_CANVAS);
        expect(measurements).toBe(1);
    });

    it('keeps the shared measurement alive when a later awaiter is cancelled', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const measuring = Promise.withResolvers<undefined>();
        const releaseMeasurement = Promise.withResolvers<undefined>();
        let measurements = 0;
        // The real reader passes its caller's signal to the native command, so
        // a measurement that carries one dies with that caller.
        deps.getPageSizes = vi.fn(async (_path, options) => {
            measurements += 1;
            measuring.resolve(undefined);
            if (options?.signal) await waitForRelease(releaseMeasurement.promise, options.signal);
            else await releaseMeasurement.promise;
            return DOCUMENT_PAGE_SIZES;
        });
        const canvases = new Map<number, unknown>();
        const originalSidecar = deps.runSidecar;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                documentCanvas?: unknown;
                pages: Array<{sourcePageIndex: number}>;
            };
            canvases.set(manifest.pages[0]!.sourcePageIndex + 1, manifest.documentCanvas);
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();

        const visible = previewOf(service, owner, {
            ...request,
            visible: true,
        });
        await measuring.promise;
        const neighbour = previewOf(service, owner, {
            ...request,
            pageNumber: 2,
        });
        service.cancel(owner, {
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
            invalidateRawCache: false,
            retainPages: [1],
        });
        releaseMeasurement.resolve(undefined);

        await expect(neighbour).rejects.toMatchObject({name: 'AbortError'});
        await expect(visible).resolves.toMatchObject({pageNumber: 1});
        expect(canvases.get(1)).toEqual(DOCUMENT_CANVAS);
        expect(measurements).toBe(1);
    });

    it('keeps a live replacement reachable when an older generation retires late', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const originalRenderPage = deps.renderPage;
        const gate = Promise.withResolvers<undefined>();
        let renders = 0;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            renders += 1;
            await gate.promise;
            await originalRenderPage(...args);
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const previewWith = (thickness: number) => previewOf(service, owner, {
            ...request,
            options: {
                ...request.options,
                thickness,
            },
        });

        // Three lingering keys for the same page, each superseding the ones
        // before it, and then a replacement that reuses the second key. The
        // lane now holds an older entry carrying the generation a counter taken
        // from the superseded list would hand to the live one.
        const first = previewWith(0);
        const second = previewWith(1);
        const third = previewWith(2);
        const replacement = previewWith(1);
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        await expect(second).rejects.toMatchObject({name: 'AbortError'});
        await expect(third).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(renders).toBe(1));

        // The retired generation must not have taken the live replacement out
        // of the registry with it: an identical request adopts the run in
        // flight instead of starting a second render of the same page.
        const adopting = previewWith(1);
        await new Promise(resolve => {
            setTimeout(resolve, 0);
        });
        expect(renders).toBe(1);
        gate.resolve(undefined);
        await expect(replacement).resolves.toMatchObject({pageNumber: 1});
        await expect(adopting).resolves.toMatchObject({pageNumber: 1});
        expect(renders).toBe(1);
    });

    it('publishes a re-rendered raster over a destination another request still holds', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const published: Array<[string, string]> = [];
        deps.publishRaster = vi.fn(async (source: string, destination: string, options) => {
            published.push([
                source,
                destination,
            ]);
            await atomicReplace(source, destination, options);
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();

        await previewOf(service, owner, request);
        service.cancel(owner, {
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
        });
        await previewOf(service, owner, request);

        // Every publication is a replace of the page's stable path rather than
        // a raw rename, so a destination another request has open is moved
        // aside instead of failing the write on Windows.
        expect(published.length).toBeGreaterThanOrEqual(2);
        expect(published.every(([
            source,
            destination,
        ]) => source.includes('.part.png') && !destination.includes('.part.'))).toBe(true);
        expect(vi.mocked(deps.publishRaster).mock.calls.every(call => call[2]?.durable === false)).toBe(true);
    });

    it('streams every detection classification to the subscriber exactly once', async () => {
        const dir = await setup();
        const totalPages = 40;
        const deps = dependencies(dir);
        deps.getPageCount = vi.fn(async () => totalPages);
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        const batches = [
            {
                lastPage: 20,
                entered: Promise.withResolvers<undefined>(),
                released: Promise.withResolvers<undefined>(),
            },
            {
                lastPage: 30,
                entered: Promise.withResolvers<undefined>(),
                released: Promise.withResolvers<undefined>(),
            },
            {
                lastPage: totalPages,
                entered: Promise.withResolvers<undefined>(),
                released: Promise.withResolvers<undefined>(),
            },
        ];
        deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            await writeDetectionMetadata(manifestPath);
            const analyzePage = (pageNumber: number) => {
                const progress = {
                    stage: 'detecting' as const,
                    completedUnits: pageNumber,
                    totalUnits: totalPages,
                    percent: pageNumber / totalPages * 100,
                    completedPageNumbers: Array.from({length: pageNumber}, (_, index) => index + 1),
                };
                onProgress(progress, {
                    stage: 'page-analyzed',
                    completedPages: pageNumber,
                    totalPages,
                    pageNumber,
                });
                onProgress(progress, {
                    stage: 'page-complete',
                    completedPages: pageNumber,
                    totalPages,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            };
            let nextPage = 1;
            for (const batch of batches) {
                for (; nextPage <= batch.lastPage; nextPage += 1) analyzePage(nextPage);
                batch.entered.resolve(undefined);
                await batch.released.promise;
            }
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const streamedStates = () => owner.send.mock.calls
            .filter(([channel]) => channel === SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState)
            .map(([
                _channel,
                state,
            ]) => decodeScanCleanupDetectionJobState(state)!);
        const started = await service.detectAll(owner, detectionRequest);
        service.subscribeDetectionJob(owner, started.jobId, detectionRequest);

        for (const batch of batches) {
            await batch.entered.promise;
            await vi.waitFor(() => expect(
                streamedStates().flatMap(state => state.results),
            ).toHaveLength(batch.lastPage));
            batch.released.resolve(undefined);
        }
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.status).toBe('completed'));

        const streamed = streamedStates();
        const streamedPages = streamed
            .filter(state => state.status !== 'completed')
            .flatMap(state => state.results.map(result => result.pageNumber));
        const rankedPhases = streamed.map(state => [
            'queued',
            'rasterizing',
            'detecting',
        ].indexOf(state.progress.stage));

        // Every classification reaches the renderer once: nothing is replayed
        // while the job runs, nothing is dropped by coalescing.
        expect(streamedPages).toEqual(Array.from({length: totalPages}, (_, index) => index + 1));
        expect(streamed.length).toBeLessThan(totalPages);
        expect(rankedPhases).toEqual([...rankedPhases].sort((left, right) => left - right));
        expect(streamed.at(-1)).toMatchObject({
            status: 'completed',
            progress: {
                completedUnits: totalPages,
                totalUnits: totalPages,
            },
        });
        expect(streamed.at(-1)?.results).toHaveLength(totalPages);
    });

    it('re-detects a changed page over the rasters it already holds, page for page', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        deps.renderPage = vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            await writeFile(outputPath, pngWithDimensions(pageNumber, 1));
        });
        const manifests: Array<Array<{
            pageNumber: number;
            inputPath: string;
            rasterWidthPx: number;
        }>> = [];
        // The classification each page gets is read out of the pixels the
        // manifest points at, so a run that rasterized a page differently — or
        // left it out of the batch the sidecar reconciles over — cannot produce
        // the same results as the run before it.
        deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            await writeDetectionMetadata(manifestPath);
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                inputPath: string;
                sourcePageIndex: number;
            }>};
            const pages = await Promise.all(manifest.pages.map(async page => {
                const raster = await readFile(page.inputPath);
                return {
                    pageNumber: page.sourcePageIndex + 1,
                    inputPath: page.inputPath,
                    rasterWidthPx: raster.readUInt32BE(16),
                };
            }));
            manifests.push(pages);
            for (const [
                index,
                page,
            ] of pages.entries()) {
                onProgress({
                    stage: 'detecting',
                    completedUnits: index + 1,
                    totalUnits: pages.length,
                    percent: (index + 1) / pages.length * 100,
                    completedPageNumbers: pages.slice(0, index + 1).map(item => item.pageNumber),
                }, {
                    stage: 'page-complete',
                    completedPages: index + 1,
                    totalPages: pages.length,
                    pageNumber: page.pageNumber,
                    classification: page.rasterWidthPx > 1 ? 'two-page-spread' : 'single-uncut-page',
                    confidence: 0.5 + page.rasterWidthPx / 10,
                });
            }
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const detect = async (request_: IScanCleanupDetectionRequest) => {
            const started = await service.detectAll(owner, request_);
            await vi.waitFor(() => expect(service.getDetectionJobState(
                owner,
                started.jobId,
                request_,
            )?.status).toBe('completed'));
            return service.getDetectionJobState(owner, started.jobId, request_)!;
        };

        const cold = await detect(detectionRequest);
        expect(deps.renderPage).toHaveBeenCalledTimes(3);

        const rotated: IScanCleanupDetectionRequest = {
            ...detectionRequest,
            options: {
                ...detectionRequest.options,
                pageOverrides: {'2': {
                    rotationDegrees: 90,
                    layoutOverride: 'auto',
                    excluded: false,
                    manualSplit: null,
                }},
            },
        };
        const scoped = await detect(rotated);

        // The page override never reaches pdftoppm, so re-detecting after it
        // spawns nothing: every page comes out of retention.
        expect(deps.renderPage).toHaveBeenCalledTimes(3);
        expect(manifests).toHaveLength(2);
        expect(manifests[1]).toEqual(manifests[0]);
        expect(manifests[1]?.map(page => page.pageNumber)).toEqual([
            1,
            2,
            3,
        ]);
        expect(scoped.results).toEqual(cold.results);
    });

    it('keeps a raster its sidecar is reading when the same page is retained again', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.getPageCount = vi.fn(async () => 2);
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        // Preview and detection both reach page 1 while neither has retained
        // it yet, so both render it and both publish it under the same key.
        const bothRendering = Promise.withResolvers<undefined>();
        let coldRenders = 0;
        const originalRenderPage = deps.renderPage;
        deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
            if (args[2] === 1) {
                coldRenders += 1;
                if (coldRenders >= 2) bothRendering.resolve(undefined);
                await bothRendering.promise;
            }
            await originalRenderPage(...args);
        });
        // Neither sidecar opens its manifest until both rasters have been
        // published, which is exactly when one used to unlink the other's.
        const bothPublished = Promise.withResolvers<undefined>();
        let entered = 0;
        const readable: Record<string, boolean> = {};
        const originalSidecar = deps.runSidecar;
        const allExist = async (paths: readonly string[]) => {
            const found = await Promise.all(paths.map(async path => {
                try {
                    await stat(path);
                    return true;
                } catch {
                    return false;
                }
            }));
            return found.every(Boolean);
        };
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{inputPath: string}>};
            const detecting = manifest.pages.length > 1;
            entered += 1;
            if (entered >= 2) bothPublished.resolve(undefined);
            await bothPublished.promise;
            readable[detecting ? 'detection' : 'preview'] = await allExist(
                manifest.pages.map(page => page.inputPath),
            );
            if (!detecting) {
                await originalSidecar(binary, manifestPath, signal, log, onProgress);
                return;
            }
            await writeDetectionMetadata(manifestPath);
            for (const pageNumber of [
                1,
                2,
            ]) {
                onProgress({
                    stage: 'detecting',
                    completedUnits: pageNumber,
                    totalUnits: 2,
                    percent: pageNumber * 50,
                    completedPageNumbers: Array.from({length: pageNumber}, (_value, index) => index + 1),
                }, {
                    stage: 'page-complete',
                    completedPages: pageNumber,
                    totalPages: 2,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();

        const previewed = previewOf(service, owner, request);
        const started = await service.detectAll(owner, detectionRequest);
        await previewed;
        await vi.waitFor(() => expect(
            service.getDetectionJobState(owner, started.jobId, detectionRequest)?.status,
        ).toBe('completed'));

        expect(coldRenders).toBe(2);
        expect(readable).toEqual({
            detection: true,
            preview: true,
        });
    });

    it('readmits an adopted prefetch as the visible page and drops one nothing can admit', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.prefetchLeaseTimeoutMs = 30_000;
        const admissions: Array<{
            visibility: string;
            granted: boolean;
        }> = [];
        const granted = Promise.withResolvers<undefined>();
        // One native process is free, which is what a detection run at
        // capacity-1 leaves behind: a visible request fits, a prefetch does not.
        deps.acquirePreviewLease = vi.fn(async (_ownerId, visibility, signal) => {
            const admission = {
                visibility,
                granted: false,
            };
            admissions.push(admission);
            if (visibility === 'prefetch') {
                return new Promise<{release: () => boolean}>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(
                        signal.reason instanceof Error
                            ? signal.reason
                            : new DOMException('aborted', 'AbortError'),
                    ), {once: true});
                });
            }
            admission.granted = true;
            granted.resolve(undefined);
            return {release: vi.fn(() => true)};
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();

        // Page 1 is what the user is looking at, so page 2 is a prefetch.
        await previewOf(service, owner, {
            ...request,
            visible: true,
        });
        const prefetch = previewOf(service, owner, {
            ...request,
            pageNumber: 2,
        });
        await vi.waitFor(() => expect(admissions).toHaveLength(2));
        // Navigating onto the prefetched page adopts its run, which is then
        // readmitted as the page the user is waiting on rather than left in a
        // queue behind detection.
        const navigated = previewOf(service, owner, {
            ...request,
            pageNumber: 2,
            visible: true,
        });
        await granted.promise;

        await expect(prefetch).resolves.toMatchObject({pageNumber: 2});
        await expect(navigated).resolves.toMatchObject({pageNumber: 2});
        expect(admissions.map(admission => admission.visibility)).toEqual([
            'visible',
            'prefetch',
            'visible',
        ]);
    });

    it('drops a prefetch nothing admits instead of leaving the page committed to it', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.prefetchLeaseTimeoutMs = 20;
        deps.acquirePreviewLease = vi.fn((_ownerId, visibility, signal) => {
            if (visibility === 'prefetch') {
                return new Promise<{release: () => boolean}>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(
                        signal.reason instanceof Error
                            ? signal.reason
                            : new DOMException('aborted', 'AbortError'),
                    ), {once: true});
                });
            }
            return Promise.resolve({release: vi.fn(() => true)});
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();

        await previewOf(service, owner, {
            ...request,
            visible: true,
        });
        const prefetch = service.preview(owner, {
            ...request,
            pageNumber: 2,
        });

        await expect(prefetch).resolves.toEqual({canceled: true});
        // The dropped run is not adopted by the page turn that follows it: the
        // visible request renders page 2 for itself.
        await expect(previewOf(service, owner, {
            ...request,
            pageNumber: 2,
            visible: true,
        })).resolves.toMatchObject({pageNumber: 2});
    });

    it('does not queue for a preview lease when the run is canceled while its working copy materializes', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const materializing = Promise.withResolvers<undefined>();
        const finishMaterializing = Promise.withResolvers<undefined>();
        // Materialization is the one await between the run's abort check and the
        // lease it queues for, so a cancellation that lands here is the one the
        // lease has to see.
        deps.materializeWorkingCopy = vi.fn(async (sourcePdfPath: string) => {
            materializing.resolve(undefined);
            await finishMaterializing.promise;
            return {
                logicalRef: sourcePdfPath,
                physicalWorkingCopyPath: sourcePdfPath,
                sourceFingerprint: '',
            };
        });
        const acquirePreviewLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        deps.acquirePreviewLease = acquirePreviewLease;
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();

        const pending = service.preview(owner, {
            ...request,
            visible: true,
        });
        await materializing.promise;
        expect(service.cancel(owner, request)).toBe(true);
        finishMaterializing.resolve(undefined);

        await expect(pending).resolves.toEqual({canceled: true});
        expect(acquirePreviewLease).not.toHaveBeenCalled();
    });

    it('rasterizes only the pages retention no longer holds and still reconciles over the whole document', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
        const manifestPageCounts: number[] = [];
        deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            await writeDetectionMetadata(manifestPath);
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{sourcePageIndex: number}>};
            manifestPageCounts.push(manifest.pages.length);
            for (const [
                index,
                page,
            ] of manifest.pages.entries()) {
                onProgress({
                    stage: 'detecting',
                    completedUnits: index + 1,
                    totalUnits: manifest.pages.length,
                    percent: (index + 1) / manifest.pages.length * 100,
                    completedPageNumbers: [page.sourcePageIndex + 1],
                }, {
                    stage: 'page-complete',
                    completedPages: index + 1,
                    totalPages: manifest.pages.length,
                    pageNumber: page.sourcePageIndex + 1,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
        });
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const started = await service.detectAll(owner, detectionRequest);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.status).toBe('completed'));
        expect(deps.renderPage).toHaveBeenCalledTimes(3);

        const rasters = (await readdir(dir, {recursive: true}))
            .filter(entry => entry.endsWith('.png'))
            .map(entry => join(dir, entry));
        expect(rasters).toHaveLength(3);
        await rm(rasters[0]!);

        const resumed = await service.detectAll(owner, detectionRequest);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            resumed.jobId,
            detectionRequest,
        )?.status).toBe('completed'));

        expect(deps.renderPage).toHaveBeenCalledTimes(4);
        expect(manifestPageCounts).toEqual([
            3,
            3,
        ]);
    });

    it('schedules a page switch during detection instead of piling native processes onto the host', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const {capacity} = mainJobBroker.getSnapshot();
        deps.getPageCount = vi.fn(async () => 8);
        let liveNatives = 0;
        let peakNatives = 0;
        const trackNative = async <T>(run: () => Promise<T>) => {
            liveNatives += 1;
            peakNatives = Math.max(peakNatives, liveNatives);
            try {
                return await run();
            } finally {
                liveNatives -= 1;
            }
        };
        // Detection parks on the pages the previews never ask for, so its lease
        // is held by exactly `rasterConcurrency` live rasterisers while the page
        // switch arrives.
        const heldDetectionRasters = Promise.withResolvers<undefined>();
        const originalRenderPage = deps.renderPage;
        deps.renderPage = vi.fn((...args) => trackNative(async () => {
            if (args[2] > 3) await heldDetectionRasters.promise;
            await originalRenderPage(
                args[0],
                args[1],
                args[2],
                args[3],
                args[4],
                args[5],
                args[6],
                args[7],
            );
        }));
        const originalRunSidecar = deps.runSidecar;
        const heldPreviewSidecars = Promise.withResolvers<undefined>();
        deps.runSidecar = vi.fn((...args) => trackNative(async () => {
            const manifestPath = args[1];
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                operation: string;
                pages: unknown[];
            };
            if (manifest.operation !== 'analyze') {
                await heldPreviewSidecars.promise;
                await originalRunSidecar(
                    args[0],
                    args[1],
                    args[2],
                    args[3],
                    args[4],
                );
                return;
            }
            await writeDetectionMetadata(manifestPath);
            for (let pageNumber = 1; pageNumber <= manifest.pages.length; pageNumber += 1) {
                args[4]({
                    stage: 'rendering',
                    completedUnits: pageNumber,
                    totalUnits: manifest.pages.length,
                    percent: pageNumber / manifest.pages.length * 100,
                    completedPageNumbers: [pageNumber],
                }, {
                    stage: 'page-complete',
                    completedPages: pageNumber,
                    totalPages: manifest.pages.length,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
        }));
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        const started = await service.detectAll(owner, detectionRequest);
        await vi.waitFor(() => expect(liveNatives).toBe(capacity.nativeProcesses - 1));

        const previewPage = (pageNumber: number, visible = false) => previewOf(service, owner, {
            ...request,
            pageNumber,
            ...(visible ? {visible: true} : {}),
        });
        const visiblePreview = previewPage(1, true);
        // The page the user navigates onto is served while detection still holds
        // its lease: its raw raster reaches the renderer without waiting for the
        // job, and a whole sidecar run before the cleaned outputs.
        await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(
            SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw,
            expect.objectContaining({pageNumber: 1}),
        ));
        const prefetched = [
            previewPage(2),
            previewPage(3),
        ];
        // The visible page reaches its sidecar; the two prefetches are scheduled
        // behind the machine rather than added to it.
        await vi.waitFor(() => expect(deps.runSidecar).toHaveBeenCalledTimes(1));
        expect(liveNatives).toBe(capacity.nativeProcesses);
        expect(peakNatives).toBe(capacity.nativeProcesses);
        expect(service.getDetectionJobState(owner, started.jobId, request)?.status).toBe('running');

        heldPreviewSidecars.resolve(undefined);
        expect((await visiblePreview).pageNumber).toBe(1);
        expect(service.getDetectionJobState(owner, started.jobId, request)?.status).toBe('running');
        heldDetectionRasters.resolve(undefined);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            request,
        )?.status).toBe('completed'));
        expect((await Promise.all(prefetched)).map(result => result.pageNumber)).toEqual([
            2,
            3,
        ]);
        expect(peakNatives).toBe(capacity.nativeProcesses);
    });

    it('leases a visible preview ahead of a prefetch of the same document', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const acquire = vi.spyOn(mainJobBroker, 'acquire');
        const service = createScanCleanupPreviewService(deps);
        const owner = sender();
        await previewOf(service, owner, {
            ...request,
            visible: true,
        });
        await previewOf(service, owner, {
            ...request,
            pageNumber: 2,
        });

        const priorities = acquire.mock.calls
            .filter(([request_]) => request_.kind === 'scan-cleanup-preview')
            .map(([request_]) => ({
                priority: request_.priority,
                nativeProcesses: request_.resources.nativeProcesses,
            }));
        expect(priorities).toEqual([
            {
                priority: 'visible',
                nativeProcesses: 1,
            },
            {
                priority: 'background',
                nativeProcesses: 2,
            },
        ]);
        acquire.mockRestore();
    });

    it('cancels detect-all through its signal and removes its scratch artifacts', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<string>();
        const releaseLease = vi.fn(() => true);
        deps.acquireDetectionLease = vi.fn(async () => ({release: releaseLease}));
        deps.runSidecar = vi.fn(async (_binary, manifestPath, signal) => {
            entered.resolve(manifestPath);
            await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
        });
        const service = createScanCleanupPreviewService(deps);
        const started = await service.detectAll(sender(), detectionRequest);
        const manifestPath = await entered.promise;

        expect(service.cancelDetection(sender(2), started.jobId, request)).toBe(false);
        expect(service.cancelDetection(sender(), started.jobId, {
            ...request,
            documentRevision: 'stale-revision',
        })).toBe(false);
        expect(service.cancelDetection(sender(), started.jobId, request)).toBe(true);
        await vi.waitFor(() => expect(service.getDetectionJobState(sender(), started.jobId, request)?.status).toBe('canceled'));
        expect(releaseLease).toHaveBeenCalledOnce();
        await expect(stat(join(manifestPath, '..'))).rejects.toMatchObject({code: 'ENOENT'});
        expect(service.cancelDetection(sender(), started.jobId, request)).toBe(false);
    });
});
