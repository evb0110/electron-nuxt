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
    SCAN_CLEANUP_IPC_CODECS,
} from '@electron/features/scan-cleanup/scanCleanupIpcCodecs';
import {SCAN_CLEANUP_CHANNELS} from '@electron/features/scan-cleanup/contract';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
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
        once: vi.fn((_event: 'destroyed', _listener: () => void) => undefined),
        removeListener: vi.fn((_event: 'destroyed', _listener: () => void) => undefined),
    } satisfies IScanCleanupDetectionSubscriber;
}

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'scan-cleanup-preview-test-'));
    dirs.push(dir);
    return dir;
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
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeFile(output.outputPath, PNG);
            await writeFile(output.metadataPath, JSON.stringify({
                canvasScope: 'page',
                half: 'full',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
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
                warnings: [],
            }));
        }),
        resolveBinary: () => '/cleanup',
        getTempDir: () => dir,
        getPdftoppmBinary: () => '/pdftoppm',
    };
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

    it('serializes nested reactive page overrides for every IPC request', () => {
        const reactiveOptions = reactive({
            ...request.options,
            pageOverrides: {'2': {
                rotationDegrees: 90 as const,
                layoutOverride: 'spread' as const,
                excluded: false,
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
            }},
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
            runOcrAfterCleanup: true,
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
                stage: 'cleaning',
                completedUnits: 2,
                totalUnits: 1,
                percent: 50,
            },
            updatedAtMs: Date.now(),
        })).toThrow('invalid scan-cleanup progress');
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
                illuminationNormalized: true,
                despeckleFallback: true,
                contentDiagnostics: {
                    sideConfidence: {left: 0.7},
                    textMask: {lineCount: 1},
                },
            }}],
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
                resamplePasses: 0,
            }},
            {metadata: {
                half: 'right',
                resamplePasses: 0,
            }},
        ]});
    });

    it('supersedes an older request before running the latest one', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<undefined>();
        let calls = 0;
        deps.renderPage = vi.fn(async (_paths, _log, _page, _source, outputPath, _dpi, _env, signal) => {
            calls += 1;
            if (calls === 1) {
                entered.resolve(undefined);
                await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), {once: true}));
                return;
            }
            await writeFile(outputPath, PNG);
        });
        const service = createScanCleanupPreviewService(deps);
        const older = service.preview(sender(), request);
        await entered.promise;
        const newer = service.preview(sender(), {
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

    it('accepts optional detection text-axis results and rejects malformed values', () => {
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
            }],
            updatedAtMs: Date.now(),
        };
        expect(decodeScanCleanupDetectionJobState(state)?.results[0]?.textAxis).toEqual({
            sideways: true,
            confidence: 0.98,
        });

        const withoutAxis = structuredClone(state);
        delete (withoutAxis.results[0] as {textAxis?: unknown}).textAxis;
        expect(decodeScanCleanupDetectionJobState(withoutAxis)?.results[0]).not.toHaveProperty('textAxis');

        const malformed = structuredClone(state);
        malformed.results[0]!.textAxis.confidence = Number.NaN;
        expect(() => decodeScanCleanupDetectionJobState(malformed)).toThrow('detection result');
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

    it('cancels detect-all through its signal and removes its scratch artifacts', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<string>();
        deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
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
        await expect(stat(join(manifestPath, '..'))).rejects.toMatchObject({code: 'ENOENT'});
        expect(service.cancelDetection(sender(), started.jobId, request)).toBe(false);
    });
});
