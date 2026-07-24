/* eslint-disable max-lines -- This established service owns one preview lifecycle, including its detail-raster geometry and caches. */
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
    IScanCleanupNormalizedRect,
    IScanCleanupPixelPoint,
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
import type {INativeScanCleanupReusableGeometryV3} from '@contracts/scan-cleanup/nativeProtocolV3';
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
import { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';

const PREVIEW_DPI = 150;
const DETAIL_TILE_MAX_PIXELS = 4_000_000;
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

type INativePreviewOutputMetadata = IScanCleanupPreviewMetadata
    & INativeScanCleanupReusableGeometryV3 & {dewarpModel?: unknown;};

interface IBasePreviewAnalysis {
    sourcePdfPath: string;
    documentRevision: string;
    mtimeMs: number;
    pageMetadata: IScanCleanupPreviewResult['pageMetadata'];
    outputs: Partial<Record<IScanCleanupPreviewMetadata['half'], INativePreviewOutputMetadata>>;
}

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
    materializeWorkingCopy: typeof ensureWorkingCopyMaterialized;
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
        return result.pageDpiByNumber.get(pageNumber) ?? null;
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
    materializeWorkingCopy: ensureWorkingCopyMaterialized,
};

async function materializeScanCleanupPreviewRequest<
    T extends IScanCleanupRawPreviewRequest | IScanCleanupPreviewRequest | IScanCleanupDetectionRequest,
>(
    request: T,
    senderId: number,
    signal: AbortSignal,
    dependencies: IScanCleanupPreviewDependencies,
): Promise<T> {
    const materialized = await dependencies.materializeWorkingCopy(request.sourcePdfPath, {
        ownerWebContentsId: senderId,
        reason: 'scan-cleanup',
        signal,
    });
    return {
        ...request,
        sourcePdfPath: materialized.physicalWorkingCopyPath,
    };
}

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
    signal.throwIfAborted();
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

function baseAnalysisKey(request: Omit<IScanCleanupPreviewRequest, 'detail'>) {
    return JSON.stringify({
        sourcePdfPath: request.sourcePdfPath,
        documentRevision: request.documentRevision,
        pageNumber: request.pageNumber,
        options: request.options,
        documentPrior: request.documentPrior ?? null,
        documentCanvasPlan: request.documentCanvasPlan ?? null,
    });
}

function resolveFallbackDetailDpi(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    raw: Pick<IRawPreview, 'width' | 'height'>,
    sourceDpi: number,
) {
    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const swapsAxes = pageOverride.rotationDegrees === 90 || pageOverride.rotationDegrees === 270;
    const margins = resolveScanCleanupMarginsMm(request.options.marginsMm, pageOverride);
    const widthAtPreviewDpi = (swapsAxes ? raw.height : raw.width)
        + (margins.leftMm + margins.rightMm) / 25.4 * PREVIEW_DPI;
    const heightAtPreviewDpi = (swapsAxes ? raw.width : raw.height)
        + (margins.topMm + margins.bottomMm) / 25.4 * PREVIEW_DPI;
    const canvasWidth = request.options.matchPageSize && request.documentCanvasPlan
        ? request.documentCanvasPlan.widthPoints / 72 * PREVIEW_DPI
        : 0;
    const canvasHeight = request.options.matchPageSize && request.documentCanvasPlan
        ? request.documentCanvasPlan.heightPoints / 72 * PREVIEW_DPI
        : 0;
    const budgetDpi = PREVIEW_DPI * Math.sqrt(
        DETAIL_TILE_MAX_PIXELS
        / (Math.max(1, widthAtPreviewDpi, canvasWidth)
            * Math.max(1, heightAtPreviewDpi, canvasHeight)),
    );
    const requestedRenderDpi = Math.max(sourceDpi, PREVIEW_DPI);
    return {
        renderDpi: Math.max(1, Math.floor(Math.min(requestedRenderDpi, budgetDpi))),
        requestedRenderDpi,
    };
}

function applyPreviewAffine(
    affine: NonNullable<IScanCleanupPreviewMetadata['forwardTransform']>,
    point: IScanCleanupPixelPoint,
) {
    return {
        x: affine.matrix[0]![0]! * point.x
            + affine.matrix[0]![1]! * point.y
            + affine.matrix[0]![2]!,
        y: affine.matrix[1]![0]! * point.x
            + affine.matrix[1]![1]! * point.y
            + affine.matrix[1]![2]!,
    };
}

function interpolateDewarpOutputToSource(
    mapping: NonNullable<INativeScanCleanupReusableGeometryV3['dewarpMapping']>,
    point: IScanCleanupPixelPoint,
) {
    if (
        mapping.columns < 2
        || mapping.rows < 2
        || mapping.outputWidth <= 0
        || mapping.outputHeight <= 0
        || mapping.outputToSource.length !== mapping.columns * mapping.rows
    ) {
        throw new Error('Scan cleanup base preview has an invalid dewarp mapping');
    }
    const gridX = Math.max(0, Math.min(
        mapping.columns - 1,
        point.x / mapping.outputWidth * (mapping.columns - 1),
    ));
    const gridY = Math.max(0, Math.min(
        mapping.rows - 1,
        point.y / mapping.outputHeight * (mapping.rows - 1),
    ));
    const left = Math.floor(gridX);
    const top = Math.floor(gridY);
    const right = Math.min(mapping.columns - 1, left + 1);
    const bottom = Math.min(mapping.rows - 1, top + 1);
    const tx = gridX - left;
    const ty = gridY - top;
    const at = (column: number, row: number) => mapping.outputToSource[row * mapping.columns + column]!;
    const topLeft = at(left, top);
    const topRight = at(right, top);
    const bottomLeft = at(left, bottom);
    const bottomRight = at(right, bottom);
    return {
        x: (topLeft.x * (1 - tx) + topRight.x * tx) * (1 - ty)
            + (bottomLeft.x * (1 - tx) + bottomRight.x * tx) * ty,
        y: (topLeft.y * (1 - tx) + topRight.y * tx) * (1 - ty)
            + (bottomLeft.y * (1 - tx) + bottomRight.y * tx) * ty,
    };
}

function inverseRotatePreviewPoint(
    point: IScanCleanupPixelPoint,
    metadata: Pick<
        IScanCleanupPreviewMetadata,
        'inputWidthPx' | 'inputHeightPx' | 'rotationDegrees'
    >,
) {
    switch (metadata.rotationDegrees) {
        case 90:
            return {
                x: point.y,
                y: metadata.inputHeightPx - point.x,
            };
        case 180:
            return {
                x: metadata.inputWidthPx - point.x,
                y: metadata.inputHeightPx - point.y,
            };
        case 270:
            return {
                x: metadata.inputWidthPx - point.y,
                y: point.x,
            };
        default:
            return point;
    }
}

function mapBaseOutputToRawSource(
    metadata: INativePreviewOutputMetadata,
    point: IScanCleanupPixelPoint,
) {
    const rotated = metadata.inverseTransform
        ? applyPreviewAffine(metadata.inverseTransform, point)
        : metadata.dewarpMapping
            ? interpolateDewarpOutputToSource(metadata.dewarpMapping, point)
            : null;
    if (!rotated) {
        throw new Error('Scan cleanup base preview has no reusable detail geometry');
    }
    return inverseRotatePreviewPoint(rotated, metadata);
}

function resolveBoundedViewport(
    viewport: IScanCleanupNormalizedRect,
    metadata: INativePreviewOutputMetadata,
    renderScale: number,
    maxPixels: number,
) {
    const targetWidth = metadata.outputWidthPx * renderScale;
    const targetHeight = metadata.outputHeightPx * renderScale;
    const requestedPixels = targetWidth
        * targetHeight
        * viewport.widthNormalized
        * viewport.heightNormalized;
    const budgetScale = requestedPixels <= maxPixels
        ? 1
        : Math.sqrt(maxPixels * 0.98 / requestedPixels);
    const widthNormalized = viewport.widthNormalized * budgetScale;
    const heightNormalized = viewport.heightNormalized * budgetScale;
    const centerX = viewport.xNormalized + viewport.widthNormalized / 2;
    const centerY = viewport.yNormalized + viewport.heightNormalized / 2;
    const xNormalized = Math.min(1 - widthNormalized, Math.max(0, centerX - widthNormalized / 2));
    const yNormalized = Math.min(1 - heightNormalized, Math.max(0, centerY - heightNormalized / 2));
    const left = Math.floor(xNormalized * targetWidth);
    const top = Math.floor(yNormalized * targetHeight);
    const right = Math.min(Math.round(targetWidth), Math.ceil((xNormalized + widthNormalized) * targetWidth));
    const bottom = Math.min(Math.round(targetHeight), Math.ceil((yNormalized + heightNormalized) * targetHeight));
    return {
        xPx: left,
        yPx: top,
        widthPx: Math.max(1, right - left),
        heightPx: Math.max(1, bottom - top),
    };
}

function resolveDetailSourceCrop(
    metadata: INativePreviewOutputMetadata,
    sampledRegion: IScanCleanupPreviewMetadata['sourceRegion'],
    renderScale: number,
    fullWidth: number,
    fullHeight: number,
) {
    const baseLeft = sampledRegion.xPx / renderScale;
    const baseTop = sampledRegion.yPx / renderScale;
    const baseRight = (sampledRegion.xPx + sampledRegion.widthPx) / renderScale;
    const baseBottom = (sampledRegion.yPx + sampledRegion.heightPx) / renderScale;
    const xSamples = [
        baseLeft,
        baseRight,
    ];
    const ySamples = [
        baseTop,
        baseBottom,
    ];
    const mapping = metadata.inverseTransform ? null : metadata.dewarpMapping;
    if (mapping) {
        for (let column = 1; column < mapping.columns - 1; column += 1) {
            const x = mapping.outputWidth * column / (mapping.columns - 1);
            if (x > baseLeft && x < baseRight) xSamples.push(x);
        }
        for (let row = 1; row < mapping.rows - 1; row += 1) {
            const y = mapping.outputHeight * row / (mapping.rows - 1);
            if (y > baseTop && y < baseBottom) ySamples.push(y);
        }
    }
    // An affine reaches its extrema at the rectangle corners. A bilinear
    // dewarp cell does too, so including every crossed grid boundary is exact.
    const points = xSamples.flatMap(x => ySamples.map(y => mapBaseOutputToRawSource(metadata, {
        x,
        y,
    })));
    const padding = 24;
    const left = Math.max(0, Math.floor(Math.min(...points.map(point => point.x)) * renderScale) - padding);
    const top = Math.max(0, Math.floor(Math.min(...points.map(point => point.y)) * renderScale) - padding);
    const right = Math.min(
        fullWidth,
        Math.ceil(Math.max(...points.map(point => point.x)) * renderScale) + padding,
    );
    const bottom = Math.min(
        fullHeight,
        Math.ceil(Math.max(...points.map(point => point.y)) * renderScale) + padding,
    );
    if (right <= left || bottom <= top) {
        throw new Error('Scan cleanup detail geometry resolved outside the source page');
    }
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
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
    crop: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
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
        crop,
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

async function runDetailPreview(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    signal: AbortSignal,
    baseRaw: IRawPreview,
    baseRasterPath: string,
    analysis: IBasePreviewAnalysis,
    scratch: string,
    dependencies: IScanCleanupPreviewDependencies,
): Promise<IScanCleanupPreviewResult> {
    const sourceDpiCandidate = await dependencies.detectSourceDpi?.(
        request.sourcePdfPath,
        request.pageNumber,
        signal,
    );
    const sourceDpiDetected = sourceDpiCandidate !== null
        && sourceDpiCandidate !== undefined
        && Number.isFinite(sourceDpiCandidate)
        && sourceDpiCandidate > 0;
    const sourceDpi = sourceDpiDetected ? Number(sourceDpiCandidate) : DEFAULT_SOURCE_DPI;
    const requestedRenderDpi = request.detail.outputMode === 'bw'
        ? sourceDpiDetected ? sourceDpi : Math.max(sourceDpi, 600)
        : Math.max(sourceDpi, PREVIEW_DPI);
    const renderScale = requestedRenderDpi / PREVIEW_DPI;
    const fullSourceWidth = Math.max(1, Math.round(baseRaw.width * renderScale));
    const fullSourceHeight = Math.max(1, Math.round(baseRaw.height * renderScale));
    const maxSourcePixels = resolveScanCleanupPipelineMaxPixels(request.detail.outputMode);
    const binary = dependencies.resolveBinary();
    if (!binary) throw new Error('Scan cleanup native tool is unavailable');

    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const effectiveOptions = request.options.matchPageSize
        ? {
            ...request.options,
            matchPageSize: false,
        }
        : request.options;
    const pageInputs = [];
    const outputFiles: Array<{
        outputPath: string;
        metadataPath: string;
    }> = [];
    for (const half of [
        'full',
        'left',
        'right',
    ] as const) {
        const viewport = request.detail.viewports[half];
        const baseMetadata = analysis.outputs[half];
        if (!viewport || !baseMetadata) continue;
        if (viewport.rotationDegrees !== pageOverride.rotationDegrees) {
            throw new Error('Scan cleanup detail viewport rotation is stale');
        }
        const renderRegion = resolveBoundedViewport(
            viewport,
            baseMetadata,
            renderScale,
            DETAIL_TILE_MAX_PIXELS,
        );
        const outputWidth = Math.max(1, Math.round(baseMetadata.outputWidthPx * renderScale));
        const outputHeight = Math.max(1, Math.round(baseMetadata.outputHeightPx * renderScale));
        const processingApron = request.detail.outputMode === 'bw' || request.detail.outputMode === 'mixed'
            ? 256
            : 8;
        const sampledRegion = {
            xPx: Math.max(0, renderRegion.xPx - processingApron),
            yPx: Math.max(0, renderRegion.yPx - processingApron),
            widthPx: 0,
            heightPx: 0,
        };
        const sampledRight = Math.min(
            outputWidth,
            renderRegion.xPx + renderRegion.widthPx + processingApron,
        );
        const sampledBottom = Math.min(
            outputHeight,
            renderRegion.yPx + renderRegion.heightPx + processingApron,
        );
        sampledRegion.widthPx = sampledRight - sampledRegion.xPx;
        sampledRegion.heightPx = sampledBottom - sampledRegion.yPx;
        const sourceCrop = resolveDetailSourceCrop(
            baseMetadata,
            sampledRegion,
            renderScale,
            fullSourceWidth,
            fullSourceHeight,
        );
        if (
            sourceCrop.width > 40_000
            || sourceCrop.height > 40_000
            || sourceCrop.width * sourceCrop.height > maxSourcePixels
        ) {
            throw new Error(
                `Scan cleanup detail source crop ${sourceCrop.width}x${sourceCrop.height} exceeds native limits`,
            );
        }
        const inputPath = join(scratch, `detail-source-${half}.png`);
        const renderedSource = await renderDetailRaster(
            request,
            request.pageNumber,
            inputPath,
            signal,
            dependencies,
            requestedRenderDpi,
            maxSourcePixels,
            sourceCrop,
        );
        // Poppler clips -W/-H at the physical page edge. The 150-DPI base
        // dimensions can round up by a few scaled pixels, so trust the actual
        // cropped PNG dimensions passed to native.
        sourceCrop.width = renderedSource.width;
        sourceCrop.height = renderedSource.height;
        const baseMetadataPath = join(scratch, `base-metadata-${half}.json`);
        await writeFile(baseMetadataPath, JSON.stringify(baseMetadata));
        const output = {
            outputPath: join(scratch, `detail-clean-${half}.png`),
            metadataPath: join(scratch, `detail-clean-${half}.json`),
        };
        outputFiles.push(output);
        pageInputs.push({
            inputPath,
            pageNumber: request.pageNumber,
            dpi: requestedRenderDpi,
            sourceDpi,
            requestedRenderDpi,
            resolvedOutputMode: request.detail.outputMode,
            pageMetadataPath: join(scratch, `detail-page-${half}.json`),
            outputs: [output],
            detailRenderPlan: {
                baseMetadataPath,
                baseRasterPath,
                sourceCrop: {
                    xPx: sourceCrop.x,
                    yPx: sourceCrop.y,
                    widthPx: sourceCrop.width,
                    heightPx: sourceCrop.height,
                },
                fullSourceWidthPx: fullSourceWidth,
                fullSourceHeightPx: fullSourceHeight,
                scale: renderScale,
                renderRegion,
                sampledRegion,
            },
        });
    }
    if (pageInputs.length === 0) {
        throw new Error('Scan cleanup detail request has no matching base output');
    }
    const manifest = buildNativeScanCleanupManifest({
        operation: 'render',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        options: effectiveOptions,
        experimental: {autoDewarp: false},
        pages: pageInputs,
    });
    const manifestPath = join(scratch, 'detail-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await dependencies.runSidecar(
        binary,
        manifestPath,
        signal,
        (level, message) => logger[level](message),
        () => undefined,
    );
    const cleaned = [] as IScanCleanupPreviewResult['outputs'];
    for (const output of outputFiles) {
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
    }
    return {
        pageNumber: request.pageNumber,
        totalPages: baseRaw.totalPages,
        rawImageData: baseRaw.bytes,
        rawWidthPx: baseRaw.width,
        rawHeightPx: baseRaw.height,
        pageMetadata: analysis.pageMetadata,
        outputs: cleaned,
    };
}

async function runPreview(
    request: IScanCleanupPreviewRequest,
    signal: AbortSignal,
    rawCache: Map<string, IRawPreview>,
    baseAnalysisCache: Map<string, IBasePreviewAnalysis>,
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
        let renderDpi = PREVIEW_DPI;
        let requestedRenderDpi = PREVIEW_DPI;
        let sourceDpi = PREVIEW_DPI;
        let fallbackDetail = false;
        if (request.detail) {
            const {
                detail: _detail,
                ...baseRequest
            } = request;
            const analysis = baseAnalysisCache.get(baseAnalysisKey(baseRequest));
            if (!analysis || analysis.mtimeMs !== baseRaw.mtimeMs) {
                throw new Error('Scan cleanup detail geometry is unavailable; rebuild the base preview');
            }
            const detailRequest = request as IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>;};
            const pageOverride = getScanCleanupPageOverride(
                request.options.pageOverrides,
                request.pageNumber,
            );
            const hasManualZones = (pageOverride.manualZones?.picture.length ?? 0) > 0
                || (pageOverride.manualZones?.fill.length ?? 0) > 0;
            if (request.detail.outputMode !== 'mixed' && !hasManualZones) {
                return await runDetailPreview(
                    detailRequest,
                    signal,
                    baseRaw,
                    inputPath,
                    analysis,
                    scratch,
                    dependencies,
                );
            }
            fallbackDetail = true;
            const sourceDpiCandidate = await dependencies.detectSourceDpi?.(
                request.sourcePdfPath,
                request.pageNumber,
                signal,
            );
            sourceDpi = sourceDpiCandidate !== null
                && sourceDpiCandidate !== undefined
                && Number.isFinite(sourceDpiCandidate)
                && sourceDpiCandidate > 0
                ? sourceDpiCandidate
                : DEFAULT_SOURCE_DPI;
            ({
                renderDpi,
                requestedRenderDpi,
            } = resolveFallbackDetailDpi(detailRequest, baseRaw, sourceDpi));
            if (renderDpi !== PREVIEW_DPI) {
                await materializeRawRaster(
                    request,
                    request.pageNumber,
                    inputPath,
                    signal,
                    rawCache,
                    dependencies,
                    baseRaw.totalPages,
                    renderDpi,
                );
            }
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
        const documentCanvas = (!request.detail || fallbackDetail) && request.options.matchPageSize
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
                sourceDpi,
                requestedRenderDpi,
                ...(request.detail === undefined
                    ? {}
                    : {resolvedOutputMode: request.detail.outputMode}),
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
        const nativeOutputs: IBasePreviewAnalysis['outputs'] = {};
        for (const output of outputs) {
            try {
                const nativeMetadata = JSON.parse(
                    await readFile(output.metadataPath, 'utf8'),
                ) as INativePreviewOutputMetadata;
                nativeOutputs[nativeMetadata.half] = nativeMetadata;
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
        const result: IScanCleanupPreviewResult = {
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
        if (!fallbackDetail) {
            signal.throwIfAborted();
            const analysisKey = baseAnalysisKey(request);
            baseAnalysisCache.delete(analysisKey);
            baseAnalysisCache.set(analysisKey, {
                sourcePdfPath: request.sourcePdfPath,
                documentRevision: request.documentRevision,
                mtimeMs: baseRaw.mtimeMs,
                pageMetadata: result.pageMetadata,
                outputs: nativeOutputs,
            });
            while (baseAnalysisCache.size > RAW_CACHE_PAGE_LIMIT) {
                const oldest = baseAnalysisCache.keys().next().value;
                if (typeof oldest !== 'string') break;
                baseAnalysisCache.delete(oldest);
            }
        }
        return result;
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
    const baseAnalysisCache = new Map<string, IBasePreviewAnalysis>();
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
    const previewOwnerPrefix = (
        sender: IScanCleanupDetectionSubscriber,
        owner: IScanCleanupOwnerContext,
    ) => `${sender.id}\u0000${owner.ownerId}\u0000`;
    const previewDocumentPrefix = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupOwnerContext & {sourcePdfPath: string},
    ) => `${previewOwnerPrefix(sender, request)}${request.documentRevision}\u0000${request.sourcePdfPath}\u0000`;
    const abortStalePreviewEntries = (
        entries: ReadonlyMap<string, {controller: AbortController}>,
        ownerPrefix: string,
        documentPrefix: string,
        message: string,
    ) => {
        for (const [
            key,
            entry,
        ] of entries) {
            if (key.startsWith(ownerPrefix) && !key.startsWith(documentPrefix)) {
                entry.controller.abort(new DOMException(message, 'AbortError'));
            }
        }
    };
    const abortStalePreviewRequests = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupOwnerContext & {sourcePdfPath: string},
    ) => {
        const ownerPrefix = previewOwnerPrefix(sender, request);
        const documentPrefix = previewDocumentPrefix(sender, request);
        abortStalePreviewEntries(
            active,
            ownerPrefix,
            documentPrefix,
            'Stale scan cleanup preview document',
        );
        abortStalePreviewEntries(
            activeRaw,
            ownerPrefix,
            documentPrefix,
            'Stale scan cleanup raw preview document',
        );
        return documentPrefix;
    };
    return {
        previewRaw(sender, request) {
            const documentPrefix = abortStalePreviewRequests(sender, request);
            const activeKey = `${documentPrefix}raw`;
            const previous = activeRaw.get(activeKey);
            previous?.controller.abort(new DOMException('Superseded scan cleanup raw preview', 'AbortError'));
            const controller = new AbortController();
            const generation = (previous?.generation ?? 0) + 1;
            const priorTail = previous?.tail.catch(() => undefined) ?? Promise.resolve();
            const tail = priorTail.then(async () => runRawPreview(
                await materializeScanCleanupPreviewRequest(
                    request,
                    sender.id,
                    controller.signal,
                    dependencies,
                ),
                controller.signal,
                rawCache,
                dependencies,
            ));
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
            // Adjacent base prefetches share the visible base lane so navigation
            // preempts them. Detail tiles have a separate lane and never abort
            // or queue behind the visible base preview.
            const lane = request.detail === undefined ? 'base' : 'detail';
            const documentPrefix = abortStalePreviewRequests(sender, request);
            const activeKey = `${documentPrefix}${lane}`;
            const previous = active.get(activeKey);
            previous?.controller.abort(new DOMException('Superseded scan cleanup preview', 'AbortError'));
            const controller = new AbortController();
            const generation = (previous?.generation ?? 0) + 1;
            const priorTail = previous?.tail.catch(() => undefined) ?? Promise.resolve();
            const tail = priorTail.then(async () => runPreview(
                await materializeScanCleanupPreviewRequest(
                    request,
                    sender.id,
                    controller.signal,
                    dependencies,
                ),
                controller.signal,
                rawCache,
                baseAnalysisCache,
                dependencies,
            ));
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
            const documentPrefix = previewDocumentPrefix(sender, request);
            let canceled = false;
            for (const [
                key,
                entry,
            ] of active) {
                if (key.startsWith(documentPrefix)) {
                    entry.controller.abort(new DOMException('Canceled scan cleanup preview', 'AbortError'));
                    canceled = true;
                }
            }
            for (const [
                key,
                entry,
            ] of activeRaw) {
                if (key.startsWith(documentPrefix)) {
                    entry.controller.abort(new DOMException('Canceled scan cleanup raw preview', 'AbortError'));
                    canceled = true;
                }
            }
            if (request.invalidateRawCache !== false) {
                for (const [
                    key,
                    raw,
                ] of rawCache) {
                    if (raw.sourcePdfPath === request.sourcePdfPath && raw.documentRevision === request.documentRevision) {
                        rawCache.delete(key);
                    }
                }
                for (const [
                    key,
                    analysis,
                ] of baseAnalysisCache) {
                    if (
                        analysis.sourcePdfPath === request.sourcePdfPath
                        && analysis.documentRevision === request.documentRevision
                    ) {
                        baseAnalysisCache.delete(key);
                    }
                }
            }
            return canceled;
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
                        const materializedRequest = await materializeScanCleanupPreviewRequest(
                            request,
                            sender.id,
                            job.signal,
                            dependencies,
                        );
                        const detection = await runDetection(
                            materializedRequest,
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
