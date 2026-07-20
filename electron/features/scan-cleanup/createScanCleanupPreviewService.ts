import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {randomUUID} from 'crypto';
import {
    isAbsolute,
    join,
} from 'path';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupDetectionResult,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
} from '@contracts/scanCleanupPageOverrides';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {renderPdfPageToPng} from '@electron/ocr/worker/popplerStage';
import {runScanCleanupSidecar} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {
    classifyScanCleanupError,
    resolveScanCleanupPath,
} from '@electron/features/scan-cleanup/createScanCleanupService';
import {SCAN_CLEANUP_EVENT_CHANNELS} from '@electron/features/scan-cleanup/contract';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';

const PREVIEW_DPI = 150;
const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const RAW_CACHE_PAGE_LIMIT = 32;
const RAW_CACHE_BYTE_LIMIT = 128 * 1024 * 1024;
const DETECTION_RASTER_CONCURRENCY = 2;
const logger = createLogger('scan-cleanup-preview');

interface IRawPreview {
    bytes: Uint8Array;
    width: number;
    height: number;
    totalPages: number;
}

interface ILosslessPreviewAnalysisOutput {
    half: IScanCleanupPreviewMetadata['half'];
    sourceRegion: IScanCleanupPreviewMetadata['sourceRegion'];
    contentBox: IScanCleanupPreviewMetadata['contentBox'];
    cropRect: IScanCleanupPreviewMetadata['sourceRegion'];
    appliedMargins: IScanCleanupPreviewMetadata['appliedMargins'];
    inputWidth: number;
    inputHeight: number;
}

type ILosslessPreviewPageMetadata = IScanCleanupPreviewResult['pageMetadata'] & {
    layoutConfidence: number;
    outputs?: ILosslessPreviewAnalysisOutput[];
};

interface IPreviewEntry {
    controller: AbortController;
    generation: number;
    tail: Promise<IScanCleanupPreviewResult>;
}

interface IDetectionJob {
    controller: AbortController;
    state: TScanCleanupDetectionJobState;
    subscribers: Set<IScanCleanupDetectionSubscriber>;
}

export interface IScanCleanupDetectionSubscriber {
    isDestroyed: () => boolean;
    send: (channel: string, state: TScanCleanupDetectionJobState) => void;
}

export interface IScanCleanupPreviewDependencies {
    getPageCount: typeof getPdfPageCount;
    renderPage: typeof renderPdfPageToPng;
    runSidecar: typeof runScanCleanupSidecar;
    resolveBinary: () => string | null;
    getTempDir: () => string;
    getPdftoppmBinary: () => string;
    acquireDetectionLease?: (jobId: string, signal: AbortSignal) => Promise<{release: () => boolean}>;
    cancelDetectionOwner?: (jobId: string) => void;
}

const defaultDependencies: IScanCleanupPreviewDependencies = {
    getPageCount: getPdfPageCount,
    renderPage: renderPdfPageToPng,
    runSidecar: runScanCleanupSidecar,
    resolveBinary: resolveScanCleanupPath,
    getTempDir: getAppTempDir,
    getPdftoppmBinary: () => getPdfNativeToolPaths().pdftoppm,
    acquireDetectionLease: (jobId, signal) => mainJobBroker.acquire({
        ownerId: jobId,
        kind: 'scan-cleanup-detect-all',
        priority: 'foreground',
        resources: {
            cpuTokens: 0.5,
            estimatedResidentBytes: 128 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 2,
        },
        perOwnerLimit: 1,
        signal,
    }),
    cancelDetectionOwner: jobId => mainJobBroker.cancelOwner(jobId, 'Scan cleanup detection canceled'),
};

function storeRawPreview(rawCache: Map<string, IRawPreview>, key: string, raw: IRawPreview) {
    rawCache.delete(key);
    rawCache.set(key, raw);
    let cachedBytes = [...rawCache.values()].reduce((total, entry) => total + entry.bytes.byteLength, 0);
    while (rawCache.size > RAW_CACHE_PAGE_LIMIT || cachedBytes > RAW_CACHE_BYTE_LIMIT) {
        const oldestKey: string | undefined = rawCache.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }
        const oldest = rawCache.get(oldestKey);
        rawCache.delete(oldestKey);
        cachedBytes -= oldest?.bytes.byteLength ?? 0;
    }
}

async function materializeRawRaster(
    sourcePdfPath: string,
    pageNumber: number,
    outputPath: string,
    signal: AbortSignal,
    rawCache: Map<string, IRawPreview>,
    dependencies: IScanCleanupPreviewDependencies,
    knownTotalPages?: number,
) {
    const cacheKey = `${sourcePdfPath}\u0000${pageNumber}`;
    const cached = rawCache.get(cacheKey);
    if (cached) {
        storeRawPreview(rawCache, cacheKey, cached);
        await writeFile(outputPath, cached.bytes);
        return cached;
    }
    const totalPages = knownTotalPages ?? await dependencies.getPageCount(sourcePdfPath, {signal});
    if (pageNumber > totalPages) throw new Error('Scan cleanup preview page is out of range');
    await dependencies.renderPage(
        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
        (level, message) => logger[level](message),
        pageNumber,
        sourcePdfPath,
        outputPath,
        PREVIEW_DPI,
        undefined,
        signal,
    );
    const bytes = await readPreviewBytes(outputPath);
    const raw = {
        bytes,
        ...readPngDimensions(bytes),
        totalPages,
    };
    storeRawPreview(rawCache, cacheKey, raw);
    return raw;
}

function readPngDimensions(bytes: Uint8Array) {
    const signature = [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ];
    if (bytes.byteLength < 24 || !signature.every((value, index) => bytes[index] === value)) {
        throw new Error('Scan cleanup preview produced an invalid PNG');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width < 1 || height < 1 || width * height > 45_000_000) {
        throw new Error(`Scan cleanup preview PNG dimensions ${width}x${height} exceed limits`);
    }
    return {
        width,
        height,
    };
}

async function readPreviewBytes(path: string) {
    const file = await stat(path);
    if (file.size < 1 || file.size > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await readFile(path));
    readPngDimensions(bytes);
    return bytes;
}

async function runPreview(
    request: IScanCleanupPreviewRequest,
    signal: AbortSignal,
    rawCache: Map<string, IRawPreview>,
    dependencies: IScanCleanupPreviewDependencies,
): Promise<IScanCleanupPreviewResult> {
    if (!isAbsolute(request.sourcePdfPath)) throw new Error('Scan cleanup preview requires an absolute source path');
    if (signal.aborted) throw signal.reason;
    const scratch = await mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-preview-'));
    try {
        const inputPath = join(scratch, 'source.png');
        const raw = await materializeRawRaster(
            request.sourcePdfPath,
            request.pageNumber,
            inputPath,
            signal,
            rawCache,
            dependencies,
        );
        if (signal.aborted) throw signal.reason;
        const binary = dependencies.resolveBinary();
        if (!binary) throw new Error('Scan cleanup native tool is unavailable');
        const outputs = [
            0,
            1,
        ].map(index => ({
            outputPath: join(scratch, `clean-${index}.png`),
            metadataPath: join(scratch, `clean-${index}.json`),
        }));
        const manifestPath = join(scratch, 'manifest.json');
        const pageMetadataPath = join(scratch, 'page.json');
        const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
        const lossless = request.options.preserveOriginalQuality === true;
        await writeFile(manifestPath, JSON.stringify({
            ...(lossless ? {classifyOnly: true} : {}),
            sharedOptions: {},
            pages: [{
                inputPath,
                sourcePageIndex: request.pageNumber - 1,
                pageMetadataPath,
                options: {
                    dpi: PREVIEW_DPI,
                    layout: resolveScanCleanupPageLayout(request.options.layoutMode, pageOverride.layoutOverride),
                    cropContent: request.options.crop,
                    marginsMm: [
                        request.options.marginsMm,
                        request.options.marginsMm,
                        request.options.marginsMm,
                        request.options.marginsMm,
                    ],
                    outputMode: lossless ? 'color' : request.options.outputMode,
                    thickness: lossless ? 0 : request.options.thickness,
                    despeckle: !lossless && request.options.outputMode === 'bw' && request.options.despeckle,
                    matchPageSize: request.options.matchPageSize,
                    pageAlignment: request.options.pageAlignment,
                    rotation: pageOverride.rotation,
                    excluded: pageOverride.excluded,
                    skipBlankPages: !lossless && request.options.skipBlankPages,
                    experimentalAutoDewarp: !lossless && request.options.straightenCurvedLines,
                    manualSplitX: pageOverride.manualSplitX,
                    manualContentBoxes: pageOverride.manualContentBoxes,
                    placementOverrides: pageOverride.placementOverrides,
                },
                outputs,
            }],
        }));
        await dependencies.runSidecar(binary, manifestPath, signal, (level, message) => logger[level](message), () => undefined);
        const pageMetadata = JSON.parse(await readFile(pageMetadataPath, 'utf8')) as ILosslessPreviewPageMetadata;
        if (lossless) {
            return {
                pageNumber: request.pageNumber,
                totalPages: raw.totalPages,
                rawImageData: raw.bytes,
                rawWidth: raw.width,
                rawHeight: raw.height,
                pageMetadata,
                outputs: (pageMetadata.outputs ?? []).map(output => ({
                    imageData: raw.bytes,
                    metadata: {
                        half: output.half,
                        layoutClassification: pageMetadata.layoutClassification,
                        layoutConfidence: pageMetadata.layoutConfidence,
                        sourceRegion: output.sourceRegion,
                        contentBox: output.contentBox,
                        appliedMargins: output.appliedMargins,
                        outputWidth: Math.max(1, Math.round(output.cropRect.width)),
                        outputHeight: Math.max(1, Math.round(output.cropRect.height)),
                        forwardTransform: null,
                        cutterX: pageMetadata.cutterX,
                        inputWidth: output.inputWidth,
                        inputHeight: output.inputHeight,
                        rotation: pageMetadata.rotation,
                        resamplePasses: 0,
                        warnings: [],
                    },
                })),
            };
        }
        const cleaned = [] as IScanCleanupPreviewResult['outputs'];
        for (const output of outputs) {
            try {
                cleaned.push({
                    imageData: await readPreviewBytes(output.outputPath),
                    metadata: JSON.parse(await readFile(output.metadataPath, 'utf8')) as IScanCleanupPreviewResult['outputs'][number]['metadata'],
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        return {
            pageNumber: request.pageNumber,
            totalPages: raw.totalPages,
            rawImageData: raw.bytes,
            rawWidth: raw.width,
            rawHeight: raw.height,
            pageMetadata,
            outputs: cleaned,
        };
    } finally {
        await rm(scratch, {
            recursive: true,
            force: true,
        });
    }
}

async function mapDetectionPages<T>(
    pages: readonly number[],
    task: (pageNumber: number) => Promise<T>,
) {
    const results = new Array<T>(pages.length);
    let nextIndex = 0;
    const workers = Array.from({length: Math.min(DETECTION_RASTER_CONCURRENCY, pages.length)}, async () => {
        while (nextIndex < pages.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await task(pages[index]!);
        }
    });
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    return results;
}

async function runDetection(
    request: IScanCleanupDetectionRequest,
    signal: AbortSignal,
    rawCache: Map<string, IRawPreview>,
    dependencies: IScanCleanupPreviewDependencies,
    publish: (results: IScanCleanupDetectionResult[], totalPages: number) => void,
) {
    const scratch = await mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-detect-'));
    try {
        const totalPages = await dependencies.getPageCount(request.sourcePdfPath, {signal});
        const pageNumbers = Array.from({length: totalPages}, (_, index) => index + 1);
        publish([], totalPages);
        const pages = await mapDetectionPages(pageNumbers, async pageNumber => {
            if (signal.aborted) throw signal.reason;
            const inputPath = join(scratch, `source-${pageNumber}.png`);
            await materializeRawRaster(
                request.sourcePdfPath,
                pageNumber,
                inputPath,
                signal,
                rawCache,
                dependencies,
                totalPages,
            );
            const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, pageNumber);
            return {
                inputPath,
                sourcePageIndex: pageNumber - 1,
                pageMetadataPath: join(scratch, `page-${pageNumber}.json`),
                options: {
                    dpi: PREVIEW_DPI,
                    layout: resolveScanCleanupPageLayout(request.options.layoutMode, pageOverride.layoutOverride),
                    thickness: request.options.thickness,
                    rotation: pageOverride.rotation,
                    excluded: pageOverride.excluded,
                    manualSplitX: pageOverride.manualSplitX,
                },
            };
        });
        if (signal.aborted) throw signal.reason;
        const manifestPath = join(scratch, 'classify-manifest.json');
        await writeFile(manifestPath, JSON.stringify({
            classifyOnly: true,
            sharedOptions: {},
            pages,
        }));
        const binary = dependencies.resolveBinary();
        if (!binary) throw new Error('Scan cleanup native tool is unavailable');
        const results: IScanCleanupDetectionResult[] = [];
        await dependencies.runSidecar(
            binary,
            manifestPath,
            signal,
            (level, message) => logger[level](message),
            progress => {
                if (
                    progress.event !== 'page-complete'
                    || progress.classification === undefined
                    || progress.confidence === undefined
                ) {
                    return;
                }
                results.push({
                    pageNumber: progress.page,
                    classification: progress.classification,
                    confidence: progress.confidence,
                    cutterX: progress.cutterX ?? null,
                });
                publish([...results], totalPages);
            },
        );
        if (results.length !== totalPages) {
            throw new Error(`evb-scan-cleanup returned ${results.length} classifications for ${totalPages} pages`);
        }
        return results;
    } finally {
        await rm(scratch, {
            recursive: true,
            force: true,
        });
    }
}

export interface IScanCleanupPreviewService {
    preview: (request: IScanCleanupPreviewRequest) => Promise<IScanCleanupPreviewResult>;
    cancel: (sourcePdfPath: string, invalidateRawCache?: boolean) => boolean;
    detectAll: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupDetectionRequest) => Promise<{
        started: boolean;
        jobId: string;
        error?: string;
        errorCode?: 'invalid-request'
    }>;
    cancelDetection: (jobId: string) => boolean;
    getDetectionJobState: (jobId: string) => TScanCleanupDetectionJobState | null;
    subscribeDetectionJob: (sender: IScanCleanupDetectionSubscriber, jobId: string) => TScanCleanupDetectionJobState | null;
}

export function createScanCleanupPreviewService(
    dependencies: IScanCleanupPreviewDependencies = defaultDependencies,
): IScanCleanupPreviewService {
    const active = new Map<string, IPreviewEntry>();
    const rawCache = new Map<string, IRawPreview>();
    const detectionJobs = new Map<string, IDetectionJob>();
    const publishDetection = (job: IDetectionJob, state: TScanCleanupDetectionJobState) => {
        job.state = state;
        for (const sender of job.subscribers) {
            if (!sender.isDestroyed()) sender.send(SCAN_CLEANUP_EVENT_CHANNELS.detectionState, state);
        }
    };
    return {
        preview(request) {
            const previous = active.get(request.sourcePdfPath);
            previous?.controller.abort(new DOMException('Superseded scan cleanup preview', 'AbortError'));
            const controller = new AbortController();
            const generation = (previous?.generation ?? 0) + 1;
            const priorTail = previous?.tail.catch(() => undefined) ?? Promise.resolve();
            const tail = priorTail.then(() => runPreview(request, controller.signal, rawCache, dependencies));
            active.set(request.sourcePdfPath, {
                controller,
                generation,
                tail,
            });
            void tail.finally(() => {
                if (active.get(request.sourcePdfPath)?.generation === generation) active.delete(request.sourcePdfPath);
            }).catch(() => undefined);
            return tail;
        },
        cancel(sourcePdfPath, invalidateRawCache = true) {
            const entry = active.get(sourcePdfPath);
            entry?.controller.abort(new DOMException('Canceled scan cleanup preview', 'AbortError'));
            if (invalidateRawCache) {
                for (const key of rawCache.keys()) {
                    if (key.startsWith(`${sourcePdfPath}\u0000`)) rawCache.delete(key);
                }
            }
            return Boolean(entry);
        },
        detectAll(sender, request) {
            const jobId = `scan-cleanup-detect-${randomUUID()}`;
            if (!isAbsolute(request.sourcePdfPath)) {
                return Promise.resolve({
                    started: false,
                    jobId,
                    error: 'Source must be an absolute path',
                    errorCode: 'invalid-request',
                });
            }
            const controller = new AbortController();
            const job: IDetectionJob = {
                controller,
                state: {
                    jobId,
                    status: 'queued',
                    progress: {
                        detectedCount: 0,
                        totalPages: 0,
                    },
                    results: [],
                    updatedAtMs: Date.now(),
                },
                subscribers: new Set([sender]),
            };
            detectionJobs.set(jobId, job);
            void (async () => {
                let lease: {release: () => boolean} | null = null;
                try {
                    const acquire = dependencies.acquireDetectionLease ?? defaultDependencies.acquireDetectionLease!;
                    lease = await acquire(jobId, controller.signal);
                    const results = await runDetection(
                        request,
                        controller.signal,
                        rawCache,
                        dependencies,
                        (nextResults, totalPages) => publishDetection(job, {
                            jobId,
                            status: 'running',
                            progress: {
                                detectedCount: nextResults.length,
                                totalPages,
                            },
                            results: nextResults,
                            updatedAtMs: Date.now(),
                        }),
                    );
                    publishDetection(job, {
                        jobId,
                        status: 'completed',
                        progress: {
                            detectedCount: results.length,
                            totalPages: results.length,
                        },
                        results,
                        updatedAtMs: Date.now(),
                    });
                } catch (error) {
                    const aborted = controller.signal.aborted;
                    if (aborted) {
                        publishDetection(job, {
                            ...job.state,
                            status: 'canceled',
                            updatedAtMs: Date.now(),
                        });
                    } else {
                        publishDetection(job, {
                            ...job.state,
                            status: 'failed',
                            error: getErrorMessage(error),
                            errorCode: classifyScanCleanupError(error, false),
                            updatedAtMs: Date.now(),
                        });
                    }
                } finally {
                    lease?.release();
                }
            })();
            return Promise.resolve({
                started: true,
                jobId,
            });
        },
        cancelDetection(jobId) {
            const job = detectionJobs.get(jobId);
            if (!job || [
                'completed',
                'failed',
                'canceled',
            ].includes(job.state.status)) {
                return false;
            }
            job.controller.abort(new DOMException('Scan cleanup detection canceled', 'AbortError'));
            (dependencies.cancelDetectionOwner ?? defaultDependencies.cancelDetectionOwner!)(jobId);
            return true;
        },
        getDetectionJobState(jobId) {
            return detectionJobs.get(jobId)?.state ?? null;
        },
        subscribeDetectionJob(sender, jobId) {
            const job = detectionJobs.get(jobId);
            if (!job) {
                return null;
            }
            job.subscribers.add(sender);
            return job.state;
        },
    };
}
