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
    IScanCleanupProgress,
    IScanCleanupOwnerContext,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupDetectionStartResult,
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupPlacementOffset,
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
import {buildNativeScanCleanupManifest} from '@electron/features/scan-cleanup/policy/buildNativeScanCleanupManifest';
import {
    createOwnerScopedJobRegistry,
    type IScanCleanupJobSubscriber,
} from '@electron/features/scan-cleanup/createOwnerScopedJobRegistry';

const PREVIEW_DPI = 150;
const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const RAW_CACHE_PAGE_LIMIT = 32;
const RAW_CACHE_BYTE_LIMIT = 128 * 1024 * 1024;
const DETECTION_RASTER_CONCURRENCY = 2;
const logger = createLogger('scan-cleanup-preview');

interface IRawPreview {
    bytes: Uint8Array;
    documentRevision: string;
    width: number;
    height: number;
    mtimeMs: number;
    pageNumber: number;
    sourcePdfPath: string;
    totalPages: number;
}

interface ILosslessPreviewAnalysisOutput {
    half: IScanCleanupPreviewMetadata['half'];
    sourceRegion: IScanCleanupPreviewMetadata['sourceRegion'];
    contentBox: IScanCleanupPreviewMetadata['contentBox'];
    contentDiagnostics?: IScanCleanupPreviewMetadata['contentDiagnostics'];
    cropRect: IScanCleanupPreviewMetadata['sourceRegion'];
    appliedMargins: IScanCleanupPreviewMetadata['appliedMargins'];
    inputWidthPx: number;
    inputHeightPx: number;
}

type ILosslessPreviewPageMetadata = IScanCleanupPreviewResult['pageMetadata'] & {outputs?: ILosslessPreviewAnalysisOutput[]};

interface INativePreviewOutputMetadata extends IScanCleanupPreviewMetadata {dewarpModel?: unknown;}

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

export interface IScanCleanupDetectionSubscriber extends IScanCleanupJobSubscriber {send: (channel: string, state: TScanCleanupDetectionJobState) => void;}

export interface IScanCleanupPreviewDependencies {
    getPageCount: typeof getPdfPageCount;
    renderPage: typeof renderPdfPageToPng;
    runSidecar: typeof runScanCleanupSidecar;
    resolveBinary: () => string | null;
    getTempDir: () => string;
    getPdftoppmBinary: () => string;
    acquireDetectionLease?: (jobId: string, signal: AbortSignal) => Promise<{release: () => boolean}>;
    getSourceMtimeMs?: (sourcePdfPath: string) => Promise<number>;
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
    getSourceMtimeMs: async sourcePdfPath => (await stat(sourcePdfPath)).mtimeMs,
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
    request: Pick<IScanCleanupPreviewRequest, 'sourcePdfPath' | 'documentRevision'>,
    pageNumber: number,
    outputPath: string,
    signal: AbortSignal,
    rawCache: Map<string, IRawPreview>,
    dependencies: IScanCleanupPreviewDependencies,
    knownTotalPages?: number,
) {
    const mtimeMs = await dependencies.getSourceMtimeMs?.(request.sourcePdfPath) ?? 0;
    for (const [
        key,
        entry,
    ] of rawCache) {
        if (
            entry.sourcePdfPath === request.sourcePdfPath
            && (entry.documentRevision !== request.documentRevision || entry.mtimeMs !== mtimeMs)
        ) {
            rawCache.delete(key);
        }
    }
    const cacheKey = JSON.stringify([
        request.sourcePdfPath,
        request.documentRevision,
        mtimeMs,
        pageNumber,
        PREVIEW_DPI,
    ]);
    const cached = rawCache.get(cacheKey);
    if (cached) {
        storeRawPreview(rawCache, cacheKey, cached);
        await writeFile(outputPath, cached.bytes);
        return cached;
    }
    const totalPages = knownTotalPages ?? await dependencies.getPageCount(request.sourcePdfPath, {signal});
    if (pageNumber > totalPages) throw new Error('Scan cleanup preview page is out of range');
    await dependencies.renderPage(
        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
        (level, message) => logger[level](message),
        pageNumber,
        request.sourcePdfPath,
        outputPath,
        PREVIEW_DPI,
        undefined,
        signal,
    );
    const bytes = await readPreviewBytes(outputPath);
    const raw = {
        bytes,
        documentRevision: request.documentRevision,
        ...readPngDimensions(bytes),
        mtimeMs,
        pageNumber,
        sourcePdfPath: request.sourcePdfPath,
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
            request,
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
        const documentCanvas = request.options.matchPageSize
            ? request.documentCanvasPlan
            : undefined;
        const effectiveOptions = documentCanvas === undefined && request.options.matchPageSize
            ? {
                ...request.options,
                matchPageSize: false,
            }
            : request.options;
        const manifest = buildNativeScanCleanupManifest({
            operation: lossless ? 'analyze' : 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: lossless ? 'lossless' : 'raster',
            options: effectiveOptions,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            ...(documentCanvas === undefined ? {} : {documentCanvas}),
            pages: [{
                inputPath,
                pageNumber: request.pageNumber,
                dpi: PREVIEW_DPI,
                pageMetadataPath,
                outputs,
                ...(request.documentPrior === undefined ? {} : {documentPrior: request.documentPrior}),
            }],
        });
        await writeFile(manifestPath, JSON.stringify(manifest));
        await dependencies.runSidecar(binary, manifestPath, signal, (level, message) => logger[level](message), () => undefined);
        const pageMetadata = JSON.parse(await readFile(pageMetadataPath, 'utf8')) as ILosslessPreviewPageMetadata;
        if (lossless) {
            const analyzedOutputs = pageMetadata.outputs ?? [];
            const canvasWidthPx = documentCanvas === undefined
                ? null
                : Math.max(1, Math.ceil(documentCanvas.widthPoints / 72 * PREVIEW_DPI));
            const canvasHeightPx = documentCanvas === undefined
                ? null
                : Math.max(1, Math.ceil(documentCanvas.heightPoints / 72 * PREVIEW_DPI));
            return {
                pageNumber: request.pageNumber,
                totalPages: raw.totalPages,
                rawImageData: raw.bytes,
                rawWidthPx: raw.width,
                rawHeightPx: raw.height,
                pageMetadata,
                outputs: analyzedOutputs.map(output => {
                    const outputWidthPx = Math.max(1, Math.round(output.cropRect.widthPx));
                    const outputHeightPx = Math.max(1, Math.round(output.cropRect.heightPx));
                    const resolvedCanvasWidth = Math.max(canvasWidthPx ?? outputWidthPx, outputWidthPx);
                    const resolvedCanvasHeight = Math.max(canvasHeightPx ?? outputHeightPx, outputHeightPx);
                    const placement = resolveScanCleanupPlacementOffset(
                        resolvedCanvasWidth - outputWidthPx,
                        resolvedCanvasHeight - outputHeightPx,
                        pageOverride.placementOverrides?.[output.half] ?? request.options.pageAlignment,
                    );
                    return {
                        imageData: raw.bytes,
                        metadata: {
                            half: output.half,
                            layoutClassification: pageMetadata.layoutClassification,
                            layoutConfidence: pageMetadata.layoutConfidence ?? 0,
                            sourceRegion: output.sourceRegion,
                            contentBox: output.contentBox,
                            cropRect: output.cropRect,
                            ...(output.contentDiagnostics === undefined
                                ? {}
                                : {contentDiagnostics: output.contentDiagnostics}),
                            appliedMargins: output.appliedMargins,
                            outputWidthPx,
                            outputHeightPx,
                            canvasWidthPx: resolvedCanvasWidth,
                            canvasHeightPx: resolvedCanvasHeight,
                            placementOffsetXPx: placement.x,
                            placementOffsetYPx: placement.y,
                            forwardTransform: null,
                            cutterXPx: pageMetadata.cutterXPx,
                            inputWidthPx: output.inputWidthPx,
                            inputHeightPx: output.inputHeightPx,
                            rotationDegrees: pageMetadata.rotationDegrees,
                            canvasScope: 'page',
                            resamplePasses: 0,
                            sourceDpi: PREVIEW_DPI,
                            renderDpi: PREVIEW_DPI,
                            requestedRenderDpi: PREVIEW_DPI,
                            rasterScaleLimited: false,
                            canvasPolicy: documentCanvas === undefined ? 'intrinsic' : 'strict-maximum',
                            canvasOverflow: false,
                            matchedCanvasTargetWidthPx: canvasWidthPx,
                            matchedCanvasTargetHeightPx: canvasHeightPx,
                            matchedCanvasTargetWidthPoints: documentCanvas?.widthPoints ?? null,
                            matchedCanvasTargetHeightPoints: documentCanvas?.heightPoints ?? null,
                            warnings: [],
                        },
                    };
                }),
            };
        }
        const cleaned = [] as IScanCleanupPreviewResult['outputs'];
        for (const output of outputs) {
            try {
                const nativeMetadata = JSON.parse(
                    await readFile(output.metadataPath, 'utf8'),
                ) as INativePreviewOutputMetadata;
                cleaned.push({
                    imageData: await readPreviewBytes(output.outputPath),
                    metadata: {
                        ...nativeMetadata,
                        ...(nativeMetadata.dewarpModel === undefined
                            ? {}
                            : {dewarpApplied: nativeMetadata.dewarpModel !== null}),
                    },
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        const diagnosticMetadata = cleaned[0]?.metadata;
        return {
            pageNumber: request.pageNumber,
            totalPages: raw.totalPages,
            rawImageData: raw.bytes,
            rawWidthPx: raw.width,
            rawHeightPx: raw.height,
            pageMetadata: {
                ...pageMetadata,
                ...(diagnosticMetadata?.detectedSkewDegrees === undefined
                    ? {}
                    : {detectedSkewDegrees: diagnosticMetadata.detectedSkewDegrees}),
                ...(diagnosticMetadata?.skewConfidence === undefined
                    ? {}
                    : {skewConfidence: diagnosticMetadata.skewConfidence}),
                ...(diagnosticMetadata?.manualSkew === undefined
                    ? {}
                    : {manualSkew: diagnosticMetadata.manualSkew}),
                ...(diagnosticMetadata?.binarizationMode === undefined
                    ? {}
                    : {binarizationMode: diagnosticMetadata.binarizationMode}),
                ...(diagnosticMetadata?.binarizationDiagnostics === undefined
                    ? {}
                    : {binarizationDiagnostics: diagnosticMetadata.binarizationDiagnostics}),
                ...(diagnosticMetadata?.despeckleFallback === undefined
                    ? {}
                    : {despeckleFallback: diagnosticMetadata.despeckleFallback}),
                ...(diagnosticMetadata?.dewarpConfidence === undefined
                    ? {}
                    : {dewarpConfidence: diagnosticMetadata.dewarpConfidence}),
                ...(diagnosticMetadata?.dewarpApplied === undefined
                    ? {}
                    : {dewarpApplied: diagnosticMetadata.dewarpApplied}),
                ...(diagnosticMetadata?.contentDiagnostics === undefined
                    ? {}
                    : {contentSideConfidence: diagnosticMetadata.contentDiagnostics.sideConfidence}),
                autoDewarpAttempted: request.options.autoDewarp === true,
            },
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
    onCompleted?: (pageNumber: number, completedPages: number) => void,
) {
    const results = new Array<T>(pages.length);
    let nextIndex = 0;
    let completedPages = 0;
    const workers = Array.from({length: Math.min(DETECTION_RASTER_CONCURRENCY, pages.length)}, async () => {
        while (nextIndex < pages.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await task(pages[index]!);
            completedPages += 1;
            onCompleted?.(pages[index]!, completedPages);
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
    publish: (results: IScanCleanupDetectionResult[], progress: IScanCleanupProgress) => void,
) {
    const scratch = await mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-detect-'));
    try {
        const totalPages = await dependencies.getPageCount(request.sourcePdfPath, {signal});
        const pageNumbers = Array.from({length: totalPages}, (_, index) => index + 1);
        publish([], {
            stage: 'rasterizing',
            completedUnits: 0,
            totalUnits: totalPages,
            percent: 0,
            completedPageNumbers: [],
        });
        const rasterizedPageNumbers = new Set<number>();
        const manifestPages = await mapDetectionPages(pageNumbers, async pageNumber => {
            if (signal.aborted) throw signal.reason;
            const inputPath = join(scratch, `source-${pageNumber}.png`);
            await materializeRawRaster(
                request,
                pageNumber,
                inputPath,
                signal,
                rawCache,
                dependencies,
                totalPages,
            );
            return {
                inputPath,
                pageNumber,
                dpi: PREVIEW_DPI,
                pageMetadataPath: join(scratch, `page-${pageNumber}.json`),
            };
        }, (pageNumber, completedPages) => {
            rasterizedPageNumbers.add(pageNumber);
            publish([], {
                stage: 'rasterizing',
                completedUnits: completedPages,
                totalUnits: totalPages,
                percent: totalPages === 0 ? 100 : completedPages / totalPages * 100,
                completedPageNumbers: [...rasterizedPageNumbers],
            });
        });
        if (signal.aborted) throw signal.reason;
        const manifestPath = join(scratch, 'classify-manifest.json');
        await writeFile(manifestPath, JSON.stringify(buildNativeScanCleanupManifest({
            operation: 'analyze',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: request.options.preserveOriginalQuality ? 'lossless' : 'raster',
            options: request.options,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: manifestPages,
        })));
        const binary = dependencies.resolveBinary();
        if (!binary) throw new Error('Scan cleanup native tool is unavailable');
        const results: IScanCleanupDetectionResult[] = [];
        let analyzedPages = 0;
        await dependencies.runSidecar(
            binary,
            manifestPath,
            signal,
            (level, message) => logger[level](message),
            (progress, nativeProgress) => {
                if (nativeProgress.stage === 'page-analyzed') {
                    analyzedPages = Math.max(analyzedPages, progress.completedUnits);
                    publish([...results], {
                        ...progress,
                        stage: 'detecting',
                        completedUnits: analyzedPages,
                        percent: progress.totalUnits === 0 ? 100 : analyzedPages / progress.totalUnits * 100,
                    });
                    return;
                }
                if (
                    nativeProgress.stage !== 'page-complete'
                    || nativeProgress.classification === undefined
                    || nativeProgress.confidence === undefined
                ) {
                    return;
                }
                results.push({
                    pageNumber: nativeProgress.pageNumber!,
                    classification: nativeProgress.classification,
                    confidence: nativeProgress.confidence,
                    cutterXPx: nativeProgress.cutterXPx ?? null,
                    tier1Verdict: nativeProgress.tier1Verdict ?? nativeProgress.classification,
                    reconciled: nativeProgress.reconciled ?? false,
                    clusterAgreement: nativeProgress.clusterAgreement ?? 0,
                    documentPrior: nativeProgress.documentPrior ?? null,
                    ...(nativeProgress.textAxis === undefined ? {} : {textAxis: nativeProgress.textAxis}),
                    ...(nativeProgress.recommendedOutputMode === undefined
                        ? {}
                        : {recommendedOutputMode: nativeProgress.recommendedOutputMode}),
                    ...(nativeProgress.recommendedOutputModeConfidence === undefined
                        ? {}
                        : {recommendedOutputModeConfidence: nativeProgress.recommendedOutputModeConfidence}),
                    ...(nativeProgress.recommendedOutputModeReason === undefined
                        ? {}
                        : {recommendedOutputModeReason: nativeProgress.recommendedOutputModeReason}),
                });
                const completedUnits = Math.max(analyzedPages, progress.completedUnits);
                publish([...results], {
                    ...progress,
                    stage: 'detecting',
                    completedUnits,
                    percent: progress.totalUnits === 0 ? 100 : completedUnits / progress.totalUnits * 100,
                });
            },
        );
        if (results.length !== totalPages) {
            throw new Error(`evb-scan-cleanup returned ${results.length} classifications for ${totalPages} pages`);
        }
        const cropDimensions = (
            await Promise.all(manifestPages.map(async page => {
                const metadata = JSON.parse(
                    await readFile(page.pageMetadataPath, 'utf8'),
                ) as ILosslessPreviewPageMetadata;
                return (metadata.outputs ?? []).map(output => ({
                    widthPoints: output.cropRect.widthPx / PREVIEW_DPI * 72,
                    heightPoints: output.cropRect.heightPx / PREVIEW_DPI * 72,
                }));
            }))
        ).flat();
        const documentCanvasPlan = cropDimensions.length === 0
            ? undefined
            : {
                widthPoints: Math.max(...cropDimensions.map(dimension => dimension.widthPoints)),
                heightPoints: Math.max(...cropDimensions.map(dimension => dimension.heightPoints)),
            };
        return {
            results,
            ...(documentCanvasPlan === undefined ? {} : {documentCanvasPlan}),
        };
    } finally {
        await rm(scratch, {
            recursive: true,
            force: true,
        });
    }
}

export interface IScanCleanupPreviewService {
    preview: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupPreviewRequest) => Promise<IScanCleanupPreviewResult>;
    cancel: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupPreviewCancelRequest) => boolean;
    detectAll: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupDetectionRequest) => Promise<TScanCleanupDetectionStartResult>;
    cancelDetection: (sender: IScanCleanupDetectionSubscriber, jobId: string, owner: IScanCleanupOwnerContext) => boolean;
    getDetectionJobState: (sender: IScanCleanupDetectionSubscriber, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupDetectionJobState | null;
    subscribeDetectionJob: (sender: IScanCleanupDetectionSubscriber, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupDetectionJobState | null;
}

export function createScanCleanupPreviewService(
    dependencies: IScanCleanupPreviewDependencies = defaultDependencies,
): IScanCleanupPreviewService {
    const active = new Map<string, IPreviewEntry>();
    const rawCache = new Map<string, IRawPreview>();
    const detectionJobs = createOwnerScopedJobRegistry<IScanCleanupDetectionSubscriber, IDetectionJob>();
    const publishDetection = (job: IDetectionJob, state: TScanCleanupDetectionJobState) => {
        job.state = state;
        for (const sender of job.subscribers) {
            if (!sender.isDestroyed()) sender.send(SCAN_CLEANUP_EVENT_CHANNELS.detectionState, state);
        }
        if ([
            'completed',
            'failed',
            'canceled',
        ].includes(state.status)) detectionJobs.expireTerminal(state.jobId);
    };
    return {
        preview(sender, request) {
            const activeKey = `${sender.id}\u0000${request.ownerId}\u0000${request.documentRevision}\u0000${request.sourcePdfPath}`;
            const ownerPrefix = `${sender.id}\u0000${request.ownerId}\u0000`;
            for (const [
                key,
                activePreview,
            ] of active) {
                if (key !== activeKey && key.startsWith(ownerPrefix) && key.endsWith(`\u0000${request.sourcePdfPath}`)) {
                    activePreview.controller.abort(new DOMException('Stale document revision', 'AbortError'));
                }
            }
            const previous = active.get(activeKey);
            previous?.controller.abort(new DOMException('Superseded scan cleanup preview', 'AbortError'));
            const controller = new AbortController();
            const generation = (previous?.generation ?? 0) + 1;
            const priorTail = previous?.tail.catch(() => undefined) ?? Promise.resolve();
            const tail = priorTail.then(() => runPreview(request, controller.signal, rawCache, dependencies));
            active.set(activeKey, {
                controller,
                generation,
                tail,
            });
            void tail.finally(() => {
                if (active.get(activeKey)?.generation === generation) active.delete(activeKey);
            }).catch(() => undefined);
            return tail;
        },
        cancel(sender, request) {
            const activeKey = `${sender.id}\u0000${request.ownerId}\u0000${request.documentRevision}\u0000${request.sourcePdfPath}`;
            const entry = active.get(activeKey);
            entry?.controller.abort(new DOMException('Canceled scan cleanup preview', 'AbortError'));
            if (request.invalidateRawCache !== false) {
                for (const [
                    key,
                    raw,
                ] of rawCache) {
                    if (raw.sourcePdfPath === request.sourcePdfPath && raw.documentRevision === request.documentRevision) {
                        rawCache.delete(key);
                    }
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
                        stage: 'queued',
                        completedUnits: 0,
                        totalUnits: 0,
                        percent: 0,
                        completedPageNumbers: [],
                    },
                    results: [],
                    updatedAtMs: Date.now(),
                },
                subscribers: new Set<IScanCleanupDetectionSubscriber>(),
            };
            detectionJobs.add(jobId, sender, request, job);
            void (async () => {
                let lease: {release: () => boolean} | null = null;
                let canceled = false;
                try {
                    const acquire = dependencies.acquireDetectionLease ?? defaultDependencies.acquireDetectionLease!;
                    lease = await acquire(jobId, controller.signal);
                    const detection = await runDetection(
                        request,
                        controller.signal,
                        rawCache,
                        dependencies,
                        (nextResults, progress) => publishDetection(job, {
                            jobId,
                            status: 'running',
                            progress,
                            results: nextResults,
                            updatedAtMs: Date.now(),
                        }),
                    );
                    publishDetection(job, {
                        jobId,
                        status: 'completed',
                        progress: {
                            stage: 'detecting',
                            completedUnits: detection.results.length,
                            totalUnits: detection.results.length,
                            percent: 100,
                            completedPageNumbers: detection.results.map(result => result.pageNumber),
                        },
                        results: detection.results,
                        ...(detection.documentCanvasPlan === undefined
                            ? {}
                            : {documentCanvasPlan: detection.documentCanvasPlan}),
                        updatedAtMs: Date.now(),
                    });
                } catch (error) {
                    const aborted = controller.signal.aborted;
                    if (aborted) {
                        canceled = true;
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
                    if (canceled) {
                        publishDetection(job, {
                            ...job.state,
                            status: 'canceled',
                            updatedAtMs: Date.now(),
                        });
                    }
                }
            })();
            return Promise.resolve({
                started: true,
                jobId,
            });
        },
        cancelDetection(sender, jobId, owner) {
            const job = detectionJobs.getOwned(jobId, sender, owner);
            if (!job || [
                'completed',
                'failed',
                'canceled',
            ].includes(job.state.status)) {
                return false;
            }
            publishDetection(job, {
                ...job.state,
                status: 'canceling',
                updatedAtMs: Date.now(),
            });
            // AbortSignal is the sole transport. The lease and native adapters
            // translate it into cooperative cancellation and forced teardown.
            job.controller.abort(new DOMException('Scan cleanup detection canceled', 'AbortError'));
            return true;
        },
        getDetectionJobState(sender, jobId, owner) {
            return detectionJobs.getOwned(jobId, sender, owner)?.state ?? null;
        },
        subscribeDetectionJob(sender, jobId, owner) {
            const job = detectionJobs.subscribe(jobId, sender, owner);
            if (!job) {
                return null;
            }
            return job.state;
        },
    };
}
