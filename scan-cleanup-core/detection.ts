import {
    mkdir,
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
import {SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW} from '@contracts/scan-cleanup/stagedInputWindow';
import {buildRunnableNativeScanCleanupManifest} from '@scan-cleanup-core/policy/buildNativeScanCleanupManifest';
import {
    ScanCleanupContractError,
    ScanCleanupInsufficientScratchError,
    ScanCleanupNativeToolUnavailableError,
} from '@scan-cleanup-core/errors';
import {preserveScanCleanupJsonEvidence} from '@scan-cleanup-core/preserveScanCleanupJsonEvidence';
import {
    assertCanonicalPdfPageSizes,
    detectSourceDpiFromPageSizes,
    type IDetectedPageRaster,
    type IPdfPageSize,
    type TScanCleanupLog,
    type TScanCleanupRenderPage,
    type TScanCleanupRunSidecar,
} from '@scan-cleanup-core/types';
import {createScanCleanupScratchDir} from '@scan-cleanup-core/scratchCleanup';
import {
    readAvailableScratchBytes,
    resolveStagedRasterWindow,
} from '@scan-cleanup-core/resolveRasterHandoff';
import {createStagedRasterWindow} from '@scan-cleanup-core/createStagedRasterWindow';
import {
    renderScanCleanupRasterToDisk as renderRasterToDisk,
    resolveScanCleanupRasterRenderLimits as resolveRasterRenderLimits,
} from '@scan-cleanup-core/rasterValidation';
import {
    resolveScanCleanupProvisionalDocumentCanvas,
    scanCleanupDocumentCanvasSignature,
} from '@scan-cleanup-core/policy/documentCanvas';
import {
    isCropBoxOrientationMismatch,
    isMateriallySmallerCropBox,
    toCropBoxPageSize,
    toMediaBoxPageSize,
} from '@scan-cleanup-core/pdfPageSizes';

export const DETECTION_DPI = 150;
export const PREVIEW_DPI = DETECTION_DPI;
// Native mode selection, preview, and final rendering share this canonical
// analysis grid. The separate working raster remains free to follow source DPI.
const BASE_PREVIEW_MAX_PIXELS = 4_000_000;
const MAX_MEDIA_BOX_RETRY_PAGES = 16;
const MEDIA_BOX_RETRY_MIN_CONFIDENCE = 0.75;

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

export function createScanCleanupDocumentRasterPages(
    detected: boolean,
    pageRasterByNumber: ReadonlyMap<number, IDetectedPageRaster>,
): IScanCleanupDocumentRasterPages {
    return {
        detected,
        pages: new Set(pageRasterByNumber.keys()),
        sourceDpiByPage: new Map(
            [...pageRasterByNumber].map(([
                pageNumber,
                raster,
            ]) => [
                pageNumber,
                raster.dpi,
            ] as const),
        ),
        bilevelLayerPages: new Set(
            [...pageRasterByNumber]
                .filter(([
                    , raster,
                ]) => raster.hasBilevelLayer)
                .map(([pageNumber]) => pageNumber),
        ),
        dominantBilevelLayerPages: new Set(
            [...pageRasterByNumber]
                .filter(([
                    , raster,
                ]) => raster.hasDominantBilevelLayer)
                .map(([pageNumber]) => pageNumber),
        ),
        backgroundDpiByPage: new Map(
            [...pageRasterByNumber].flatMap(([
                pageNumber,
                raster,
            ]) =>
                raster.backgroundDpi === undefined
                    ? []
                    : [[
                        pageNumber,
                        raster.backgroundDpi,
                    ] as const],
            ),
        ),
    };
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
    /**
     * Where `retain` will publish this page's raster, before it is rendered.
     *
     * Detection writes the Analyze manifest before it stages a single page, so
     * it has to name each input up front. The path is a function of the
     * document, the page and the DPI alone, which is also why re-rendering a
     * released page republishes exactly the same file.
     */
    stagedRasterPath: (
        document: TDocument,
        pageNumber: number,
        dpi: number,
    ) => Promise<string>;
    retain: (
        rendered: IScanCleanupRetainedRasterInput<TDocument>,
    ) => Promise<IScanCleanupRetainedRaster>;
    /**
     * Drop one staged raster and its cache entry. The bounded window calls this
     * when it needs the slot back and when a failed run rolls its staging back,
     * so a page released here must be re-renderable at the same path.
     */
    releaseRaster: (
        document: TDocument,
        pageNumber: number,
        dpi: number,
    ) => Promise<void>;
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

/**
 * MediaBox retries are deliberately content-gated. An undersized CropBox is
 * common in hand-authored PDFs, so area alone may never start another native
 * process. The portrait mismatch is the one metadata-only exception because
 * it cannot be an intentional crop of a dominant landscape document.
 */
export function shouldRetryMediaBoxPage(
    page: IPdfPageSize,
    result: IScanCleanupDetectionResult,
) {
    if (!isMateriallySmallerCropBox(page)) {
        return false;
    }
    if (isCropBoxOrientationMismatch(page)) {
        return true;
    }
    const diagnostics = result.splitDiagnostics;
    return result.tier1Verdict === 'two-page-spread'
        || (result.reconciled && result.classification === 'two-page-spread')
        || (
            diagnostics !== undefined
            && diagnostics.aspectSpreadScore >= 0.75
            && diagnostics.independentSpreadCues >= 3
        );
}

/** The second pass must prove a spread locally before its wider box is used. */
export function isStrongMediaBoxSpread(
    progress: TNativeScanCleanupProgressV3,
    metadata: INativeScanCleanupPageMetadataV3,
    rasterWidth: number,
    rasterHeight: number,
) {
    const diagnostics = metadata.splitDiagnostics;
    const verdict = progress.tier1Verdict ?? progress.classification;
    const confidence = progress.confidence ?? metadata.layoutConfidence ?? 0;
    const cutter = progress.cutterXPx ?? metadata.cutterXPx;
    const decisionX = diagnostics?.decisionX;
    if (
        verdict !== 'two-page-spread'
        || metadata.layoutClassification !== 'two-page-spread'
        || !Number.isFinite(confidence)
        || confidence < MEDIA_BOX_RETRY_MIN_CONFIDENCE
        || diagnostics === undefined
        || diagnostics.abstained
        || diagnostics.independentSpreadCues < 3
        || diagnostics.centralPositionGatePassed !== true
        || diagnostics.bilateralGatePassed !== true
        || diagnostics.aspectSupportGatePassed !== true
        || diagnostics.evidenceAgreementGatePassed !== true
        || !Number.isFinite(rasterWidth)
        || !Number.isFinite(rasterHeight)
        || rasterWidth <= 0
        || rasterHeight <= 0
        || !Number.isFinite(cutter ?? NaN)
        || (cutter ?? 0) <= rasterWidth * 0.15
        || (cutter ?? 0) >= rasterWidth * 0.85
        || !Number.isFinite(decisionX)
        || (decisionX ?? 0) <= rasterWidth * 0.15
        || (decisionX ?? 0) >= rasterWidth * 0.85
    ) {
        return false;
    }
    return true;
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
        const measuredPageSizes = await retention.pageSizes(document, signal);
        const previouslyBroadenedPages = new Set(
            measuredPageSizes
                .filter(page => page.renderBox === 'mediabox')
                .map(page => page.pageNumber),
        );
        const pageSizes = measuredPageSizes.map(toCropBoxPageSize);
        // Detection reads the whole document, so a native page number is a
        // source page number and this array is indexed by it directly.
        assertCanonicalPdfPageSizes(pageSizes, 'Scan cleanup detection');
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
        // Every page the sidecar has said anything about, provisional or
        // terminal. Detection presents one `detecting` stage over both frame
        // kinds, so the page list it publishes has to span both.
        const reportedPageNumbers = new Set<number>();
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
                // A preview opened before detection may have cached the
                // compatibility MediaBox render. It cannot be reused for the
                // CropBox-first pass, so force those pages through Poppler
                // once with the explicit CropBox request below.
                if (!previouslyBroadenedPages.has(pageNumber)) {
                    retained.set(pageNumber, raster);
                }
            }
        }
        const rasterScope = pageNumbers.filter(pageNumber => !retained.has(pageNumber));
        const rasterLimitsByPage = new Map(pageNumbers.map(pageNumber => [
            pageNumber,
            resolveRasterRenderLimits(
                pageSizeByNumber.get(pageNumber),
                detectionDpiForPage(pageNumber),
            ),
        ]));
        // Detection stages replayable PNGs, but only a bounded window of them
        // is ever resident: the sidecar leases each page before it reads it and
        // hands it back afterwards, and a released page is re-rendered rather
        // than reused from memory. Admission therefore budgets that window, not
        // the document, so length decides how long a run takes and not whether
        // it may start. Pages already retained cost nothing here because their
        // rasters were on disk before free space was measured.
        const stagingPlans = rasterScope.map(pageNumber => {
            const dpi = detectionDpiForPage(pageNumber);
            const limits = rasterLimitsByPage.get(pageNumber)!;
            return {
                renderDpi: dpi,
                // A page in flight exists twice for as long as its private
                // render has not been published over the staged path.
                renderCopies: 2,
                raster: {
                    dpi,
                    width: limits.expectedWidthPx,
                    height: limits.expectedHeightPx,
                },
            };
        });
        // The window is wider than the producer's own raster concurrency so the
        // sidecar, which may never lease more pages than are staged, keeps a
        // page pool worth having. Renders stay bounded by the runtime policy.
        const requestedWindowPages = Math.min(
            SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW,
            Math.max(2, Math.max(1, policy.rasterConcurrency) * 2),
        );
        const admission = await resolveStagedRasterWindow(
            stagingPlans,
            requestedWindowPages,
            scratch,
            dependencies.getAvailableScratchBytes ?? readAvailableScratchBytes,
        );
        const renderConcurrency = Math.max(
            1,
            Math.min(policy.rasterConcurrency, Math.max(1, admission.windowPages)),
        );
        log(
            'debug',
            'Scan cleanup detection staged raster admission '
            + JSON.stringify({
                pages: totalPages,
                stagedPages: rasterScope.length,
                retainedPages: retained.size,
                freeScratchBytes: admission.availableBytes,
                budgetBytes: admission.budgetBytes,
                wholeDocumentBytes: admission.wholeDocumentBytes,
                windowPages: admission.windowPages,
                windowBytes: admission.windowBytes,
                renderConcurrency,
                admitted: admission.admitted,
            }),
        );
        if (!admission.admitted) {
            throw new ScanCleanupInsufficientScratchError(
                admission.availableBytes,
                admission.requiredBytes,
            );
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
        // Every page's staged path is a function of the document, the page and
        // the DPI, so the manifest can name inputs that do not exist yet and a
        // re-render lands on exactly the same file.
        const stagedPathByPage = new Map(await Promise.all(pageNumbers.map(async pageNumber => [
            pageNumber,
            retained.get(pageNumber)?.path
                ?? await retention.stagedRasterPath(
                    document,
                    pageNumber,
                    detectionDpiForPage(pageNumber),
                ),
        ] as const)));
        const stagingAbort = new AbortController();
        const operationSignal = AbortSignal.any([
            signal,
            stagingAbort.signal,
        ]);
        let stagingError: unknown;
        // Renders stay inside the runtime policy's raster concurrency even
        // though the window may hold more pages than that: residency and
        // production are separate bounds.
        let activeRenders = 0;
        const waitingRenders: Array<() => void> = [];
        const renderSlot = async <T>(render: () => Promise<T>) => {
            // A finishing render hands its slot straight to the longest-waiting
            // one instead of releasing the count: a released count would let a
            // render that arrives in the same tick take the slot as well, and
            // the producer would briefly run above the admitted concurrency.
            if (activeRenders >= renderConcurrency) {
                await new Promise<void>(resolve => waitingRenders.push(resolve));
            } else {
                activeRenders += 1;
            }
            try {
                return await render();
            } finally {
                const next = waitingRenders.shift();
                if (next) {
                    next();
                } else {
                    activeRenders -= 1;
                }
            }
        };
        const stagedWindow = createStagedRasterWindow({
            pages: rasterScope,
            alreadyStaged: [...retained.keys()],
            window: Math.max(1, admission.windowPages),
            log,
            stage: pageNumber => renderSlot(async () => {
                operationSignal.throwIfAborted();
                const pageDpi = detectionDpiForPage(pageNumber);
                const scratchPath = await retention.rasterScratchPath(document, pageNumber, pageDpi);
                const raster = await (async () => {
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
                        rasterLimitsByPage.get(pageNumber),
                        'detection raster',
                        'detection',
                        'cropbox',
                    );
                    return retention.retain({
                        document,
                        dpi: pageDpi,
                        height: dimensions.height,
                        pageNumber,
                        scratchPath,
                        sizeBytes: (await stat(scratchPath)).size,
                        width: dimensions.width,
                    });
                })().catch(async (error: unknown) => {
                    // The scratch file is private to this render, so an aborted
                    // or failed one owns the half-written raster it leaves and
                    // must not charge it to the scratch budget.
                    await rm(scratchPath, {force: true}).catch((cleanupError: unknown) => {
                        // Only a refused unlink reaches here: a render that
                        // aborted before writing anything leaves no file, and
                        // `force` already answers that. What is left is scratch
                        // this run can no longer account for, which is worth
                        // naming -- but never in place of the failure that
                        // brought the render here, which is rethrown below.
                        log(
                            'warn',
                            `Scan cleanup could not drop the partial detection raster at ${scratchPath}: ${getErrorMessage(cleanupError)}`,
                        );
                    });
                    throw error;
                });
                if (raster.path !== stagedPathByPage.get(pageNumber)) {
                    throw new ScanCleanupContractError(
                        `page ${String(pageNumber)} was staged at ${raster.path} instead of its manifest input path`,
                    );
                }
            }),
            unstage: pageNumber => retention.releaseRaster(
                document,
                pageNumber,
                detectionDpiForPage(pageNumber),
            ),
            isStaged: async pageNumber => {
                try {
                    return (await stat(stagedPathByPage.get(pageNumber)!)).isFile();
                } catch {
                    return false;
                }
            },
            onStaged: pageNumber => {
                rasterizedPageNumbers.add(pageNumber);
                // Once classifications are arriving, publishing raster progress
                // would replace them with an older-stage empty snapshot.
                if (results.size === 0) publishRasterizing();
            },
        });
        const manifestPages = pageNumbers.map(pageNumber => {
            const sourceBackgroundDpi = sourceRasterStructure.backgroundDpiByPage?.get(pageNumber);
            return {
                inputPath: stagedPathByPage.get(pageNumber)!,
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
        // Reduced rather than spread into Math.max: a long document has one
        // entry per page, and an argument list that long is a call-stack limit
        // rather than a page count the sidecar could not handle.
        let stagedInputPeakPixels = 1;
        for (const limits of rasterLimitsByPage.values()) {
            stagedInputPeakPixels = Math.max(
                stagedInputPeakPixels,
                limits.expectedWidthPx * limits.expectedHeightPx,
            );
        }
        // Every page stays in one replayable manifest because final
        // reconciliation clusters the document's independent verdicts.
        const manifestPath = join(scratch, 'classify-manifest.json');
        await writeFile(manifestPath, JSON.stringify(buildRunnableNativeScanCleanupManifest({
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
            // Declaring the window is what puts the sidecar on the lease
            // protocol: it may then read an input that is not on disk yet, and
            // it never holds more pages at once than are staged. The peak is
            // the document's largest analysis raster, so the sidecar's
            // memory-derived page pool stays a document fact rather than an
            // accident of which pages happened to be staged when it started.
            ...(rasterScope.length === 0
                ? {}
                : {
                    stagedInputWindow: admission.windowPages,
                    stagedInputPeakPixels: stagedInputPeakPixels,
                }),
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
            nativeProgress => {
                // Lease frames are transport, not classification. They arrive
                // while the sidecar is blocked on a raster, so the answer has
                // to be scheduled rather than awaited here; a staging failure
                // stops the sidecar and becomes the run's error.
                if (nativeProgress.stage === 'page-input-required' && nativeProgress.pageNumber !== undefined) {
                    void stagedWindow.acquire(nativeProgress.pageNumber).catch((error: unknown) => {
                        stagingError ??= error;
                        stagingAbort.abort(error);
                    });
                    return;
                }
                if (nativeProgress.stage === 'page-input-released' && nativeProgress.pageNumber !== undefined) {
                    stagedWindow.release(nativeProgress.pageNumber);
                    return;
                }
                if (
                    (nativeProgress.stage === 'page-analyzed' || nativeProgress.stage === 'page-complete')
                    && nativeProgress.pageNumber !== undefined
                ) {
                    reportedPageNumbers.add(nativeProgress.pageNumber);
                }
                const totalUnits = nativeProgress.totalPages;
                if (nativeProgress.stage === 'page-analyzed') {
                    analyzedPages = Math.max(analyzedPages, nativeProgress.completedPages);
                    recordResult(nativeProgress);
                    publish(publishedResults(), {
                        stage: 'detecting',
                        completedUnits: analyzedPages,
                        totalUnits,
                        percent: totalUnits === 0 ? 100 : analyzedPages / totalUnits * 100,
                        completedPageNumbers: [...reportedPageNumbers],
                    }, documentCanvasSignature());
                    return;
                }
                if (nativeProgress.stage !== 'page-complete' || !recordResult(nativeProgress)) {
                    return;
                }
                if (nativeProgress.pageNumber !== undefined) {
                    completedPages.add(nativeProgress.pageNumber);
                }
                const completedUnits = Math.max(analyzedPages, nativeProgress.completedPages);
                publish(publishedResults(), {
                    stage: 'detecting',
                    completedUnits,
                    totalUnits,
                    percent: totalUnits === 0 ? 100 : completedUnits / totalUnits * 100,
                    completedPageNumbers: [...reportedPageNumbers],
                }, documentCanvasSignature(completedPages.size === totalPages));
            },
            {
                priority: 'background',
                allowedPathRoot: dependencies.getTempDir(),
            },
        );
        let published = false;
        try {
            // Fill the window before the sidecar starts so its first pages are
            // already readable and its page pool has real rasters to measure.
            await stagedWindow.prime();
            await runAnalysis(operationSignal);
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
            let mediaBoxRetryCandidates = manifestPages
                .filter(page => {
                    const sourcePage = pageSizeByNumber.get(page.pageNumber);
                    const result = results.get(page.pageNumber);
                    return sourcePage !== undefined
                        && result !== undefined
                        && result.classification === 'single-uncut-page'
                        && shouldRetryMediaBoxPage(sourcePage, result);
                })
                .slice(0, MAX_MEDIA_BOX_RETRY_PAGES);
            if (mediaBoxRetryCandidates.length > 0) {
                const retryPlans = mediaBoxRetryCandidates.map(candidate => {
                    const mediaPage = toMediaBoxPageSize(pageSizeByNumber.get(candidate.pageNumber)!);
                    const limits = resolveRasterRenderLimits(mediaPage, DETECTION_DPI);
                    return {
                        renderDpi: DETECTION_DPI,
                        raster: {
                            dpi: DETECTION_DPI,
                            width: limits.expectedWidthPx,
                            height: limits.expectedHeightPx,
                        },
                    };
                });
                const retryAdmission = await resolveStagedRasterWindow(
                    retryPlans,
                    retryPlans.length,
                    scratch,
                    dependencies.getAvailableScratchBytes ?? readAvailableScratchBytes,
                );
                if (
                    !retryAdmission.admitted
                    || retryAdmission.windowPages < mediaBoxRetryCandidates.length
                ) {
                    log(
                        'warn',
                        'Scan cleanup skipped optional MediaBox retry because its rasters do not fit the remaining scratch budget',
                    );
                    mediaBoxRetryCandidates = [];
                }
                const retryRoot = join(scratch, 'mediabox-retry');
                await mkdir(retryRoot, {recursive: true});
                const renderedRetryPages: Array<{
                    sourcePage: IPdfPageSize;
                    pageNumber: number;
                    path: string;
                    metadataPath: string;
                    width: number;
                    height: number;
                }> = [];
                try {
                    for (const candidate of mediaBoxRetryCandidates) {
                        operationSignal.throwIfAborted();
                        const sourcePage = pageSizeByNumber.get(candidate.pageNumber);
                        if (sourcePage === undefined) continue;
                        const mediaPage = toMediaBoxPageSize(sourcePage);
                        const path = join(retryRoot, `page-${String(candidate.pageNumber)}.png`);
                        let dimensions;
                        try {
                            dimensions = await renderRasterToDisk(
                                request.sourcePdfPath,
                                candidate.pageNumber,
                                path,
                                operationSignal,
                                dependencies,
                                log,
                                DETECTION_DPI,
                                undefined,
                                undefined,
                                'png',
                                resolveRasterRenderLimits(mediaPage, DETECTION_DPI),
                                'MediaBox retry raster',
                                'MediaBox retry',
                                'mediabox',
                            );
                        } catch (error) {
                            if (operationSignal.aborted) throw error;
                            log(
                                'warn',
                                `Scan cleanup kept the first-pass classification for page ${String(candidate.pageNumber)} because its optional MediaBox retry failed: ${getErrorMessage(error)}`,
                            );
                            continue;
                        }
                        renderedRetryPages.push({
                            sourcePage,
                            pageNumber: candidate.pageNumber,
                            path,
                            metadataPath: join(retryRoot, `page-${String(candidate.pageNumber)}.json`),
                            width: dimensions.width,
                            height: dimensions.height,
                        });
                    }
                    const retryManifestPages = renderedRetryPages.map((page, index) => {
                        const sourceBackgroundDpi = sourceRasterStructure.backgroundDpiByPage?.get(page.pageNumber);
                        return {
                            inputPath: page.path,
                            pageNumber: index + 1,
                            dpi: DETECTION_DPI,
                            sourceDpi: previewRasterPlan.pageDpiByNumber.get(page.pageNumber)
                                ?? DETECTION_DPI,
                            sourceHasBilevelLayer: sourceRasterStructure.bilevelLayerPages
                                ?.has(page.pageNumber) ?? false,
                            ...(sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi}),
                            pageMetadataPath: page.metadataPath,
                        };
                    });
                    if (retryManifestPages.length > 0) {
                        const retryManifestPath = join(retryRoot, 'classify-manifest.json');
                        await writeFile(retryManifestPath, JSON.stringify(buildRunnableNativeScanCleanupManifest({
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
                            pages: retryManifestPages,
                            allowedPathRoot: dependencies.getTempDir(),
                        })));
                        const retryProgressByManifestPage = new Map<number, TNativeScanCleanupProgressV3>();
                        await dependencies.runSidecar(
                            binary,
                            retryManifestPath,
                            operationSignal,
                            log,
                            nativeProgress => {
                                if (nativeProgress.totalPages !== retryManifestPages.length) {
                                    throw new ScanCleanupContractError(
                                        `MediaBox retry reported ${String(nativeProgress.totalPages)} pages for ${String(retryManifestPages.length)} inputs`,
                                    );
                                }
                                if (
                                    nativeProgress.stage === 'page-complete'
                                    && nativeProgress.pageNumber !== undefined
                                    && nativeProgress.pageNumber >= 1
                                    && nativeProgress.pageNumber <= retryManifestPages.length
                                ) {
                                    retryProgressByManifestPage.set(nativeProgress.pageNumber, nativeProgress);
                                }
                            },
                            {
                                priority: 'background',
                                allowedPathRoot: dependencies.getTempDir(),
                            },
                        );
                        for (const [
                            index,
                            page,
                        ] of renderedRetryPages.entries()) {
                            const retryProgress = retryProgressByManifestPage.get(index + 1);
                            if (retryProgress === undefined) continue;
                            const retryMetadata = decodeNativeScanCleanupPageMetadataJson(
                                await readFile(page.metadataPath, 'utf8'),
                            );
                            if (!isStrongMediaBoxSpread(
                                retryProgress,
                                retryMetadata,
                                page.width,
                                page.height,
                            )) {
                                continue;
                            }
                            const mediaPage = toMediaBoxPageSize(page.sourcePage);
                            pageSizes[page.pageNumber - 1] = mediaPage;
                            pageSizeByNumber.set(page.pageNumber, mediaPage);
                            const result = results.get(page.pageNumber);
                            if (result === undefined) continue;
                            const accepted: IScanCleanupDetectionResult = {
                                ...result,
                                revision: (result.revision ?? 0) + 1,
                                classification: retryProgress.classification
                                    ?? retryMetadata.layoutClassification,
                                confidence: retryProgress.confidence
                                    ?? retryMetadata.layoutConfidence
                                    ?? result.confidence,
                                cutterXPx: retryProgress.cutterXPx
                                    ?? retryMetadata.cutterXPx,
                                tier1Verdict: retryProgress.tier1Verdict
                                    ?? retryMetadata.layoutClassification,
                                reconciled: retryProgress.reconciled ?? false,
                                clusterAgreement: retryProgress.clusterAgreement ?? 0,
                                documentPrior: retryProgress.documentPrior ?? null,
                                sourcePageMetadata: {
                                    ...mediaPage,
                                    sourceDpi: previewRasterPlan.pageDpiByNumber.get(page.pageNumber)
                                        ?? DETECTION_DPI,
                                    renderBox: 'mediabox',
                                },
                                ...(retryMetadata.splitDiagnostics === undefined
                                    ? {}
                                    : {splitDiagnostics: retryMetadata.splitDiagnostics}),
                                ...(retryProgress.textAxis === undefined ? {} : {textAxis: retryProgress.textAxis}),
                                ...(retryProgress.recommendedOutputMode === undefined
                                    ? {}
                                    : {recommendedOutputMode: retryProgress.recommendedOutputMode}),
                                ...(retryProgress.recommendedOutputModeConfidence === undefined
                                    ? {}
                                    : {recommendedOutputModeConfidence: retryProgress.recommendedOutputModeConfidence}),
                                ...(retryProgress.recommendedOutputModeReason === undefined
                                    ? {}
                                    : {recommendedOutputModeReason: retryProgress.recommendedOutputModeReason}),
                                ...(retryProgress.softAlphaForegroundRecommendation === undefined
                                    ? {}
                                    : {softAlphaForegroundRecommendation:
                                        retryProgress.softAlphaForegroundRecommendation}),
                                ...(retryProgress.outputModeDiagnostics === undefined
                                    ? {}
                                    : {outputModeDiagnostics: retryProgress.outputModeDiagnostics}),
                            };
                            accepted.pagePlanEvidence = createDetectionPagePlanEvidence(
                                accepted,
                                retryMetadata,
                                request.options.autoDewarp !== true,
                            );
                            results.set(page.pageNumber, accepted);
                            log(
                                'debug',
                                `MediaBox retry accepted page ${String(page.pageNumber)} as a two-page spread`,
                            );
                        }
                    }
                } finally {
                    await rm(retryRoot, {
                        recursive: true,
                        force: true,
                    });
                }
            }
            published = true;
            return {results: publishedResults()};
        } catch (error) {
            // A staging failure stops the sidecar, so the abort it reports is a
            // consequence rather than the cause worth surfacing.
            throw stagingError ?? error;
        } finally {
            // A run that published its results leaves the rasters still inside
            // the window to the raster cache; cancellation and failure destroy
            // every one this run staged.
            await stagedWindow.dispose({retainStaged: published});
        }
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
