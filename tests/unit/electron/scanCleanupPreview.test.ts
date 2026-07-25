import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
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
import {
    createScanCleanupPreviewService,
    type IScanCleanupDetectionSubscriber,
    type IScanCleanupPreviewDependencies,
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
const dirs: string[] = [];
const request: IScanCleanupPreviewRequest = {
    ownerId: 'preview-owner',
    documentRevision: 'revision-1',
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

function dependencies(dir: string): IScanCleanupPreviewDependencies {
    return {
        getPageCount: vi.fn(async () => 3),
        renderPage: vi.fn(async (_paths, _log, _page, _source, outputPath) => {
            await writeFile(outputPath, PNG);
        }),
        runSidecar: vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
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

        await createScanCleanupPreviewService(deps).preview(sender(), request);

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

    it('cancels preview work whose working copy is no longer registered', async () => {
        const service = createScanCleanupPreviewService();

        await expect(service.preview(sender(), request)).rejects.toMatchObject({name: 'AbortError'});
        await expect(service.previewRaw(sender(), {
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            sourcePdfPath: request.sourcePdfPath,
            pageNumber: request.pageNumber,
        })).rejects.toMatchObject({name: 'AbortError'});
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

        const first = service.preview(previewSender, request);
        await firstEntered.promise;
        const queued = service.preview(previewSender, {
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

        await createScanCleanupPreviewService(deps).preview(sender(), request);

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
        const result = await createScanCleanupPreviewService(deps).preview(sender(), {
            ...request,
            documentPrior,
            documentCanvasPlan: {
                widthPoints: 1,
                heightPoints: 1,
            },
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
        await service.preview(previewSender, request);
        const result = await service.preview(previewSender, {
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

        const budgetedResult = await service.preview(previewSender, {
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

        const mixedFallback = await service.preview(previewSender, {
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
        expect(renderCalls[3]).toEqual({dpi: 231});
        expect(detailPlan).toBeUndefined();
        expect(manifestOptions).toMatchObject({
            dpi: 231,
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
        await service.preview(previewSender, {
            ...request,
            options: manualZoneOptions,
        });
        const manualZoneFallback = await service.preview(previewSender, {
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
            dpi: 231,
            outputMode: 'bw',
        });
        expect(manualZoneFallback.outputs[0]?.metadata.renderRegion).toBeUndefined();
    });

    it('accepts unbounded nonnegative skew evidence and rejects invalid values at both metadata boundaries', async () => {
        const dir = await setup();
        const result = await createScanCleanupPreviewService(dependencies(dir)).preview(sender(), request);
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
        const result = await createScanCleanupPreviewService(dependencies(dir)).preview(sender(), request);
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

        expect(decodeScanCleanupPreviewResult(withRegion).outputs[0]?.metadata.renderRegion)
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

    it('uses an intrinsic provisional frame before detect-all supplies a canvas plan', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
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

        const result = await createScanCleanupPreviewService(deps).preview(sender(), request);

        expect(matchPageSize).toBe(false);
        expect(documentCanvas).toBeUndefined();
        expect(result.outputs[0]?.metadata).toMatchObject({
            canvasWidthPx: 1,
            canvasHeightPx: 1,
        });
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

        const result = await createScanCleanupPreviewService(deps).preview(sender(), {
            ...request,
            documentCanvasPlan: {
                widthPoints: 0.1,
                heightPoints: 0.1,
            },
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
        expect(decodeScanCleanupPreviewResult(result)).toMatchObject({outputs: [
            {metadata: {
                half: 'left',
                canvasWidthPx: 120,
                canvasHeightPx: 80,
                outputWidthPx: 120,
                outputHeightPx: 80,
                resamplePasses: 0,
            }},
            {metadata: {
                half: 'right',
                resamplePasses: 0,
            }},
        ]});
    });

    it('preempts an in-flight adjacent base prefetch before running the visible request', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<undefined>();
        let calls = 0;
        deps.renderPage = vi.fn(async (_paths, _log, _page, _source, outputPath, _dpi, _env, signal) => {
            calls += 1;
            if (calls === 1) {
                entered.resolve(undefined);
                await waitForRelease(Promise.withResolvers<never>().promise, signal!);
                return;
            }
            await writeFile(outputPath, PNG);
        });
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();
        const older = service.preview(previewSender, {
            ...request,
            pageNumber: 2,
        });
        await entered.promise;
        const newer = service.preview(previewSender, {
            ...request,
            options: {
                ...request.options,
                thickness: 1,
            },
        });
        await expect(older).rejects.toMatchObject({name: 'AbortError'});
        await expect(newer).resolves.toMatchObject({pageNumber: 1});
        expect(deps.runSidecar).toHaveBeenCalledOnce();
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
        const service = createScanCleanupPreviewService(deps);
        const previewSender = sender();

        await service.preview(previewSender, request);
        const pendingBase = service.preview(previewSender, {
            ...request,
            options: {
                ...request.options,
                thickness: 1,
            },
        });
        await baseRenderEntered.promise;
        const detail = service.preview(previewSender, {
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
        const pending = service.previewRaw(previewSender, request);
        await rasterEntered.promise;

        expect(service.cancel(previewSender, request)).toBe(true);
        releaseRaster.resolve(undefined);
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await expect(service.previewRaw(previewSender, request)).resolves.toMatchObject({pageNumber: 1});

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
        const pending = service.preview(previewSender, request);
        await sidecarEntered.promise;

        expect(service.cancel(previewSender, request)).toBe(true);
        releaseSidecar.resolve(undefined);
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await expect(service.preview(previewSender, {
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
        const stale = service.preview(previewSender, request);
        await staleEntered.promise;
        const currentRequest = {
            ...request,
            sourcePdfPath: '/replacement.pdf',
        };
        const current = service.previewRaw(previewSender, currentRequest);
        await currentEntered.promise;

        await expect(stale).rejects.toMatchObject({name: 'AbortError'});
        expect(service.cancel(previewSender, request)).toBe(false);
        expect(currentSignals[0]?.aborted).toBe(false);
        releaseCurrent.resolve(undefined);
        await expect(current).resolves.toMatchObject({pageNumber: 1});
    });

    it('aborts a raw request when the same owner moves to another document revision', async () => {
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
        const stale = service.previewRaw(previewSender, request);
        await staleEntered.promise;
        const current = service.preview(previewSender, {
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

        await service.preview(sender(), request);
        service.cancel(sender(), {
            ...request,
            invalidateRawCache: false,
        });
        await service.preview(sender(), {
            ...request,
            options: {
                ...request.options,
                thickness: 1,
            },
        });

        expect(deps.renderPage).toHaveBeenCalledOnce();
        expect(deps.runSidecar).toHaveBeenCalledTimes(2);

        service.cancel(sender(), request);
        await service.preview(sender(), {
            ...request,
            options: {
                ...request.options,
                thickness: 2,
            },
        });
        expect(deps.renderPage).toHaveBeenCalledTimes(2);
    });

    it('keeps the independently cached raw preview available when cleaned rendering fails', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        deps.runSidecar = vi.fn(async () => {
            throw new Error('invalid cleaned preview');
        });
        const service = createScanCleanupPreviewService(deps);

        await expect(service.previewRaw(sender(), request)).resolves.toMatchObject({
            pageNumber: 1,
            totalPages: 3,
            rawWidthPx: 1,
            rawHeightPx: 1,
        });
        await expect(service.preview(sender(), request)).rejects.toThrow('invalid cleaned preview');
        expect(deps.renderPage).toHaveBeenCalledOnce();
    });

    it('invalidates a stale raw raster when the document revision changes', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const service = createScanCleanupPreviewService(deps);

        await service.preview(sender(), request);
        await service.preview(sender(), {
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
        const first = service.preview(firstSender, request);
        await firstEntered.promise;
        const second = service.preview(secondSender, {
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
        const result = await createScanCleanupPreviewService(dependencies(dir)).preview(sender(), request);

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
        const result = await createScanCleanupPreviewService(dependencies(dir)).preview(sender(), request);

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
        const result = await createScanCleanupPreviewService(dependencies(dir)).preview(sender(), request);
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
            }],
            updatedAtMs: Date.now(),
        };
        expect(decodeScanCleanupDetectionJobState(state)?.results[0]?.textAxis).toEqual({
            sideways: true,
            confidence: 0.98,
        });
        expect(decodeScanCleanupDetectionJobState(state)?.results[0]?.recommendedOutputModeReason).toBe('blank');

        const withoutAxis = structuredClone(state);
        delete (withoutAxis.results[0] as {textAxis?: unknown}).textAxis;
        expect(decodeScanCleanupDetectionJobState(withoutAxis)?.results[0]).not.toHaveProperty('textAxis');

        const malformed = structuredClone(state);
        malformed.results[0]!.textAxis.confidence = Number.NaN;
        expect(() => decodeScanCleanupDetectionJobState(malformed)).toThrow('detection result');

        const malformedReason = structuredClone(state);
        malformedReason.results[0]!.recommendedOutputModeReason = 'empty';
        expect(() => decodeScanCleanupDetectionJobState(malformedReason)).toThrow('detection result');
    });

    it('publishes incremental rasterization and analysis progress before reconciled results', async () => {
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
        expect(analyzing?.results).toEqual([]);
        expect(decodeScanCleanupDetectionJobState(analyzing)).toEqual(analyzing);

        remainingAnalysis.resolve(undefined);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            detectionRequest,
        )?.status).toBe('completed'));
        expect(service.getDetectionJobState(owner, started.jobId, detectionRequest)).toMatchObject({
            documentCanvasPlan: {
                widthPoints: 57.6,
                heightPoints: 105.6,
            },
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
    });

    it('streams a brokered detect-all lifecycle and reuses preview rasters', async () => {
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
                pages: Array<{
                    sourcePageIndex: number;
                    options: {layout: string};
                    outputs?: unknown;
                }>;
            };
            if (manifest.operation !== 'analyze') {
                await originalSidecar(binary, manifestPath, signal, log, onProgress);
                return;
            }
            await writeDetectionMetadata(manifestPath);
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
        await service.preview(sender(), request);
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
        expect(deps.renderPage).toHaveBeenCalledTimes(3);
        expect(peakRasters).toBe(2);
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
        const documentCanvasPlan = service.getDetectionJobState(
            owner,
            started.jobId,
            detectRequest,
        )?.documentCanvasPlan;
        expect(documentCanvasPlan).toEqual({
            widthPoints: 48,
            heightPoints: 67.2,
        });
        if (!documentCanvasPlan) {
            throw new Error('Expected detect-all to publish a document canvas plan');
        }

        const second = await service.preview(owner, {
            ...request,
            pageNumber: 2,
            documentCanvasPlan,
            options: detectRequest.options,
        });
        const first = await service.preview(owner, {
            ...request,
            pageNumber: 1,
            documentCanvasPlan,
            options: detectRequest.options,
        });

        expect([
            first.outputs[0]?.metadata,
            second.outputs[0]?.metadata,
        ]).toEqual([
            expect.objectContaining({
                canvasWidthPx: 100,
                canvasHeightPx: 140,
                canvasScope: 'page',
            }),
            expect.objectContaining({
                canvasWidthPx: 100,
                canvasHeightPx: 140,
                canvasScope: 'page',
            }),
        ]);
        expect(previewManifests).toEqual([
            {
                canvasScope: 'page',
                documentCanvas: documentCanvasPlan,
            },
            {
                canvasScope: 'page',
                documentCanvas: documentCanvasPlan,
            },
        ]);
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
