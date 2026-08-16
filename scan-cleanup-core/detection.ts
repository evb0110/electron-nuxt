import {
    open,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupDetectionResult,
    IScanCleanupPagePlanEvidence,
    TScanCleanupProgress,
} from '@contracts/electronApiScanCleanup';
import type {
    INativeScanCleanupAnalysisOutputV3,
    INativeScanCleanupPageMetadataV3,
    TNativeScanCleanupProgressV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {decodeNativeScanCleanupPageMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {getErrorMessage} from '@contracts/getErrorMessage';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {buildNativeScanCleanupManifest} from '@scan-cleanup-core/policy/buildNativeScanCleanupManifest';
import {ScanCleanupNativeToolUnavailableError} from '@scan-cleanup-core/errors';
import {preserveScanCleanupJsonEvidence} from '@scan-cleanup-core/preserveScanCleanupJsonEvidence';
import {
    detectSourceDpiFromPageSizes,
    type IPdfPageSize,
    type IScanCleanupRasterRenderLimits,
    type TScanCleanupLog,
    type TScanCleanupRenderPage,
    type TScanCleanupRunSidecar,
} from '@scan-cleanup-core/types';
import {readPpmDimensions} from '@scan-cleanup-core/rasterLayerDimensions';
import {createScanCleanupScratchDir} from '@scan-cleanup-core/scratchCleanup';
import {SCAN_CLEANUP_MAX_DIMENSION_PX} from '@scan-cleanup-core/policy/effectiveOptions';
import {
    readAvailableScratchBytes,
    resolveRasterHandoff,
} from '@scan-cleanup-core/resolveRasterHandoff';
import {
    resolveScanCleanupProvisionalDocumentCanvas,
    scanCleanupDocumentCanvasSignature,
} from '@scan-cleanup-core/policy/documentCanvas';

export const DETECTION_DPI = 150;
export const PREVIEW_DPI = DETECTION_DPI;
// Native mode selection, preview, and final rendering share this canonical
// analysis grid. The separate working raster remains free to follow source DPI.
const BASE_PREVIEW_MAX_PIXELS = 4_000_000;
const PREVIEW_MAX_IMAGE_PIXELS = 45_000_000;

/**
 * Binary cleanup needs the source's stroke samples even though the UI presents
 * the result on the smaller preview canvas. Thresholding the already reduced
 * 150-DPI raster loses subpixel stroke evidence and makes neighboring words
 * alternate between heavy and light. Native therefore cleans binary-capable
 * previews at up to 2x the display DPI; the renderer's ordinary placement
 * downsample is the same final step used when a 300-DPI conversion is viewed.
 * Tonal previews keep the inexpensive display grid because they do not
 * threshold those samples.
 */
export function resolvePreviewProcessingDpi({
    displayDpi,
    outputMode,
    sourceDpi,
}: {
    displayDpi: number;
    outputMode: 'bw' | 'color' | 'grayscale' | 'mixed' | undefined;
    sourceDpi: number;
}) {
    const binaryCapable = outputMode === undefined || outputMode === 'bw' || outputMode === 'mixed';
    if (!binaryCapable) {
        return displayDpi;
    }
    return Math.max(displayDpi, Math.floor(Math.min(sourceDpi, displayDpi * 2)));
}

function sumByteFootprint(values: Iterable<number>) {
    let total = 0;
    for (const value of values) {
        if (!Number.isSafeInteger(value) || value < 0) {
            return null;
        }
        total += value;
        if (!Number.isSafeInteger(total)) {
            return null;
        }
    }
    return total;
}

function resolveRasterRenderLimits(
    pageSize: IPdfPageSize | undefined,
    dpi: number,
    maxPixels = PREVIEW_MAX_IMAGE_PIXELS,
    crop?: {
        width: number;
        height: number;
    },
): IScanCleanupRasterRenderLimits {
    if (pageSize === undefined) {
        const scaleToFitPx = Math.max(1, Math.floor(Math.sqrt(maxPixels)));
        return {
            expectedWidthPx: scaleToFitPx,
            expectedHeightPx: scaleToFitPx,
            maxPixels,
            maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
            scaleToFitPx,
        };
    }
    const swapsAxes = Math.abs(Math.round(pageSize.rotation / 90)) % 2 === 1;
    return {
        expectedWidthPx: crop?.width ?? Math.max(1, Math.ceil(
            (swapsAxes ? pageSize.heightPoints : pageSize.widthPoints) * dpi / 72,
        )),
        expectedHeightPx: crop?.height ?? Math.max(1, Math.ceil(
            (swapsAxes ? pageSize.widthPoints : pageSize.heightPoints) * dpi / 72,
        )),
        maxPixels,
        maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
    };
}

export function resolvePagePreviewDpi(
    pageSize: IPdfPageSize,
    requestedDpi: number,
) {
    const pageAreaPoints = pageSize.widthPoints * pageSize.heightPoints;
    if (!Number.isFinite(pageAreaPoints) || pageAreaPoints <= 0) {
        return requestedDpi;
    }
    const pixelBoundDpi = 72 * Math.sqrt(BASE_PREVIEW_MAX_PIXELS / pageAreaPoints);
    return Math.max(1, Math.floor(Math.min(requestedDpi, pixelBoundDpi)));
}

export function resolvePreviewRasterPlan(
    pageSizes: readonly IPdfPageSize[] | null,
    sourceDpiByPage: ReadonlyMap<number, number> = new Map(),
) {
    const detected = pageSizes === null ? null : detectSourceDpiFromPageSizes(pageSizes);
    const pageDpiByNumber = new Map(detected?.pageDpiByNumber ?? []);
    let documentDpi = detected?.documentDpi ?? 0;
    for (const [
        pageNumber,
        sourceDpi,
    ] of sourceDpiByPage) {
        if (!Number.isFinite(sourceDpi) || sourceDpi <= 0) continue;
        pageDpiByNumber.set(pageNumber, Math.max(pageDpiByNumber.get(pageNumber) ?? 0, sourceDpi));
        documentDpi = Math.max(documentDpi, sourceDpi);
    }
    documentDpi = documentDpi > 0 ? documentDpi : PREVIEW_DPI;
    const dpi = Math.min(PREVIEW_DPI, documentDpi);
    const renderDpiByPageNumber = new Map<number, number>();
    for (const pageSize of pageSizes ?? []) {
        const sourceDpi = pageDpiByNumber.get(pageSize.pageNumber);
        const requestedDpi = Math.min(PREVIEW_DPI, sourceDpi ?? dpi);
        const renderDpi = resolvePagePreviewDpi(pageSize, requestedDpi);
        renderDpiByPageNumber.set(pageSize.pageNumber, renderDpi);
    }
    return {
        dpi,
        pageDpiByNumber,
        renderDpiByPageNumber,
    };
}

/**
 * Where the document keeps its own pixels. `detected` is false when pdfimages
 * is unavailable, which means every page has to be treated as one that carries
 * a raster: there is no evidence that it does not.
 */
export interface IScanCleanupDocumentRasterPages {
    detected: boolean;
    pages: ReadonlySet<number>;
    sourceDpiByPage?: ReadonlyMap<number, number>;
    bilevelLayerPages?: ReadonlySet<number>;
    dominantBilevelLayerPages?: ReadonlySet<number>;
    backgroundDpiByPage?: ReadonlyMap<number, number>;
}

export interface IScanCleanupRetainedRaster {
    dpi: number;
    height: number;
    pageNumber: number;
    path: string;
    sizeBytes: number;
    width: number;
}

export interface IScanCleanupRetainedRasterInput<TDocument> {
    document: TDocument;
    dpi: number;
    height: number;
    pageNumber: number;
    scratchPath: string;
    sizeBytes: number;
    width: number;
}

export interface IScanCleanupDetectionRetention<TDocument> {
    openDocument: (
        request: Pick<IScanCleanupDetectionRequest, 'sourcePdfPath' | 'documentRevision'>,
    ) => Promise<TDocument>;
    pageCount: (document: TDocument, signal: AbortSignal) => Promise<number>;
    pageSizes: (document: TDocument, signal: AbortSignal) => Promise<IPdfPageSize[]>;
    rasterPages: (
        document: TDocument,
        signal: AbortSignal,
    ) => Promise<IScanCleanupDocumentRasterPages>;
    retainedPaths: (
        document: TDocument,
        pageNumbers: readonly number[],
        dpi: number,
    ) => Promise<Map<number, IScanCleanupRetainedRaster>>;
    rasterScratchPath: (
        document: TDocument,
        pageNumber: number,
        dpi: number,
    ) => Promise<string>;
    retain: (
        rendered: IScanCleanupRetainedRasterInput<TDocument>,
    ) => Promise<IScanCleanupRetainedRaster>;
    release: (document: TDocument) => Promise<void>;
}

export interface IScanCleanupDetectionDependencies {
    getTempDir: () => string;
    /**
     * Testable override for the filesystem-space probe used by the non-stream
     * fallback.  On Windows the complete detection manifest is retained before
     * native starts reading it, so it must fit the same scratch budget as the
     * retained-raster cache.
     */
    getAvailableScratchBytes?: typeof readAvailableScratchBytes;
    getPdftoppmBinary: () => string;
    resolveBinary: () => string | null;
    renderPage: TScanCleanupRenderPage;
    renderPagePpm: TScanCleanupRenderPage;
    createRasterPipes?: (
        paths: readonly string[],
        signal: AbortSignal,
        log: TScanCleanupLog,
    ) => Promise<void>;
    runSidecar: TScanCleanupRunSidecar;
}

function readPngDimensions(bytes: Uint8Array, maxPixels = PREVIEW_MAX_IMAGE_PIXELS) {
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
        throw new Error('Scan cleanup detection produced an invalid PNG');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width < 1 || height < 1 || width * height > maxPixels) {
        throw new Error(`Scan cleanup detection PNG dimensions ${width}x${height} exceed limits`);
    }
    return {
        width,
        height,
    };
}

async function renderRasterToDisk(
    sourcePdfPath: string,
    pageNumber: number,
    outputPath: string,
    signal: AbortSignal,
    dependencies: IScanCleanupDetectionDependencies,
    log: TScanCleanupLog,
    renderDpi: number,
    maxPixels?: number,
    crop?: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
    format: 'png' | 'ppm' = 'png',
    limits?: IScanCleanupRasterRenderLimits,
) {
    await (format === 'ppm' ? dependencies.renderPagePpm : dependencies.renderPage)(
        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
        log,
        pageNumber,
        sourcePdfPath,
        outputPath,
        renderDpi,
        undefined,
        signal,
        crop,
        limits,
    );
    if (format === 'ppm') {
        const dimensions = await readPpmDimensions(outputPath);
        if (
            (maxPixels !== undefined && dimensions.width * dimensions.height > maxPixels)
            || (
                limits !== undefined
                && (
                    dimensions.width > limits.maxDimensionPx
                    || dimensions.height > limits.maxDimensionPx
                    || dimensions.width * dimensions.height > limits.maxPixels
                )
            )
        ) {
            throw new Error(
                `Scan cleanup detection raster dimensions ${dimensions.width}x${dimensions.height} exceed limits`,
            );
        }
        return dimensions;
    }
    const handle = await open(outputPath, 'r');
    try {
        const header = Buffer.alloc(24);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (bytesRead !== header.byteLength) {
            throw new Error('Scan cleanup detection raster produced a truncated PNG');
        }
        return readPngDimensions(header, maxPixels);
    } finally {
        await handle.close();
    }
}

async function mapDetectionPages<T>(
    pages: readonly number[],
    task: (pageNumber: number) => Promise<T>,
    onCompleted: ((pageNumber: number, completedPages: number) => void) | undefined,
    concurrency: number,
) {
    const results = new Array<T>(pages.length);
    let nextIndex = 0;
    let completedPages = 0;
    const workers = Array.from({length: Math.min(concurrency, pages.length)}, async () => {
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

function normalizeDetectionContentBox(
    output: INativeScanCleanupAnalysisOutputV3,
    rotationDegrees: IScanCleanupPagePlanEvidence['rotationDegrees'],
) {
    const contentBox = output.contentBox;
    if (
        contentBox === null
        || contentBox === undefined
        || output.inputWidthPx <= 0
        || output.inputHeightPx <= 0
        || output.sourceRegion.widthPx <= 0
        || output.sourceRegion.heightPx <= 0
    ) {
        return undefined;
    }
    const analysisWidth = rotationDegrees === 90 || rotationDegrees === 270
        ? output.inputHeightPx
        : output.inputWidthPx;
    const analysisHeight = rotationDegrees === 90 || rotationDegrees === 270
        ? output.inputWidthPx
        : output.inputHeightPx;
    const left = Math.max(0, Math.min(output.sourceRegion.widthPx, contentBox.xPx));
    const top = Math.max(0, Math.min(output.sourceRegion.heightPx, contentBox.yPx));
    const right = Math.max(
        left,
        Math.min(output.sourceRegion.widthPx, contentBox.xPx + contentBox.widthPx),
    );
    const bottom = Math.max(
        top,
        Math.min(output.sourceRegion.heightPx, contentBox.yPx + contentBox.heightPx),
    );
    if (right <= left || bottom <= top) {
        return undefined;
    }
    // Content coordinates are local to the output half, while their scale is
    // the complete rotated analysis page. Normalize the two edges first and
    // derive the extent from them so a box ending at the page edge serializes
    // exactly as `1 - start` for the manifest validator.
    const leftNormalized = left / analysisWidth;
    const topNormalized = top / analysisHeight;
    const rightNormalized = right === analysisWidth ? 1 : right / analysisWidth;
    const bottomNormalized = bottom === analysisHeight ? 1 : bottom / analysisHeight;
    return {
        xNormalized: leftNormalized,
        yNormalized: topNormalized,
        widthNormalized: rightNormalized - leftNormalized,
        heightNormalized: bottomNormalized - topNormalized,
        rotationDegrees,
    };
}

function createDetectionPagePlanEvidence(
    result: IScanCleanupDetectionResult,
    metadata: INativeScanCleanupPageMetadataV3,
    includeContentBoxes: boolean,
): IScanCleanupPagePlanEvidence {
    const rotationDegrees = metadata.rotationDegrees;
    const firstOutput = metadata.outputs?.[0];
    const analysisWidth = firstOutput === undefined
        ? 0
        : rotationDegrees === 90 || rotationDegrees === 270
            ? firstOutput.inputHeightPx
            : firstOutput.inputWidthPx;
    const splitXNormalized = result.cutterXPx === null || analysisWidth <= 0
        ? undefined
        : result.cutterXPx / analysisWidth;
    const automaticSplit = splitXNormalized === undefined
        || splitXNormalized <= 0
        || splitXNormalized >= 1
        ? undefined
        : {
            xNormalized: splitXNormalized,
            rotationDegrees,
        };
    const outputs: IScanCleanupPagePlanEvidence['outputs'] = {};
    for (const output of metadata.outputs ?? []) {
        const contentBox = includeContentBoxes
            ? normalizeDetectionContentBox(output, rotationDegrees)
            : undefined;
        if (contentBox === undefined && output.textToneDiagnostics === undefined) {
            continue;
        }
        outputs[output.half] = {
            ...(contentBox === undefined ? {} : {contentBox}),
            ...(output.textToneDiagnostics === undefined
                ? {}
                : {textToneDiagnostics: output.textToneDiagnostics}),
        };
    }
    return {
        pageNumber: result.pageNumber,
        rotationDegrees,
        layoutClassification: result.classification,
        ...(automaticSplit === undefined ? {} : {automaticSplit}),
        outputs,
    };
}

export async function runScanCleanupDetection<TDocument>(
    request: IScanCleanupDetectionRequest,
    signal: AbortSignal,
    retention: IScanCleanupDetectionRetention<TDocument>,
    dependencies: IScanCleanupDetectionDependencies,
    policy: Pick<IScanCleanupRuntimePolicy, 'rasterConcurrency'>,
    publish: (
        results: IScanCleanupDetectionResult[],
        progress: TScanCleanupProgress,
        documentCanvasSignature: string,
    ) => void,
    log: TScanCleanupLog = () => undefined,
) {
    // The document opens first: a scratch directory created before it has
    // nothing to release if opening throws, and only this function removes it.
    const document = await retention.openDocument(request);
    let scratchDir: string | null = null;
    try {
        const scratch = await createScanCleanupScratchDir(
            dependencies.getTempDir(),
            'scan-cleanup-detect-',
        );
        scratchDir = scratch;
        const totalPages = await retention.pageCount(document, signal);
        const pageNumbers = Array.from({length: totalPages}, (_, index) => index + 1);
        const pageSizes = await retention.pageSizes(document, signal);
        const pageSizeByNumber = new Map(pageSizes.map(page => [
            page.pageNumber,
            page,
        ]));
        const sourceRasterStructure = await retention.rasterPages(document, signal);
        const previewRasterPlan = resolvePreviewRasterPlan(
            pageSizes,
            sourceRasterStructure.sourceDpiByPage,
        );
        const matchedPreviewDpis = [...previewRasterPlan.renderDpiByPageNumber.values()];
        const matchedPreviewDpi = matchedPreviewDpis.length > 0
            ? Math.min(...matchedPreviewDpis)
            : previewRasterPlan.dpi;
        const baselineCanvasSignature = scanCleanupDocumentCanvasSignature(
            request.options.matchPageSize
                ? resolveScanCleanupProvisionalDocumentCanvas(
                    pageSizes,
                    matchedPreviewDpi,
                    request.options,
                )
                : null,
        );
        const detectionDpiForPage = (_pageNumber: number) => DETECTION_DPI;
        const results = new Map<number, IScanCleanupDetectionResult>();
        const publishedResults = () => [...results.values()]
            .sort((left, right) => left.pageNumber - right.pageNumber);
        const documentCanvasSignature = (layoutEvidenceComplete = false) => {
            if (!request.options.matchPageSize) {
                return '';
            }
            const layoutByPage = Object.fromEntries([...results].map(([
                pageNumber,
                result,
            ]) => [
                String(pageNumber),
                result.classification,
            ]));
            const signature = scanCleanupDocumentCanvasSignature(resolveScanCleanupProvisionalDocumentCanvas(
                pageSizes,
                matchedPreviewDpi,
                request.options,
                layoutByPage,
                layoutEvidenceComplete,
            ));
            // The first preview is already measured against the unclassified
            // document. Preserve that identity until the resolved plan truly
            // moves, instead of restarting it when detection merely announces
            // the same full-sheet rectangle.
            return signature === baselineCanvasSignature ? '' : signature;
        };
        let analyzedPages = 0;
        const completedPages = new Set<number>();
        const retained = new Map<number, IScanCleanupRetainedRaster>();
        const pagesByDpi = new Map<number, number[]>();
        for (const pageNumber of pageNumbers) {
            const dpi = detectionDpiForPage(pageNumber);
            const group = pagesByDpi.get(dpi) ?? [];
            group.push(pageNumber);
            pagesByDpi.set(dpi, group);
        }
        for (const [
            dpi,
            pages,
        ] of pagesByDpi) {
            for (const [
                pageNumber,
                raster,
            ] of await retention.retainedPaths(document, pages, dpi)) {
                retained.set(pageNumber, raster);
            }
        }
        const rasterScope = pageNumbers.filter(pageNumber => !retained.has(pageNumber));
        if (pageNumbers.length > 0) {
            // Detection always stages replayable PNGs before native starts. The
            // complete manifest must fit the same scratch budget as retained
            // cache entries; no FIFO transport can bypass this admission check.
            const handoff = await resolveRasterHandoff(
                rasterScope.map(pageNumber => {
                    const pageSize = pageSizeByNumber.get(pageNumber)!;
                    const dpi = detectionDpiForPage(pageNumber);
                    const limits = resolveRasterRenderLimits(pageSize, dpi);
                    return {
                        renderDpi: dpi,
                        raster: {
                            dpi,
                            width: limits.expectedWidthPx,
                            height: limits.expectedHeightPx,
                        },
                    };
                }),
                scratch,
                dependencies.getAvailableScratchBytes ?? readAvailableScratchBytes,
            );
            const retainedBytes = sumByteFootprint(
                [...retained.values()].map(raster => raster.sizeBytes),
            );
            const manifestBytes = handoff.estimatedBytes === null || retainedBytes === null
                ? null
                : sumByteFootprint([
                    retainedBytes,
                    handoff.estimatedBytes,
                ]);
            if (
                manifestBytes === null
                || handoff.budgetBytes === null
                || manifestBytes > handoff.budgetBytes
            ) {
                throw new Error(
                    'Scan cleanup detection cannot stage this document without exceeding the raster cache/scratch budget',
                );
            }
        }
        const rasterizedPageNumbers = new Set<number>(retained.keys());
        const publishRasterizing = () => publish([], {
            stage: 'rasterizing',
            completedUnits: rasterizedPageNumbers.size,
            totalUnits: totalPages,
            percent: totalPages === 0 ? 100 : rasterizedPageNumbers.size / totalPages * 100,
            completedPageNumbers: [...rasterizedPageNumbers],
        }, documentCanvasSignature());
        publishRasterizing();
        const renderedPaths = new Map<number, string>();
        const rasterize = async (operationSignal: AbortSignal) => {
            await mapDetectionPages(rasterScope, async pageNumber => {
                operationSignal.throwIfAborted();
                const pageDpi = detectionDpiForPage(pageNumber);
                const scratchPath = await retention.rasterScratchPath(document, pageNumber, pageDpi);
                const dimensions = await renderRasterToDisk(
                    request.sourcePdfPath,
                    pageNumber,
                    scratchPath,
                    operationSignal,
                    dependencies,
                    log,
                    pageDpi,
                    undefined,
                    undefined,
                    'png',
                    resolveRasterRenderLimits(pageSizeByNumber.get(pageNumber), pageDpi),
                );
                const raster = await retention.retain({
                    document,
                    dpi: pageDpi,
                    height: dimensions.height,
                    pageNumber,
                    scratchPath,
                    sizeBytes: (await stat(scratchPath)).size,
                    width: dimensions.width,
                });
                renderedPaths.set(pageNumber, raster.path);
            }, pageNumber => {
                rasterizedPageNumbers.add(pageNumber);
                // Once classifications are arriving, publishing raster progress
                // would replace them with an older-stage empty snapshot.
                if (results.size === 0) publishRasterizing();
            }, policy.rasterConcurrency);
        };
        await rasterize(signal);
        const manifestPages = pageNumbers.map(pageNumber => {
            const sourceBackgroundDpi = sourceRasterStructure.backgroundDpiByPage?.get(pageNumber);
            return {
                inputPath: renderedPaths.get(pageNumber) ?? retained.get(pageNumber)!.path,
                pageNumber,
                dpi: detectionDpiForPage(pageNumber),
                sourceDpi: previewRasterPlan.pageDpiByNumber.get(pageNumber)
                    ?? detectionDpiForPage(pageNumber),
                sourceHasBilevelLayer: sourceRasterStructure.bilevelLayerPages
                    ?.has(pageNumber) ?? false,
                ...(sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi}),
                pageMetadataPath: join(scratch, `page-${pageNumber}.json`),
            };
        });
        signal.throwIfAborted();
        // Every page stays in one replayable manifest because final
        // reconciliation clusters the document's independent verdicts.
        const manifestPath = join(scratch, 'classify-manifest.json');
        await writeFile(manifestPath, JSON.stringify(buildNativeScanCleanupManifest({
            operation: 'analyze',
            analysisPurpose: 'page-plan',
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
            // Detection classifies rasters the preview retention rendered
            // into its own document directory, a sibling of this scratch:
            // the temp root is the narrowest root that holds them both.
            allowedPathRoot: dependencies.getTempDir(),
        })));
        const binary = dependencies.resolveBinary();
        if (!binary) throw new ScanCleanupNativeToolUnavailableError('evb-scan-cleanup');
        const recordResult = (nativeProgress: TNativeScanCleanupProgressV3) => {
            if (
                nativeProgress.pageNumber === undefined
                || nativeProgress.classification === undefined
                || nativeProgress.confidence === undefined
            ) {
                return false;
            }
            const sourcePage = pageSizes?.[nativeProgress.pageNumber - 1];
            const sourceDpi = previewRasterPlan.pageDpiByNumber.get(nativeProgress.pageNumber);
            const revision = (results.get(nativeProgress.pageNumber)?.revision ?? 0) + 1;
            results.set(nativeProgress.pageNumber, {
                pageNumber: nativeProgress.pageNumber,
                revision,
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
                ...(nativeProgress.softAlphaForegroundRecommendation === undefined
                    ? {}
                    : {softAlphaForegroundRecommendation: nativeProgress.softAlphaForegroundRecommendation}),
                ...(nativeProgress.outputModeDiagnostics === undefined
                    ? {}
                    : {outputModeDiagnostics: nativeProgress.outputModeDiagnostics}),
                ...(sourcePage === undefined || sourceDpi === undefined
                    ? {}
                    : {sourcePageMetadata: {
                        ...sourcePage,
                        sourceDpi,
                    }}),
            });
            return true;
        };
        const runAnalysis = (operationSignal: AbortSignal) => dependencies.runSidecar(
            binary,
            manifestPath,
            operationSignal,
            log,
            (progress, nativeProgress) => {
                if (nativeProgress.stage === 'page-analyzed') {
                    analyzedPages = Math.max(analyzedPages, progress.completedUnits);
                    recordResult(nativeProgress);
                    publish(publishedResults(), {
                        ...progress,
                        stage: 'detecting',
                        completedUnits: analyzedPages,
                        percent: progress.totalUnits === 0 ? 100 : analyzedPages / progress.totalUnits * 100,
                    }, documentCanvasSignature());
                    return;
                }
                if (nativeProgress.stage !== 'page-complete' || !recordResult(nativeProgress)) {
                    return;
                }
                if (nativeProgress.pageNumber !== undefined) {
                    completedPages.add(nativeProgress.pageNumber);
                }
                const completedUnits = Math.max(analyzedPages, progress.completedUnits);
                publish(publishedResults(), {
                    ...progress,
                    stage: 'detecting',
                    completedUnits,
                    percent: progress.totalUnits === 0 ? 100 : completedUnits / progress.totalUnits * 100,
                }, documentCanvasSignature(completedPages.size === totalPages));
            },
            {priority: 'background'},
        );
        await runAnalysis(signal);
        for (const page of manifestPages) {
            const result = results.get(page.pageNumber);
            if (!result) continue;
            const metadata = decodeNativeScanCleanupPageMetadataJson(
                await readFile(page.pageMetadataPath, 'utf8'),
            );
            result.pagePlanEvidence = createDetectionPagePlanEvidence(
                result,
                metadata,
                request.options.autoDewarp !== true,
            );
            if (metadata.splitDiagnostics !== undefined) {
                result.splitDiagnostics = metadata.splitDiagnostics;
            }
        }
        if (results.size !== totalPages) {
            throw new Error(`evb-scan-cleanup returned ${results.size} classifications for ${totalPages} pages`);
        }
        return {results: publishedResults()};
    } finally {
        await retention.release(document);
        if (scratchDir !== null) {
            await preserveScanCleanupJsonEvidence(scratchDir, log).catch(error => {
                log(
                    'warn',
                    `Could not preserve scan-cleanup detection evidence: ${getErrorMessage(error)}`,
                );
            });
            await rm(scratchDir, {
                recursive: true,
                force: true,
            });
        }
    }
}
