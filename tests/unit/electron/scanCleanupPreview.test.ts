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
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferences';
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
    sourcePdfPath: '/document.pdf',
    pageNumber: 1,
    options: {
        layoutMode: 'auto',
        outputMode: 'bw',
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        marginsMm: 5,
        despeckle: true,
        skipBlankPages: false,
        straightenCurvedLines: false,
        pageOverrides: {},
    },
};
const detectionRequest: IScanCleanupDetectionRequest = {
    sourcePdfPath: request.sourcePdfPath,
    options: request.options,
};

function sender() {
    return {
        isDestroyed: () => false,
        send: vi.fn(),
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
                layoutClassification: 'single-uncut-page',
                cutterX: null,
                rotation: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeFile(output.outputPath, PNG);
            await writeFile(output.metadataPath, JSON.stringify({
                half: 'full',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                sourceRegion: {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                },
                contentBox: {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                },
                appliedMargins: [
                    0,
                    0,
                    0,
                    0,
                ],
                outputWidth: 1,
                outputHeight: 1,
                cutterX: null,
                inputWidth: 1,
                inputHeight: 1,
                rotation: 0,
                resamplePasses: 1,
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
    it('serializes nested reactive page overrides for every IPC request', () => {
        const reactiveOptions = reactive({
            ...request.options,
            pageOverrides: {'2': {
                rotation: 90 as const,
                layoutOverride: 'spread' as const,
                excluded: false,
                manualSplitX: 480,
                manualContentBoxes: {left: {
                    x: 12,
                    y: 18,
                    width: 320,
                    height: 540,
                }},
                placementOverrides: {left: 'bottom-right' as const},
            }},
        });
        const options = toPlainScanCleanupOptions(reactiveOptions);
        const previewRequest = {
            sourcePdfPath: request.sourcePdfPath,
            pageNumber: request.pageNumber,
            options,
        };
        const startRequest = {
            sourcePdfPath: request.sourcePdfPath,
            options,
            runOcrAfterCleanup: true,
        };

        expect(() => structuredClone(previewRequest)).not.toThrow();
        expect(() => structuredClone(startRequest)).not.toThrow();
        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([previewRequest]))
            .toEqual([previewRequest]);
        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.cancelPreview].decodeArgs([
            request.sourcePdfPath,
            false,
        ])).toEqual([
            request.sourcePdfPath,
            false,
        ]);
        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.start].decodeArgs([startRequest]))
            .toEqual([startRequest]);
        expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.detectAll].decodeArgs([{
            sourcePdfPath: request.sourcePdfPath,
            options,
        }])).toEqual([{
            sourcePdfPath: request.sourcePdfPath,
            options,
        }]);
    });

    it('returns real sidecar bytes and validated metadata', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const runSidecar = deps.runSidecar;
        let previewMatchPageSize: boolean | undefined;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{options: {matchPageSize: boolean}}>};
            previewMatchPageSize = manifest.pages[0]?.options.matchPageSize;
            await runSidecar(binary, manifestPath, signal, log, onProgress);
        });
        const result = await createScanCleanupPreviewService(deps).preview(request);
        expect(deps.runSidecar).toHaveBeenCalledOnce();
        expect(previewMatchPageSize).toBe(true);
        expect(decodeScanCleanupPreviewResult(result)).toMatchObject({
            pageNumber: 1,
            totalPages: 3,
            rawWidth: 1,
            rawHeight: 1,
            outputs: [{metadata: {half: 'full'}}],
        });
    });

    it('uses analysis-only output metadata for the lossless original-page preview', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        let manifestOptions: Record<string, unknown> | null = null;
        let classifyOnly = false;
        deps.runSidecar = vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                classifyOnly?: boolean;
                pages: Array<{
                    pageMetadataPath: string;
                    options: Record<string, unknown>;
                }>;
            };
            classifyOnly = manifest.classifyOnly === true;
            manifestOptions = manifest.pages[0]!.options;
            await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                layoutClassification: 'two-page-spread',
                layoutConfidence: 0.94,
                cutterX: 1,
                rotation: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 2,
                outputs: [
                    {
                        half: 'left',
                        sourceRegion: {
                            x: 0,
                            y: 0,
                            width: 1,
                            height: 1,
                        },
                        contentBox: {
                            x: 0,
                            y: 0,
                            width: 1,
                            height: 1,
                        },
                        cropRect: {
                            x: 0,
                            y: 0,
                            width: 1,
                            height: 1,
                        },
                        appliedMargins: [
                            0,
                            0,
                            0,
                            0,
                        ],
                        inputWidth: 1,
                        inputHeight: 1,
                    },
                    {
                        half: 'right',
                        sourceRegion: {
                            x: 1,
                            y: 0,
                            width: 1,
                            height: 1,
                        },
                        contentBox: null,
                        cropRect: {
                            x: 1,
                            y: 0,
                            width: 1,
                            height: 1,
                        },
                        appliedMargins: [
                            0,
                            0,
                            0,
                            0,
                        ],
                        inputWidth: 2,
                        inputHeight: 1,
                    },
                ],
            }));
        });

        const result = await createScanCleanupPreviewService(deps).preview({
            ...request,
            options: {
                ...request.options,
                preserveOriginalQuality: true,
                thickness: 4,
                skipBlankPages: true,
                straightenCurvedLines: true,
            },
        });

        expect(classifyOnly).toBe(true);
        expect(manifestOptions).toMatchObject({
            outputMode: 'color',
            thickness: 0,
            despeckle: false,
            skipBlankPages: false,
            experimentalAutoDewarp: false,
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
        const older = service.preview(request);
        await entered.promise;
        const newer = service.preview({
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

        await service.preview(request);
        service.cancel(request.sourcePdfPath, false);
        await service.preview({
            ...request,
            options: {
                ...request.options,
                thickness: 1,
            },
        });

        expect(deps.renderPage).toHaveBeenCalledOnce();
        expect(deps.runSidecar).toHaveBeenCalledTimes(2);

        service.cancel(request.sourcePdfPath);
        await service.preview({
            ...request,
            options: {
                ...request.options,
                thickness: 2,
            },
        });
        expect(deps.renderPage).toHaveBeenCalledTimes(2);
    });

    it('rejects oversized encoded image responses at the IPC boundary', () => {
        expect(() => decodeScanCleanupPreviewResult({
            pageNumber: 1,
            totalPages: 1,
            rawWidth: 1,
            rawHeight: 1,
            rawImageData: PNG,
            outputs: [{
                imageData: new Uint8Array(32 * 1024 * 1024 + 1),
                metadata: {
                    half: 'full',
                    layoutClassification: 'single-uncut-page',
                    layoutConfidence: 0.9,
                    outputWidth: 1,
                    outputHeight: 1,
                },
            }],
        })).toThrow('invalid scan-cleanup preview output image');
    });

    it('rejects layout confidence outside the unit interval at the IPC boundary', async () => {
        const dir = await setup();
        const result = await createScanCleanupPreviewService(dependencies(dir)).preview(request);

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
        deps.cancelDetectionOwner = vi.fn();
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                classifyOnly?: boolean;
                pages: Array<{
                    sourcePageIndex: number;
                    options: {layout: string};
                    outputs?: unknown;
                }>;
            };
            if (!manifest.classifyOnly) {
                await originalSidecar(binary, manifestPath, signal, log, onProgress);
                return;
            }
            expect(manifest.pages.every(page => page.outputs === undefined)).toBe(true);
            expect(manifest.pages[1]?.options.layout).toBe('force-two-page');
            for (const page of manifest.pages) {
                const spread = page.sourcePageIndex <= 1;
                onProgress({
                    event: 'page-complete',
                    page: page.sourcePageIndex + 1,
                    total: manifest.pages.length,
                    classification: spread ? 'two-page-spread' : 'single-uncut-page',
                    confidence: page.sourcePageIndex === 0 ? 0.86 : page.sourcePageIndex === 1 ? 1 : 0.95,
                    ...(spread ? {cutterX: 0.5} : {}),
                });
            }
        });
        const service = createScanCleanupPreviewService(deps);
        await service.preview(request);
        const started = await service.detectAll(sender(), {
            ...detectionRequest,
            options: {
                ...detectionRequest.options,
                pageOverrides: {'2': {
                    rotation: 0,
                    layoutOverride: 'spread',
                    excluded: false,
                    manualSplitX: null,
                }},
            },
        });
        await vi.waitFor(() => expect(service.getDetectionJobState(started.jobId)?.status).toBe('completed'));

        const state = service.getDetectionJobState(started.jobId);
        expect(decodeScanCleanupDetectionJobState(state)).toEqual(state);
        expect(state).toMatchObject({
            status: 'completed',
            progress: {
                detectedCount: 3,
                totalPages: 3,
            },
            results: [
                {
                    pageNumber: 1,
                    classification: 'two-page-spread',
                    confidence: 0.86,
                    cutterX: 0.5,
                },
                {
                    pageNumber: 2,
                    classification: 'two-page-spread',
                    confidence: 1,
                    cutterX: 0.5,
                },
                {
                    pageNumber: 3,
                    classification: 'single-uncut-page',
                    confidence: 0.95,
                    cutterX: null,
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
        deps.cancelDetectionOwner = vi.fn();
        deps.runSidecar = vi.fn(async (_binary, manifestPath, signal) => {
            entered.resolve(manifestPath);
            await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
        });
        const service = createScanCleanupPreviewService(deps);
        const started = await service.detectAll(sender(), detectionRequest);
        const manifestPath = await entered.promise;

        expect(service.cancelDetection(started.jobId)).toBe(true);
        await vi.waitFor(() => expect(service.getDetectionJobState(started.jobId)?.status).toBe('canceled'));
        expect(deps.cancelDetectionOwner).toHaveBeenCalledWith(started.jobId);
        await expect(stat(join(manifestPath, '..'))).rejects.toMatchObject({code: 'ENOENT'});
        expect(service.cancelDetection(started.jobId)).toBe(false);
    });
});
