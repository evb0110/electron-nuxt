import {
    mkdtemp,
    open,
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
    IScanCleanupOwnerContext,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupRawPreviewRequest,
    IScanCleanupRawPreviewResult,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupDetectionStartResult,
    TScanCleanupDetectionJobState,
    TScanCleanupErrorCode,
    TScanCleanupProgress,
} from '@contracts/electronApiScanCleanup';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupPlacementOffset,
} from '@contracts/scanCleanupPageOverrides';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {detectSourceDpiDetails} from '@electron/pdf/sourceDpiDetection';
import {renderPdfPageToPng} from '@electron/ocr/worker/popplerStage';
import {runScanCleanupSidecar} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {
    classifyScanCleanupError,
    resolveScanCleanupPath,
} from '@electron/features/scan-cleanup/createScanCleanupService';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {buildNativeScanCleanupManifest} from '@electron/features/scan-cleanup/policy/buildNativeScanCleanupManifest';
import {resolveScanCleanupPipelineMaxPixels} from '@electron/features/scan-cleanup/policy/effectiveOptions';
import {
    createMainJobRegistry,
    type IMainJobErrorEnvelope,
    type IMainJobSender,
    type TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';

const PREVIEW_DPI = 150;
const DEFAULT_SOURCE_DPI = 300;
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

interface IRawPreviewEntry {
    controller: AbortController;
    generation: number;
    tail: Promise<IScanCleanupRawPreviewResult>;
}

interface IDetectionResult {
    documentCanvasPlan?: TScanCleanupDetectionJobState['documentCanvasPlan'];
    results: TScanCleanupDetectionJobState['results'];
}

type TDetectionError = IMainJobErrorEnvelope<TScanCleanupErrorCode>;
type TDetectionSnapshot = TMainJobSnapshot<TScanCleanupDetectionJobState, IDetectionResult, TDetectionError>;
export interface IScanCleanupDetectionSubscriber extends IMainJobSender {id: number;}

export interface IScanCleanupPreviewDependencies {
    getPageCount: typeof getPdfPageCount;
    renderPage: typeof renderPdfPageToPng;
    runSidecar: typeof runScanCleanupSidecar;
    resolveBinary: () => string | null;
    getTempDir: () => string;
    getPdftoppmBinary: () => string;
    detectSourceDpi?: (sourcePdfPath: string, pageNumber: number, signal: AbortSignal) => Promise<number | null>;
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
    detectSourceDpi: async (sourcePdfPath, pageNumber, signal) => {
        const paths = getPdfNativeToolPaths();
        const result = await detectSourceDpiDetails(
            sourcePdfPath,
            paths.pdfimages,
            (level, message) => logger[level](message),
            undefined,
            signal,
            [pageNumber],
        );
        return result.pageDpiByNumber.get(pageNumber) ?? result.documentDpi;
    },
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
    dpi = PREVIEW_DPI,
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
        dpi,
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
        dpi,
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

function resolveDetailRenderPolicy(
    request: IScanCleanupPreviewRequest,
    raw: Pick<IRawPreview, 'width' | 'height'>,
    sourceDpi: number,
) {
    const detail = request.detail;
    if (!detail) {
        return {
            renderDpi: PREVIEW_DPI,
            requestedRenderDpi: PREVIEW_DPI,
            renderCrop: undefined,
        };
    }
    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const rotation = pageOverride.rotationDegrees;
    const swapsAxes = rotation === 90 || rotation === 270;
    const margins = resolveScanCleanupMarginsMm(request.options.marginsMm, pageOverride);
    const widthAtPreviewDpi = (swapsAxes ? raw.height : raw.width)
        + (margins.leftMm + margins.rightMm) / 25.4 * PREVIEW_DPI;
    const heightAtPreviewDpi = (swapsAxes ? raw.width : raw.height)
        + (margins.topMm + margins.bottomMm) / 25.4 * PREVIEW_DPI;
    const requestedRenderDpi = detail.outputMode === 'bw'
        ? Math.max(sourceDpi * 2, 600)
        : sourceDpi;
    const widthAtRenderDpi = widthAtPreviewDpi / PREVIEW_DPI * requestedRenderDpi;
    const heightAtRenderDpi = heightAtPreviewDpi / PREVIEW_DPI * requestedRenderDpi;
    const requestedPixels = widthAtRenderDpi
        * heightAtRenderDpi
        * detail.viewport.widthNormalized
        * detail.viewport.heightNormalized;
    const scale = requestedPixels <= detail.maxPixels
        ? 1
        : Math.sqrt(detail.maxPixels * 0.99 / requestedPixels);
    const widthNormalized = detail.viewport.widthNormalized * scale;
    const heightNormalized = detail.viewport.heightNormalized * scale;
    const centerX = detail.viewport.xNormalized + detail.viewport.widthNormalized / 2;
    const centerY = detail.viewport.yNormalized + detail.viewport.heightNormalized / 2;
    return {
        renderDpi: requestedRenderDpi,
        requestedRenderDpi,
        renderCrop: {
            xNormalized: Math.min(1 - widthNormalized, Math.max(0, centerX - widthNormalized / 2)),
            yNormalized: Math.min(1 - heightNormalized, Math.max(0, centerY - heightNormalized / 2)),
            widthNormalized,
            heightNormalized,
            rotationDegrees: pageOverride.rotationDegrees,
        },
    };
}

function readPngDimensions(bytes: Uint8Array, maxPixels = 45_000_000) {
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
    if (width < 1 || height < 1 || width * height > maxPixels) {
        throw new Error(`Scan cleanup preview PNG dimensions ${width}x${height} exceed limits`);
    }
    return {
        width,
        height,
    };
}

async function renderDetailRaster(
    request: Pick<IScanCleanupPreviewRequest, 'sourcePdfPath'>,
    pageNumber: number,
    outputPath: string,
    signal: AbortSignal,
    dependencies: IScanCleanupPreviewDependencies,
    renderDpi: number,
    maxPixels: number,
) {
    await dependencies.renderPage(
        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
        (level, message) => logger[level](message),
        pageNumber,
        request.sourcePdfPath,
        outputPath,
        renderDpi,
        undefined,
        signal,
    );
    const handle = await open(outputPath, 'r');
    try {
        const header = Buffer.alloc(24);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (bytesRead !== header.byteLength) {
            throw new Error('Scan cleanup detail raster produced a truncated PNG');
        }
        return readPngDimensions(header, maxPixels);
    } finally {
        await handle.close();
    }
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
        const baseRaw = await materializeRawRaster(
            request,
            request.pageNumber,
            inputPath,
            signal,
            rawCache,
            dependencies,
        );
        const sourceDpiCandidate = request.detail
            ? await dependencies.detectSourceDpi?.(
                request.sourcePdfPath,
                request.pageNumber,
                signal,
            )
            : null;
        const sourceDpi = sourceDpiCandidate !== null
            && sourceDpiCandidate !== undefined
            && Number.isFinite(sourceDpiCandidate)
            && sourceDpiCandidate > 0
            ? sourceDpiCandidate
            : DEFAULT_SOURCE_DPI;
        const {
            renderDpi,
            requestedRenderDpi,
            renderCrop,
        } = resolveDetailRenderPolicy(request, baseRaw, sourceDpi);
        if (request.detail && renderDpi !== PREVIEW_DPI) {
            const maxSourcePixels = resolveScanCleanupPipelineMaxPixels(request.detail.outputMode);
            const rasterScale = renderDpi / PREVIEW_DPI;
            const detailWidth = Math.ceil(baseRaw.width * rasterScale);
            const detailHeight = Math.ceil(baseRaw.height * rasterScale);
            if (
                detailWidth > 40_000
                || detailHeight > 40_000
                || detailWidth * detailHeight > maxSourcePixels
            ) {
                throw new Error(
                    `Scan cleanup detail raster ${detailWidth}x${detailHeight} exceeds native limits`,
                );
            }
            await renderDetailRaster(
                request,
                request.pageNumber,
                inputPath,
                signal,
                dependencies,
                renderDpi,
                maxSourcePixels,
            );
        }
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
        const documentCanvas = request.detail === undefined && request.options.matchPageSize
            ? request.documentCanvasPlan
            : undefined;
        const effectiveOptions = (documentCanvas === undefined && request.options.matchPageSize)
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
                dpi: renderDpi,
                sourceDpi: request.detail ? sourceDpi : PREVIEW_DPI,
                requestedRenderDpi,
                ...(renderCrop === undefined ? {} : {renderCrop}),
                ...(request.detail === undefined ? {} : {resolvedOutputMode: request.detail.outputMode}),
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
                : Math.max(1, Math.ceil(documentCanvas.widthPoints / 72 * renderDpi));
            const canvasHeightPx = documentCanvas === undefined
                ? null
                : Math.max(1, Math.ceil(documentCanvas.heightPoints / 72 * renderDpi));
            return {
                pageNumber: request.pageNumber,
                totalPages: baseRaw.totalPages,
                rawImageData: baseRaw.bytes,
                rawWidthPx: baseRaw.width,
                rawHeightPx: baseRaw.height,
                pageMetadata: {
                    ...pageMetadata,
                    outputDiagnostics: analyzedOutputs.map(output => ({
                        half: output.half,
                        ...(output.contentDiagnostics === undefined
                            ? {}
                            : {contentDiagnostics: output.contentDiagnostics}),
                    })),
                },
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
                        imageData: baseRaw.bytes,
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
                            sourceDpi: request.detail ? sourceDpi : PREVIEW_DPI,
                            renderDpi,
                            requestedRenderDpi,
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
            totalPages: baseRaw.totalPages,
            rawImageData: baseRaw.bytes,
            rawWidthPx: baseRaw.width,
            rawHeightPx: baseRaw.height,
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
                outputDiagnostics: cleaned.map(output => ({
                    half: output.metadata.half,
                    ...(output.metadata.contentDiagnostics === undefined
                        ? {}
                        : {contentDiagnostics: output.metadata.contentDiagnostics}),
                })),
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

async function runRawPreview(
    request: IScanCleanupRawPreviewRequest,
    signal: AbortSignal,
    rawCache: Map<string, IRawPreview>,
    dependencies: IScanCleanupPreviewDependencies,
): Promise<IScanCleanupRawPreviewResult> {
    if (!isAbsolute(request.sourcePdfPath)) throw new Error('Scan cleanup preview requires an absolute source path');
    if (signal.aborted) throw signal.reason;
    const scratch = await mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-raw-preview-'));
    try {
        const raw = await materializeRawRaster(
            request,
            request.pageNumber,
            join(scratch, 'source.png'),
            signal,
            rawCache,
            dependencies,
        );
        return {
            pageNumber: request.pageNumber,
            totalPages: raw.totalPages,
            rawImageData: raw.bytes,
            rawWidthPx: raw.width,
            rawHeightPx: raw.height,
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
    publish: (results: IScanCleanupDetectionResult[], progress: TScanCleanupProgress) => void,
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
    previewRaw: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupRawPreviewRequest) => Promise<IScanCleanupRawPreviewResult>;
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
    const activeRaw = new Map<string, IRawPreviewEntry>();
    const rawCache = new Map<string, IRawPreview>();
    const detectionJobs = createMainJobRegistry<
        TScanCleanupDetectionJobState,
        IDetectionResult,
        TDetectionError,
        IScanCleanupDetectionSubscriber
    >({
        retention: {
            eventReplayTtlMs: 60_000,
            terminalRecordTtlMs: 60_000,
        },
        toError: (cause, kind) => ({
            code: classifyScanCleanupError(cause, kind === 'canceled'),
            message: getErrorMessage(cause),
        }),
        terminalProgress: {
            completed: (latest, result) => ({
                jobId: latest.jobId,
                status: 'completed',
                progress: {
                    stage: 'detecting',
                    completedUnits: result.results.length,
                    totalUnits: result.results.length,
                    percent: 100,
                    completedPageNumbers: result.results.map(item => item.pageNumber),
                },
                results: result.results,
                ...(result.documentCanvasPlan === undefined
                    ? {}
                    : {documentCanvasPlan: result.documentCanvasPlan}),
                updatedAtMs: Date.now(),
            }),
            canceled: latest => ({
                ...latest,
                status: 'canceled',
                updatedAtMs: Date.now(),
            }),
            failed: (latest, error) => ({
                ...latest,
                status: 'failed',
                error: error.message,
                errorCode: error.code,
                updatedAtMs: Date.now(),
            }),
        },
    });
    const detectionActor = (sender: IScanCleanupDetectionSubscriber, owner: IScanCleanupOwnerContext) => ({
        sender,
        ownerId: owner.ownerId,
        documentRevision: owner.documentRevision,
    });
    const publicDetectionState = (snapshot: TDetectionSnapshot | null) => snapshot?.progress ?? null;
    const subscribeDetection = (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => detectionJobs.subscribe(jobId, detectionActor(sender, owner), snapshot => {
        if (!sender.isDestroyed()) {
            sender.send(
                SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState,
                snapshot.progress,
            );
        }
    });
    return {
        previewRaw(sender, request) {
            const activeKey = `${sender.id}\u0000${request.ownerId}\u0000${request.documentRevision}\u0000${request.sourcePdfPath}`;
            const previous = activeRaw.get(activeKey);
            previous?.controller.abort(new DOMException('Superseded scan cleanup raw preview', 'AbortError'));
            const controller = new AbortController();
            const generation = (previous?.generation ?? 0) + 1;
            const priorTail = previous?.tail.catch(() => undefined) ?? Promise.resolve();
            const tail = priorTail.then(() => runRawPreview(request, controller.signal, rawCache, dependencies));
            activeRaw.set(activeKey, {
                controller,
                generation,
                tail,
            });
            void tail.finally(() => {
                if (activeRaw.get(activeKey)?.generation === generation) activeRaw.delete(activeKey);
            }).catch(() => undefined);
            return tail;
        },
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
            const rawEntry = activeRaw.get(activeKey);
            rawEntry?.controller.abort(new DOMException('Canceled scan cleanup raw preview', 'AbortError'));
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
            return Boolean(entry ?? rawEntry);
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
            detectionJobs.start({
                jobId,
                owner: detectionActor(sender, request),
                operation: {
                    kind: 'abortable-work',
                    workingCopyPath: request.sourcePdfPath,
                },
                initialProgress: {
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
                ownerLifecycle: {
                    destroyed: 'detach',
                    renderProcessGone: 'detach',
                    mainFrameNavigation: 'detach',
                },
                run: async job => {
                    let lease: {release: () => boolean} | null = null;
                    try {
                        const acquire = dependencies.acquireDetectionLease ?? defaultDependencies.acquireDetectionLease!;
                        lease = await acquire(jobId, job.signal);
                        const detection = await runDetection(
                            request,
                            job.signal,
                            rawCache,
                            dependencies,
                            (nextResults, progress) => job.publish({
                                jobId,
                                status: 'running',
                                progress,
                                results: nextResults,
                                updatedAtMs: Date.now(),
                            }),
                        );
                        return {
                            results: detection.results,
                            ...(detection.documentCanvasPlan === undefined
                                ? {}
                                : {documentCanvasPlan: detection.documentCanvasPlan}),
                        };
                    } finally {
                        lease?.release();
                    }
                },
            });
            subscribeDetection(sender, jobId, request);
            return Promise.resolve({
                started: true,
                jobId,
            });
        },
        cancelDetection(sender, jobId, owner) {
            const actor = detectionActor(sender, owner);
            const state = publicDetectionState(detectionJobs.get(jobId, actor));
            if (!state || [
                'completed',
                'failed',
                'canceled',
            ].includes(state.status)) {
                return false;
            }
            return detectionJobs.cancel(jobId, actor, 'Scan cleanup detection canceled');
        },
        getDetectionJobState(sender, jobId, owner) {
            return publicDetectionState(detectionJobs.get(jobId, detectionActor(sender, owner)));
        },
        subscribeDetectionJob(sender, jobId, owner) {
            const actor = detectionActor(sender, owner);
            const unsubscribe = subscribeDetection(sender, jobId, owner);
            const state = publicDetectionState(detectionJobs.get(jobId, actor));
            return unsubscribe ? state : null;
        },
    };
}
