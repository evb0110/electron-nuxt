import {
    access,
    copyFile,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {constants as fsConstants} from 'fs';
import { randomUUID } from 'crypto';
import {
    dirname,
    join,
} from 'path';
import type {
    INativeScanCleanupOutputMetadataV3,
    INativeScanCleanupPageMetadataV3,
    IScanCleanupSourcePageMetadata,
    TNativeScanCleanupProgressV3,
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/electronApiScanCleanup';
import {
    decodeNativeScanCleanupOutputMetadataJson,
    decodeNativeScanCleanupPageMetadataJson,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type { IScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import { getErrorMessage } from '@contracts/getErrorMessage';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {
    detectSourceDpiFromPageSizes,
    resolveSourceDpi,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
    type IScanCleanupOutputPageForSummary,
    type IScanCleanupOutputMapping,
    type IScanCleanupRepresentationReport,
    type IPdfMrcLayers,
    type IPdfPageSize,
    type IScanCleanupRasterRenderLimits,
    type ISourceDpiDetectionResult,
    type TScanCleanupLog,
} from '@scan-cleanup-core/types';
import {resolveScanCleanupPageScope} from '@scan-cleanup-core/pageScope';
import {
    ScanCleanupMissingOutputError,
    ScanCleanupNativeToolUnavailableError,
    ScanCleanupPdfValidationError,
} from '@scan-cleanup-core/errors';
import {createPdfCombineProgressHandler} from '@scan-cleanup-core/createPdfCombineProgressHandler';
import {
    buildScanCleanupCompactManifest,
    isScanCleanupCliFallbackSentinel,
    serializeLegacyScanCleanupCompactManifest,
    serializeScanCleanupCompactManifest,
} from '@scan-cleanup-core/compactManifest';
import {buildScanCleanupStampBuildIds} from '@scan-cleanup-core/buildManifest';
import {
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    sha256ScanCleanupFile,
} from '@scan-cleanup-core/provenanceStamp';
import {readPdfPageSizes} from '@scan-cleanup-core/pdfPageSizes';
import {buildNativeScanCleanupManifest} from '@scan-cleanup-core/policy/buildNativeScanCleanupManifest';
import {assertNativeScanCleanupManifestGeometry} from '@scan-cleanup-core/policy/assertNativeScanCleanupManifestGeometry';
import {
    resolveScanCleanupDocumentCanvasDpi,
    resolveScanCleanupDocumentCanvasRenderDpi,
    resolveScanCleanupDocumentCanvas,
    resolveScanCleanupDroppedMatchWarning,
    resolveMatchedCanvasResamplePages,
    resolveScanCleanupUnclassifiedPages,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@scan-cleanup-core/policy/documentCanvas';
import {
    resolveTonalJpegQuality,
    SCAN_CLEANUP_COLOR_JPEG_QUALITY,
    SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
    resolveScanCleanupCanvasPageDpi,
    resolveScanCleanupDocumentGuardrail,
    resolveScanCleanupPipelineMaxPixels,
    resolveScanCleanupPlannedDpi,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
    SCAN_CLEANUP_SIZE_PROBE_DPI,
} from '@scan-cleanup-core/policy/effectiveOptions';
import {createPagePlanResolver} from '@scan-cleanup-core/createPagePlanResolver';
import {
    assertScanCleanupCompactSourceBudget,
    resolveScanCleanupCompactSourceBudget,
} from '@scan-cleanup-core/policy/scanCleanupRepresentationPolicy';
import {
    readPbmDimensions,
    readPngDimensions,
    readPpmDimensions,
} from '@scan-cleanup-core/rasterLayerDimensions';
import {
    createEmptyScanCleanupSummary,
    createScanCleanupProgressReporter,
} from '@scan-cleanup-core/createScanCleanupProgressReporter';
import {
    logRasterHandoff,
    mapScanCleanupRasterPages,
    resolveCombineOutputByteCap,
    resolveRasterHandoff,
    runRasterProducerConsumer,
} from '@scan-cleanup-core/resolveRasterHandoff';
import {preserveScanCleanupJsonEvidence} from '@scan-cleanup-core/preserveScanCleanupJsonEvidence';
import {runLosslessScanCleanup} from '@scan-cleanup-core/runLosslessScanCleanup';
import {createScanCleanupScratchDir} from '@scan-cleanup-core/scratchCleanup';
import {
    assembleWithCompactSourcePages,
    describePageNumbers,
    type IRenderedCleanupOutputPage,
    resolveCompactSourcePreservation,
    sourceMrcForegroundPdfMatrix,
} from '@scan-cleanup-core/assembleCompactScanCleanupPages';
export type {
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@scan-cleanup-core/types';

async function readOptionalFileSize(path: string) {
    try {
        return (await stat(path)).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

async function requirePublishedRasterFile(path: string | undefined, pageNumber: number, role: string) {
    if (path === undefined) {
        throw new ScanCleanupMissingOutputError(
            pageNumber,
            path,
            role,
            'no output destination was declared',
        );
    }
    const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
        throw new ScanCleanupMissingOutputError(pageNumber, path, role, error.message);
    });
    if (!stats.isFile()) throw new ScanCleanupMissingOutputError(pageNumber, path, role, 'path is not a file');
    await access(path, fsConstants.R_OK).catch((error: NodeJS.ErrnoException) => {
        throw new ScanCleanupMissingOutputError(pageNumber, path, role, error.message);
    });
    return path;
}

async function requireProducedRasterFile(
    requirePublishedRaster: NonNullable<IRunScanCleanupPipelineDependencies['requirePublishedRaster']>,
    path: string | undefined,
    pageNumber: number,
    role: string,
) {
    try {
        return await requirePublishedRaster(path, pageNumber, role);
    } catch (error) {
        if (error instanceof ScanCleanupMissingOutputError) throw error;
        throw new ScanCleanupMissingOutputError(pageNumber, path, role, getErrorMessage(error));
    }
}

async function validateStagedPdf(
    qpdfBinary: string,
    stagedPdfPath: string,
    signal: AbortSignal,
    log: TScanCleanupLog,
    runCommand: IRunScanCleanupPipelineDependencies['runCommand'],
) {
    let result;
    try {
        result = await runCommand(qpdfBinary, [
            '--check',
            stagedPdfPath,
        ], {
            signal,
            // qpdf exits 3 for a structurally valid file with warnings (for
            // example a repaired dictionary); only hard failures block
            // publication.
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(scan-cleanup:publish-structure-check)',
            timeoutMs: 10 * 60 * 1000,
            log,
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new ScanCleanupPdfValidationError(stagedPdfPath, getErrorMessage(error));
    }
    signal.throwIfAborted();
    if (result.exitCode === 3) {
        const warnings = [
            result.stderr,
            result.stdout,
        ]
            .filter(value => value.length > 0)
            .join('\n')
            .trim();
        log('warn', `Published PDF passed structural validation with qpdf warnings: ${warnings}`);
        return;
    }
    if (result.exitCode !== 0) {
        const detail = [
            result.stderr,
            result.stdout,
        ]
            .filter(value => value.length > 0)
            .join('\n')
            .trim();
        throw new ScanCleanupPdfValidationError(
            stagedPdfPath,
            detail.length > 0 ? detail : `qpdf exited with code ${String(result.exitCode)}`,
        );
    }
}

function resolveBlankOutputHalves(
    pageMetadata: INativeScanCleanupPageMetadataV3,
    pageOutputPages: readonly IRenderedCleanupOutputPage[],
    missingOutputCount: number,
): Array<IScanCleanupOutputMapping['half']> {
    if (missingOutputCount <= 0) {
        return [];
    }
    if (pageMetadata.layoutClassification !== 'two-page-spread') {
        return Array.from({length: missingOutputCount}, () => 'full');
    }
    const producedHalves = new Set(
        pageOutputPages
            .map(output => output.metadata.half)
            .filter((half): half is 'left' | 'right' => half === 'left' || half === 'right'),
    );
    const unproducedHalves = ([
        'left',
        'right',
    ] as const).filter(half => !producedHalves.has(half));
    return Array.from(
        {length: missingOutputCount},
        (_, index) => unproducedHalves[index] ?? 'full',
    );
}

function validatePdfImagePlacement(
    placement: NonNullable<INativeScanCleanupOutputMetadataV3['pdfImagePlacement']>,
    pageWidthPoints: number,
    pageHeightPoints: number,
    pageNumber: number,
) {
    const values = [
        placement.xPoints,
        placement.yPoints,
        placement.widthPoints,
        placement.heightPoints,
    ];
    const tolerancePoints = 0.0001;
    if (
        !values.every(Number.isFinite)
        || placement.xPoints < 0
        || placement.yPoints < 0
        || placement.widthPoints <= 0
        || placement.heightPoints <= 0
        || placement.xPoints + placement.widthPoints > pageWidthPoints + tolerancePoints
        || placement.yPoints + placement.heightPoints > pageHeightPoints + tolerancePoints
    ) {
        throw new Error(`Page ${String(pageNumber)} PDF image placement is outside its MediaBox`);
    }
    return values;
}

export async function runScanCleanupConversion(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    signal: AbortSignal,
    onProgress: (progress: TScanCleanupProgress) => void,
    policy: IScanCleanupRuntimePolicy,
    log: TScanCleanupLog = () => undefined,
    dependencies: IRunScanCleanupPipelineDependencies,
): Promise<TScanCleanupSummary> {
    const scratch = await createScanCleanupScratchDir(paths.tempDir);
    const sessionId = randomUUID();
    const stagedPdfPath = join(scratch, 'cleaned.pdf');
    const publishTempPath = join(dirname(request.outputPdfPath), `.${sessionId}.scan-cleanup.tmp`);
    // Set once the run knows which assembler it is actually using: a matched
    // lossless run whose pages cannot keep their own pixels renders instead.
    let losslessRun = request.options.preserveOriginalQuality === true;
    const supportsRasterStreaming = policy.rasterStreaming
        && process.platform !== 'win32'
        && dependencies.createRasterPipes !== undefined;
    let rasterStreamingRun = supportsRasterStreaming;
    let preserveScratchForDiagnostics = false;
    const requirePublishedRaster = dependencies.requirePublishedRaster ?? requirePublishedRasterFile;
    const emitProgress = createScanCleanupProgressReporter(onProgress, () => losslessRun, {isRasterStreaming: () => rasterStreamingRun});
    try {
        emitProgress('normalizing', 0, 1, []);
        // The viewer has already opened this exact revision successfully, and
        // every cleanup read is bounded by the operation signal. Rewriting the
        // entire document through qpdf here used to add almost a second to a
        // one-page cleanup (and repeated work already done at document open)
        // before Poppler or the cleanup engine touched the selected page.
        // Keep qpdf repair in the import/open boundary; this pipeline consumes
        // the validated source directly.
        const prepared = {
            pdfPath: request.sourcePdfPath,
            warnings: [] as string[],
        };
        const documentPageCount = await dependencies.getPageCount(prepared.pdfPath, {signal});
        const pageNumbers = resolveScanCleanupPageScope(
            request.sourcePageNumbers,
            documentPageCount,
        );
        const documentPageNumbers = Array.from(
            {length: documentPageCount},
            (_, index) => index + 1,
        );
        const pageCount = pageNumbers.length;
        const warnings = [...prepared.warnings];
        // What the run tells the user reaches them through the summary, and
        // the same sentence belongs in the log.
        const warn = (message: string) => {
            warnings.push(message);
            log('warn', `Scan cleanup: ${message}`);
        };
        emitProgress('normalizing', 1, 1);
        // The lossless path assembles with evb-pdf-page-ops, so it needs the
        // tool itself. Matching only needs the geometry, which Poppler reports
        // too — a default matched run on an installation without page-ops is
        // measured rather than degraded.
        if (request.options.preserveOriginalQuality === true && !paths.pdfPageOpsBinary) {
            throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
        }
        // The same measurement the preview derives its canvas from, read from
        // the prepared document this run renders. The lossless path cannot
        // proceed without it — every crop it writes is expressed in these
        // coordinates. Matching only wants the rectangle, and a document that
        // carries none is still worth cleaning: the run drops matching, names
        // why in the summary, and cleans every page at its own size, which is
        // what it already answers when geometry yields no canvas.
        const suppliedPageSizes = documentPageNumbers.map(pageNumber => (
            request.sourcePageMetadataByPage?.[String(pageNumber)]
        ));
        let pageSizes: IPdfPageSize[] | null = suppliedPageSizes.every(
            (page): page is IScanCleanupSourcePageMetadata => page !== undefined,
        )
            ? suppliedPageSizes
            : null;
        if (pageSizes === null) {
            try {
                if (!paths.pdfPageOpsBinary && !paths.pdfinfoBinary) {
                    throw new Error('no PDF tool is available to read page geometry');
                }
                pageSizes = await (dependencies.getPageSizes ?? readPdfPageSizes)(prepared.pdfPath, {
                    ...(paths.pdfPageOpsBinary === undefined
                        ? {}
                        : {pdfPageOpsBinary: paths.pdfPageOpsBinary}),
                    ...(paths.pdfinfoBinary === undefined
                        ? {}
                        : {pdfinfoBinary: paths.pdfinfoBinary}),
                    log,
                    runCommand: dependencies.runCommand,
                    signal,
                    tempDir: scratch,
                });
            } catch (error) {
                if (signal.aborted) throw error;
                throw new Error(
                    `Scan cleanup cannot safely rasterize without trusted page geometry (${getErrorMessage(error)})`,
                    {cause: error},
                );
            }
        }
        if (pageSizes.length !== documentPageCount) {
            throw new Error(
                `Scan cleanup received geometry for ${String(pageSizes.length)} of ${String(documentPageCount)} pages`,
            );
        }
        const dpiProbePages = request.options.matchPageSize ? documentPageNumbers : pageNumbers;
        emitProgress('probing', 0, dpiProbePages.length, []);
        // For scan PDFs the fast geometry pass above also reports the dominant
        // raster and its actual page placement. It answers the same DPI question
        // as pdfimages without reopening and walking every image stream in a
        // second process. Mixed/vector documents keep the existing conservative
        // Poppler fallback.
        const metadataDpiDetails = pageSizes
            ? detectSourceDpiFromPageSizes(pageSizes)
            : null;
        // Page geometry can name the dominant raster but not whether the PDF
        // already carries a compact bilevel foreground. Auto needs that
        // representation fact to distinguish an existing MRC text mask from
        // genuinely antialiased low-resolution text, so retain the pdfimages
        // structure probe whenever it is available.
        const structuralDpiDetails: ISourceDpiDetectionResult = metadataDpiDetails !== null
            && paths.pdfimagesBinary === undefined
            ? {
                documentDpi: null,
                pageDpiByNumber: new Map<number, number>(),
                pageRasterByNumber: new Map(),
            }
            : await dependencies.detectSourceDpi(
                prepared.pdfPath,
                paths.pdfimagesBinary,
                log,
                undefined,
                signal,
                dpiProbePages,
                (completedPages, totalPages) => emitProgress('probing', completedPages, totalPages),
            );
        const dpiDetails = structuralDpiDetails.pageRasterByNumber.size > 0
            ? structuralDpiDetails
            : metadataDpiDetails ?? structuralDpiDetails;
        if (metadataDpiDetails && structuralDpiDetails.pageRasterByNumber.size === 0) {
            emitProgress('probing', dpiProbePages.length, dpiProbePages.length, dpiProbePages);
        }
        const documentDpi = resolveSourceDpi(dpiDetails.documentDpi);
        // A page left on automatic that detection has not classified is
        // measured as the whole sheet it is: assuming it is a spread because
        // its neighbours are would halve the document rectangle and place every
        // page that is not a spread at half the document's scale. Measuring the
        // sheet can only leave such a page padded, and the run names the pages
        // it had to measure that way.
        const unclassifiedPages = request.options.matchPageSize && pageSizes
            ? resolveScanCleanupUnclassifiedPages(pageSizes, request.options, request.layoutByPage)
            : [];
        if (unclassifiedPages.length > 0) {
            warn(
                `Matched page size measured ${String(unclassifiedPages.length)} page(s) as whole sheets `
                + 'because layout detection had not classified them when the run started; '
                + 'a page among them that is a two-page spread is placed on the document rectangle '
                + `without being scaled to it: ${describePageNumbers(unclassifiedPages)}`,
            );
        }
        // Matching a document onto one rectangle also means one content scale.
        // The lossless assembler can carry a page's own objects at a different
        // scale, but it cannot give a page that was scanned at a lower
        // resolution the document's pixel grid without resampling it. Where the
        // two promises collide, matched page size wins and this run renders,
        // and it says so rather than shipping a document whose pages are the
        // same paper at visibly different resolutions.
        const resampledPages = request.options.preserveOriginalQuality === true && pageSizes
            ? resolveMatchedCanvasResamplePages(
                pageSizes,
                // Every page of the document, not only the ones this run
                // produces: one page of a document that cannot share a pixel
                // grid cannot be cleaned as if the rest of it could.
                pageSizes.map(pageSize => pageSize.pageNumber),
                request.options,
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                dpiDetails.pageRasterByNumber,
                paths.pdfimagesBinary !== undefined,
                request.layoutByPage,
            )
            : [];
        if (resampledPages.length > 0) {
            losslessRun = false;
            warn(`Matched page size re-rendered ${String(resampledPages.length)} page(s) that do not share the document's pixel grid: ${describePageNumbers(resampledPages)}`);
        }
        if (request.options.preserveOriginalQuality && resampledPages.length === 0) {
            const summary = await runLosslessScanCleanup(
                request,
                paths,
                prepared.pdfPath,
                warnings,
                pageNumbers,
                pageSizes,
                dpiDetails,
                scratch,
                stagedPdfPath,
                signal,
                emitProgress,
                log,
                policy,
                dependencies,
            );
            if ((await stat(stagedPdfPath)).size <= 0) throw new Error('Lossless PDF assembler produced an empty file');
            await validateStagedPdf(paths.qpdfBinary, stagedPdfPath, signal, log, dependencies.runCommand);
            emitProgress('handoff', 0, pageCount, []);
            await copyFile(stagedPdfPath, publishTempPath);
            signal.throwIfAborted();
            await rename(publishTempPath, request.outputPdfPath);
            emitProgress('handoff', pageCount, pageCount, pageNumbers);
            return summary;
        }
        const detectedRasterByPage = dpiDetails.pageRasterByNumber;
        // The pixel grid is a property of the document, so it is derived over
        // every page of it rather than over the pages this run was asked to
        // clean: cleaning page 2 of a 300-DPI scan on its own otherwise writes
        // a page at page 2's own resolution.
        const canvasPageNumbers = request.options.matchPageSize && pageSizes
            ? pageSizes.map(pageSize => pageSize.pageNumber)
            : [];
        const plannedPageNumbers = [...new Set([
            ...pageNumbers,
            ...canvasPageNumbers,
        ])];
        const sourceDpiByPage = new Map(plannedPageNumbers.map(pageNumber => [
            pageNumber,
            resolveSourceDpi(detectedRasterByPage.get(pageNumber)?.dpi, documentDpi),
        ]));
        const resolvedOutputModeByPage = new Map<number, TScanCleanupOutputMode>();
        const outputPageNumbers = new Set(pageNumbers);
        for (const pageNumber of plannedPageNumbers) {
            const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, pageNumber);
            if (pageOverride.excluded) {
                resolvedOutputModeByPage.set(pageNumber, 'color');
                continue;
            }
            const outputMode = resolveScanCleanupEffectiveOutputMode({
                options: request.options,
                pageOverride,
                detectedOutputMode: request.outputModeRecommendations?.[String(pageNumber)],
            });
            // Final rendering consumes the durable decision detection already
            // exposed in preview. An unselected page may remain unresolved
            // solely for document-canvas planning; a rendered page may not.
            if (outputMode !== undefined) {
                resolvedOutputModeByPage.set(pageNumber, outputMode);
                continue;
            }
            if (outputPageNumbers.has(pageNumber)) {
                throw new Error(
                    `Scan cleanup page ${String(pageNumber)} has no locked Auto output-mode decision`,
                );
            }
        }
        const requiresBilevelQuality = (pageNumber: number) => {
            const mode = resolvedOutputModeByPage.get(pageNumber);
            return mode === undefined || mode === 'bw' || mode === 'mixed';
        };
        // Every final output mode is preflighted from trusted geometry before
        // any Poppler producer starts. A detected source raster is the most
        // exact guardrail; otherwise the PDF page view is the same CropBox
        // rectangle pdftoppm will materialize.
        const guardrailByPage = new Map<number, {
            dpi: number;
            width: number;
            height: number
        }>();
        for (const pageNumber of pageNumbers) {
            const detected = detectedRasterByPage.get(pageNumber);
            const guardrail = resolveScanCleanupDocumentGuardrail(
                detected,
                sourceDpiByPage.get(pageNumber),
                pageSizes.find(pageSize => pageSize.pageNumber === pageNumber),
            );
            if (guardrail === undefined) {
                throw new Error(`Scan cleanup has no trusted raster geometry for page ${String(pageNumber)}`);
            }
            guardrailByPage.set(pageNumber, guardrail);
        }
        const probePages = pageNumbers.filter(pageNumber => !guardrailByPage.has(pageNumber) && requiresBilevelQuality(pageNumber));
        if (probePages.length > 0) {
            const probedPageNumbers = new Set<number>();
            emitProgress('probing', 0, probePages.length, []);
            await mapScanCleanupRasterPages(probePages, policy.rasterConcurrency, async pageNumber => {
                signal.throwIfAborted();
                const probePath = join(scratch, `size-probe-${pageNumber}.png`);
                await dependencies.renderPage(
                    paths,
                    log,
                    pageNumber,
                    prepared.pdfPath,
                    probePath,
                    SCAN_CLEANUP_SIZE_PROBE_DPI,
                    undefined,
                    signal,
                );
                guardrailByPage.set(pageNumber, {
                    dpi: SCAN_CLEANUP_SIZE_PROBE_DPI,
                    ...await readPngDimensions(probePath),
                });
                probedPageNumbers.add(pageNumber);
                emitProgress('probing', probedPageNumbers.size, probePages.length, probedPageNumbers);
            });
        }
        // What this run renders each page at, read off the mode the run
        // resolved for it. The shared canvas may not read that mode: see
        // resolveScanCleanupCanvasPageDpi.
        const uncappedRasterPlans = pageNumbers.map(pageNumber => {
            const resolvedOutputMode = resolvedOutputModeByPage.get(pageNumber);
            const guardrail = guardrailByPage.get(pageNumber);
            return {
                pageNumber,
                resolvedOutputMode,
                ...resolveScanCleanupPlannedDpi({
                    sourceDpi: sourceDpiByPage.get(pageNumber)!,
                    outputCarriesBinaryLayer: requiresBilevelQuality(pageNumber),
                    sourceHasDominantBilevelLayer: detectedRasterByPage.get(pageNumber)
                        ?.hasDominantBilevelLayer ?? false,
                    maxPixels: resolveScanCleanupPipelineMaxPixels(resolvedOutputMode),
                    guardrail,
                }),
                guardrail,
            };
        });
        // The rectangle the preview presented, on the finest resolution the
        // *document* is rendered at, so it has one output DPI and no page is
        // resampled below the detail it arrived with. Auto decisions are already
        // locked at this point; canvas planning must consume those same modes or
        // a Color/Gray book is silently allocated on the binary synthesis grid.
        // Run scope still cannot affect the grid because decisions and source
        // raster facts are supplied for the complete document.
        const finestCanvasDpi = canvasPageNumbers.reduce((finest, pageNumber) => {
            const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, pageNumber);
            return pageOverride.excluded ? finest : Math.max(finest, resolveScanCleanupCanvasPageDpi({
                configuredMode: resolvedOutputModeByPage.get(pageNumber)
                    ?? pageOverride.outputModeOverride
                    ?? request.options.outputMode,
                sourceDpi: sourceDpiByPage.get(pageNumber)!,
                sourceHasDominantBilevelLayer: detectedRasterByPage.get(pageNumber)
                    ?.hasDominantBilevelLayer ?? false,
                guardrail: resolveScanCleanupDocumentGuardrail(
                    detectedRasterByPage.get(pageNumber),
                    sourceDpiByPage.get(pageNumber),
                    pageSizes?.[pageNumber - 1],
                ),
            }));
        }, 0);
        const documentCanvas = canvasPageNumbers.length > 0 && pageSizes
            ? resolveScanCleanupDocumentCanvas(pageSizes, finestCanvasDpi, request.options, request.layoutByPage)
            : null;
        // One page scanned far finer than the rest raises the grid the whole
        // document is normalized onto, and the pixel budget its output modes
        // allow is what stops that becoming a document nothing can render —
        // a real loss against what the finest page asked for, so the run names
        // the resolution it actually normalized at.
        const canvasDpi = documentCanvas === null
            ? finestCanvasDpi
            : resolveScanCleanupDocumentCanvasDpi(documentCanvas);
        if (canvasDpi < finestCanvasDpi * 0.99) {
            warn(
                `Matched page size normalized this document at ${String(Math.round(canvasDpi))} DPI `
                + `instead of the ${String(Math.round(finestCanvasDpi))} DPI its finest page was rendered at, `
                + 'to keep one shared page inside the output pixel budget',
            );
        }
        // Native reconstructs the final uniform canvas from each page's render
        // DPI and the document rectangle. The plan's pixel fields alone cannot
        // constrain that reconstruction, so every page that would recreate a
        // different grid is normalized before its raster is rendered. This
        // raises coarse scans onto the document grid as well as capping pages
        // that would exceed it, so a partial run cannot silently fall back to
        // the selected page's lower resolution.
        const rasterPlans = uncappedRasterPlans.map(plan => {
            // A page already lowered by its own raster guardrail cannot safely
            // be raised again merely to reach the document grid. Native will
            // fit that bounded raster onto the shared physical canvas.
            const dpi = plan.dpi < plan.requestedRenderDpi
                ? plan.dpi
                : resolveScanCleanupDocumentCanvasRenderDpi(plan.dpi, documentCanvas);
            if (dpi < plan.dpi) {
                warn(
                    `Matched page size capped page ${String(plan.pageNumber)} at ${String(dpi)} DPI `
                    + `from ${String(plan.dpi)} DPI to keep its uniform canvas inside cleanup guardrails`,
                );
            }
            return dpi === plan.dpi ? plan : {
                ...plan,
                dpi,
            };
        });
        const pagePlanResolver = createPagePlanResolver(request, log, 'final');
        const resolvedPagePlanByNumber = new Map(rasterPlans.map(plan => [
            plan.pageNumber,
            pagePlanResolver.resolve(plan.pageNumber),
        ]));
        pagePlanResolver.report();
        // Resolve and validate the complete effective geometry before touching
        // compact source layers or starting any final raster producer. The
        // source can contain hundreds of expensive MRC masks; discovering one
        // malformed page only after extracting all of them made a validation
        // error look like a hung cleanup.
        assertNativeScanCleanupManifestGeometry(buildNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            hostMemoryBytes: policy.totalRamBytes,
            options: request.options,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: rasterPlans.map(plan => {
                const detectedRaster = detectedRasterByPage.get(plan.pageNumber);
                return {
                    inputPath: '',
                    pageNumber: plan.pageNumber,
                    dpi: plan.dpi,
                    sourceDpi: plan.sourceDpi,
                    sourceHasBilevelLayer: detectedRaster?.hasBilevelLayer ?? false,
                    ...(detectedRaster?.backgroundDpi === undefined
                        ? {}
                        : {sourceBackgroundDpi: detectedRaster.backgroundDpi}),
                    requestedRenderDpi: plan.requestedRenderDpi,
                    ...(plan.resolvedOutputMode === undefined
                        ? {}
                        : {resolvedOutputMode: plan.resolvedOutputMode}),
                    ...(request.layoutByPage?.[String(plan.pageNumber)] === undefined
                        ? {}
                        : {observedLayout: request.layoutByPage[String(plan.pageNumber)]}),
                    ...resolvedPagePlanByNumber.get(plan.pageNumber),
                    pageMetadataPath: '',
                };
            }),
        }));
        const rasterHandoff = await resolveRasterHandoff(rasterPlans.map(plan => ({
            renderDpi: plan.dpi,
            raster: plan.guardrail,
        })), scratch, dependencies.getAvailableScratchBytes, supportsRasterStreaming
            ? policy.rasterConcurrency
            : rasterPlans.length);
        logRasterHandoff(log, 'final', rasterHandoff);
        const pageDpi = new Map<number, number>();
        const trustedMrcLayersByPage = new Map<number, IPdfMrcLayers>();
        const trustedForegroundCandidates = rasterPlans.filter(plan => {
            const pageOverride = getScanCleanupPageOverride(
                request.options.pageOverrides,
                plan.pageNumber,
            );
            return request.options.outputMode === 'auto'
                && request.options.thickness === 0
                && request.options.autoDewarp !== true
                && pageOverride.outputModeOverride === undefined
                && pageOverride.rotationDegrees === 0
                && (pageOverride.manualZones?.picture.length ?? 0) === 0
                && (pageOverride.manualZones?.fill.length ?? 0) === 0
                && detectedRasterByPage.get(plan.pageNumber)?.hasBilevelLayer === true
                && (
                    plan.resolvedOutputMode === 'bw'
                    || plan.resolvedOutputMode === 'mixed'
                );
        });
        if (trustedForegroundCandidates.length > 0) {
            emitProgress('extracting', 0, trustedForegroundCandidates.length, []);
            const extractionStartedAt = performance.now();
            if (dependencies.extractMrcLayersBatch !== undefined) {
                try {
                    const layers = await dependencies.extractMrcLayersBatch({
                        pdfPath: prepared.pdfPath,
                        targets: trustedForegroundCandidates.map(plan => ({
                            pageNumber: plan.pageNumber,
                            selectionMaskOutputPath:
                                join(scratch, `source-${plan.pageNumber}-mrc-selection.jb2e`),
                            backgroundOutputPath:
                                join(scratch, `source-${plan.pageNumber}-mrc-background.ppm`),
                            foregroundOutputPath:
                                join(scratch, `source-${plan.pageNumber}-mrc-foreground.jp2`),
                        })),
                        pdfimagesBinary: paths.pdfimagesBinary,
                        qpdfBinary: paths.qpdfBinary,
                        pdfImageCombineBinary: paths.pdfImageCombineBinary,
                        pdftoppmBinary: paths.pdftoppmBinary,
                        runCommand: dependencies.runCommand,
                        log,
                        rasterConcurrency: policy.rasterConcurrency,
                        signal,
                        onProgress: (completedPages, totalPages) =>
                            emitProgress('extracting', completedPages, totalPages),
                    });
                    for (const [
                        pageNumber,
                        layer,
                    ] of layers) {
                        trustedMrcLayersByPage.set(pageNumber, layer);
                    }
                } catch (error) {
                    warn(
                        'Compact source layers could not be read in a batch; '
                        + `using raster reconstruction (${getErrorMessage(error)})`,
                    );
                    emitProgress(
                        'extracting',
                        trustedForegroundCandidates.length,
                        trustedForegroundCandidates.length,
                    );
                }
            } else {
                if (dependencies.extractMrcLayers === undefined) {
                    throw new Error('PDF MRC layer extraction is unavailable');
                }
                const extractMrcLayers = dependencies.extractMrcLayers;
                let completedExtractions = 0;
                await mapScanCleanupRasterPages(
                    trustedForegroundCandidates,
                    policy.rasterConcurrency,
                    async plan => {
                        try {
                            const layers = await extractMrcLayers({
                                pdfPath: prepared.pdfPath,
                                pageNumber: plan.pageNumber,
                                selectionMaskOutputPath:
                                    join(scratch, `source-${plan.pageNumber}-mrc-selection.png`),
                                backgroundOutputPath:
                                    join(scratch, `source-${plan.pageNumber}-mrc-background.png`),
                                foregroundOutputPath:
                                    join(scratch, `source-${plan.pageNumber}-mrc-foreground.jp2`),
                                pdfimagesBinary: paths.pdfimagesBinary,
                                runCommand: dependencies.runCommand,
                                log,
                                signal,
                            });
                            if (layers !== null) {
                                trustedMrcLayersByPage.set(plan.pageNumber, layers);
                            }
                        } catch (error) {
                            warn(
                                `Page ${String(plan.pageNumber)} could not reuse its compact MRC foreground; `
                                + `using raster reconstruction (${getErrorMessage(error)})`,
                            );
                        } finally {
                            completedExtractions += 1;
                            emitProgress(
                                'extracting',
                                completedExtractions,
                                trustedForegroundCandidates.length,
                            );
                        }
                    },
                );
            }
            log(
                'debug',
                'Scan cleanup source-layer extraction reused '
                + `${String(trustedMrcLayersByPage.size)}/${String(trustedForegroundCandidates.length)} `
                + `candidate page(s) [${[...trustedMrcLayersByPage.keys()].join(',')}] `
                + `in ${(performance.now() - extractionStartedAt).toFixed(0)} ms`,
            );
        }
        const pageInputs = rasterPlans.map(plan => {
            pageDpi.set(plan.pageNumber, plan.dpi);
            const extension = rasterHandoff.format;
            const inputPath = join(scratch, `source-${plan.pageNumber}.${extension}`);
            const detectedRaster = detectedRasterByPage.get(plan.pageNumber);
            const trustedMrcLayers = trustedMrcLayersByPage.get(plan.pageNumber);
            return {
                inputPath,
                ...(trustedMrcLayers === undefined
                    ? {}
                    : {
                        trustedForegroundMaskPath: trustedMrcLayers.selectionMaskPath,
                        trustedMrcBackgroundPath: trustedMrcLayers.backgroundPath,
                    }),
                pageNumber: plan.pageNumber,
                dpi: plan.dpi,
                sourceDpi: plan.sourceDpi,
                sourceHasBilevelLayer: detectedRaster?.hasBilevelLayer ?? false,
                ...(detectedRaster?.backgroundDpi === undefined
                    ? {}
                    : {sourceBackgroundDpi: detectedRaster.backgroundDpi}),
                requestedRenderDpi: plan.requestedRenderDpi,
                ...(plan.resolvedOutputMode === undefined ? {} : {resolvedOutputMode: plan.resolvedOutputMode}),
                ...(request.softAlphaForegroundRecommendations?.[String(plan.pageNumber)] === undefined
                    ? {}
                    : {preferSoftAlphaForeground:
                        request.softAlphaForegroundRecommendations[String(plan.pageNumber)]}),
                ...(request.layoutByPage?.[String(plan.pageNumber)] === undefined
                    ? {}
                    : {observedLayout: request.layoutByPage[String(plan.pageNumber)]}),
                ...resolvedPagePlanByNumber.get(plan.pageNumber),
                pageMetadataPath: join(scratch, `clean-${plan.pageNumber}-page.json`),
                outputs: [
                    0,
                    1,
                ].map(outputIndex => ({
                    outputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}.png`),
                    metadataPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}.json`),
                    bilevelOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}.pbm`),
                    backgroundOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}-background.ppm`),
                    foregroundMaskOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}-mask.pbm`),
                    foregroundAlphaOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}-alpha.pgm`),
                })),
            };
        });
        // A document whose geometry cannot be read has no canvas to match, and
        // the preview showed none either: matching is dropped rather than
        // letting the sidecar invent one from the largest output it happens to
        // produce, which is a rectangle the user was never shown — and the run
        // says so, because pages of differing size are exactly what the setting
        // was turned on to prevent.
        const options = documentCanvas === null && request.options.matchPageSize
            ? {
                ...request.options,
                matchPageSize: false,
            }
            : request.options;
        // A geometry read that failed outright already said so, with the reason
        // it failed; this names the other way a document answers no canvas.
        if (options !== request.options && pageSizes !== null) {
            const droppedWarning = resolveScanCleanupDroppedMatchWarning(pageSizes, request.options);
            if (droppedWarning) warn(droppedWarning);
        }
        // One manifest for the whole document keeps page-size matching global.
        // On POSIX, raw PPM inputs are FIFOs: Poppler produces each page while
        // the native worker consumes it, so PDF rendering and cleanup overlap
        // without changing a pixel or padding each worker window separately.
        const canStreamRasters = supportsRasterStreaming
            && rasterHandoff.format === 'ppm'
            && dependencies.createRasterPipes !== undefined;
        const manifest = buildNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            hostMemoryBytes: policy.totalRamBytes,
            ...(canStreamRasters ? {rasterWindow: policy.rasterConcurrency} : {}),
            options,
            ...(documentCanvas === null ? {} : {documentCanvas}),
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: pageInputs,
            // A run may consume handoff rasters the preview retention already
            // rendered outside this scratch; every legitimate input lives
            // under the same temp root.
            allowedPathRoot: paths.tempDir,
        });
        const pages = manifest.pages;
        const manifestPath = join(scratch, 'cleanup-manifest.json');
        await writeFile(manifestPath, JSON.stringify(manifest));
        rasterStreamingRun = canStreamRasters;
        let rasterizedCount = 0;
        const rasterizedPageNumbers = new Set<number>();
        emitProgress(canStreamRasters ? 'rendering' : 'rasterizing', 0, pageCount, []);
        const rasterize = async (operationSignal: AbortSignal) => {
            await mapScanCleanupRasterPages(rasterPlans, policy.rasterConcurrency, async (plan, index) => {
                operationSignal.throwIfAborted();
                const page = pageInputs[index]!;
                const renderer = rasterHandoff.format === 'ppm'
                    ? dependencies.renderPagePpm
                    : dependencies.renderPage;
                const guardrail = plan.guardrail!;
                const limits: IScanCleanupRasterRenderLimits = {
                    expectedWidthPx: Math.max(1, Math.ceil(guardrail.width * plan.dpi / guardrail.dpi)),
                    expectedHeightPx: Math.max(1, Math.ceil(guardrail.height * plan.dpi / guardrail.dpi)),
                    maxPixels: resolveScanCleanupPipelineMaxPixels(plan.resolvedOutputMode),
                    maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
                };
                await renderer(
                    paths,
                    log,
                    plan.pageNumber,
                    prepared.pdfPath,
                    page.inputPath,
                    plan.dpi,
                    undefined,
                    operationSignal,
                    undefined,
                    limits,
                );
                if (!canStreamRasters) {
                    const dimensions = rasterHandoff.format === 'ppm'
                        ? await readPpmDimensions(page.inputPath)
                        : await readPngDimensions(page.inputPath);
                    if (
                        dimensions.width > limits.maxDimensionPx
                        || dimensions.height > limits.maxDimensionPx
                        || dimensions.width * dimensions.height > limits.maxPixels
                    ) {
                        throw new Error(
                            `Scan cleanup page ${String(plan.pageNumber)} raster dimensions `
                            + `${String(dimensions.width)}x${String(dimensions.height)} exceed limits`,
                        );
                    }
                }
                rasterizedCount += 1;
                rasterizedPageNumbers.add(plan.pageNumber);
                if (!canStreamRasters) {
                    emitProgress('rasterizing', rasterizedCount, pageCount, rasterizedPageNumbers);
                }
            });
        };
        const renderedPageNumbers = new Set<number>();
        const sourcePageNumberByManifestIndex = new Map(pages.map((page, index) => [
            index + 1,
            page.sourcePageIndex + 1,
        ]));
        const reportNativeProgress = (
            _progress: TScanCleanupProgress,
            nativeProgress: TNativeScanCleanupProgressV3,
        ) => {
            if (nativeProgress.stage !== 'page-complete') {
                return;
            }
            if (nativeProgress.pageNumber !== undefined) {
                const sourcePageNumber = sourcePageNumberByManifestIndex.get(nativeProgress.pageNumber);
                if (sourcePageNumber === undefined) {
                    throw new Error(
                        `Native cleanup reported unknown manifest page index ${String(nativeProgress.pageNumber)}`,
                    );
                }
                renderedPageNumbers.add(sourcePageNumber);
            }
            emitProgress('rendering', renderedPageNumbers.size, pageCount, renderedPageNumbers);
        };
        await runRasterProducerConsumer({
            signal,
            stream: canStreamRasters,
            ...(canStreamRasters ? {createStreams: () => dependencies.createRasterPipes!(
                pageInputs.map(page => page.inputPath),
                signal,
                log,
            )} : {}),
            produce: rasterize,
            consume: operationSignal => dependencies.runSidecar(
                paths.scanCleanupBinary,
                manifestPath,
                operationSignal,
                log,
                reportNativeProgress,
            ),
            onProducerComplete: () => {
                if (!canStreamRasters) {
                    emitProgress('rendering', renderedPageNumbers.size, pageCount, renderedPageNumbers);
                }
            },
        });
        emitProgress('collecting', 0, pages.length, []);
        const outputPages: IRenderedCleanupOutputPage[] = [];
        const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
        const emptyOutputMappings: IScanCleanupOutputMapping[] = [];
        const summary = createEmptyScanCleanupSummary(pageCount, warnings);
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            const {outputs} = page;
            const pageMetadata = decodeNativeScanCleanupPageMetadataJson(
                await readFile(page.pageMetadataPath, 'utf8'),
            );
            const sourcePageNumber = pageNumbers[pageIndex]!;
            pageMetadataBySource.set(sourcePageNumber, pageMetadata);
            emitProgress('collecting', pageIndex + 1, pages.length);
            if (pageMetadata.excluded) {
                summary.excludedPages += 1;
                emptyOutputMappings.push({
                    sourcePage: sourcePageNumber,
                    half: 'full',
                    outputOrdinal: null,
                    rotationDegrees: pageMetadata.rotationDegrees ?? 0,
                    excluded: true,
                    blank: false,
                });
                continue;
            }
            summary.blankPagesSkipped += pageMetadata.blankOutputsSkipped;
            const pageOutputPages: typeof outputPages = [];
            let intentionallyBlankOutputCount = 0;
            for (const [
                outputIndex,
                output,
            ] of outputs.entries()) {
                // The sidecar publishes one raster per output and writes this
                // metadata beside it, so its absence means the output half was
                // never produced.
                let metadataJson: string;
                try {
                    metadataJson = await readFile(output.metadataPath, 'utf8');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    // Native resolves only the first output_count destinations
                    // for this page. The remaining plan entries are not
                    // produced outputs; when native also reports blank outputs,
                    // retain their explicit empty mapping below.
                    if (outputIndex >= pageMetadata.outputCount) {
                        if (pageMetadata.blankOutputsSkipped > 0) {
                            intentionallyBlankOutputCount += 1;
                        }
                        continue;
                    }
                    throw new ScanCleanupMissingOutputError(
                        sourcePageNumber,
                        output.metadataPath,
                        'output metadata',
                        getErrorMessage(error),
                    );
                }
                const metadata = decodeNativeScanCleanupOutputMetadataJson(metadataJson);
                const pageNumber = sourcePageNumber;
                let bilevelPath: string | undefined;
                let backgroundPath: string | undefined;
                let foregroundMaskPath: string | undefined;
                let foregroundAlphaPath: string | undefined;
                let backgroundIsColor: boolean | undefined;
                if (metadata.layeredWritten) {
                    backgroundPath = await requireProducedRasterFile(
                        requirePublishedRaster,
                        output.backgroundOutputPath,
                        pageNumber,
                        'mixed background layer',
                    );
                    if (metadata.layeredForegroundKind === 'soft-alpha') {
                        foregroundAlphaPath = await requireProducedRasterFile(
                            requirePublishedRaster,
                            output.foregroundAlphaOutputPath,
                            pageNumber,
                            'mixed soft foreground alpha',
                        );
                    } else {
                        foregroundMaskPath = await requireProducedRasterFile(
                            requirePublishedRaster,
                            output.foregroundMaskOutputPath,
                            pageNumber,
                            'mixed foreground mask',
                        );
                    }
                    const [
                        backgroundHeader,
                        foregroundHeader,
                    ] = await Promise.all([
                        readPpmDimensions(backgroundPath),
                        foregroundAlphaPath === undefined
                            ? readPbmDimensions(foregroundMaskPath!)
                            : readPpmDimensions(foregroundAlphaPath),
                    ]);
                    const renderDpi = metadata.renderDpi
                        ?? pageDpi.get(pageNumber)
                        ?? documentDpi;
                    const backgroundDpi = metadata.layeredBackgroundDpi;
                    const foregroundDpi = metadata.layeredForegroundKind === 'soft-alpha'
                        ? metadata.layeredForegroundDpi
                        : renderDpi;
                    if (
                        !Number.isFinite(renderDpi)
                        || renderDpi <= 0
                        || backgroundDpi === undefined
                        || !Number.isFinite(backgroundDpi)
                        || backgroundDpi <= 0
                        || foregroundDpi === undefined
                        || !Number.isFinite(foregroundDpi)
                        || foregroundDpi <= 0
                    ) {
                        throw new Error(`Page ${pageNumber} mixed layer DPI metadata is invalid`);
                    }
                    const expectedBackgroundWidth = Math.max(
                        1,
                        Math.round(metadata.canvasWidthPx * backgroundDpi / renderDpi),
                    );
                    const expectedBackgroundHeight = Math.max(
                        1,
                        Math.round(metadata.canvasHeightPx * backgroundDpi / renderDpi),
                    );
                    const expectedForegroundWidth = Math.max(
                        1,
                        Math.round(metadata.canvasWidthPx * foregroundDpi / renderDpi),
                    );
                    const expectedForegroundHeight = Math.max(
                        1,
                        Math.round(metadata.canvasHeightPx * foregroundDpi / renderDpi),
                    );
                    if (
                        foregroundHeader.width !== expectedForegroundWidth
                        || foregroundHeader.height !== expectedForegroundHeight
                        || backgroundHeader.width !== expectedBackgroundWidth
                        || backgroundHeader.height !== expectedBackgroundHeight
                    ) {
                        throw new Error(
                            `Page ${pageNumber} mixed layer dimensions do not match metadata `
                            + `(background ${backgroundHeader.width}x${backgroundHeader.height}, `
                            + `expected ${expectedBackgroundWidth}x${expectedBackgroundHeight}; `
                            + `foreground ${foregroundHeader.width}x${foregroundHeader.height}, `
                            + `expected ${expectedForegroundWidth}x${expectedForegroundHeight})`,
                        );
                    }
                    backgroundIsColor = backgroundHeader.isColor;
                } else if (metadata.bilevelWritten) {
                    bilevelPath = await requireProducedRasterFile(
                        requirePublishedRaster,
                        output.bilevelOutputPath,
                        pageNumber,
                        'bilevel output',
                    );
                } else {
                    await requireProducedRasterFile(
                        requirePublishedRaster,
                        output.outputPath,
                        pageNumber,
                        'composite output',
                    );
                }
                const renderedOutput: Omit<IRenderedCleanupOutputPage, 'preservedSource'> = {
                    sourcePageNumber: pageNumber,
                    path: output.outputPath,
                    ...(bilevelPath === undefined ? {} : {bilevelPath}),
                    ...(backgroundPath === undefined ? {} : {backgroundPath}),
                    ...(foregroundMaskPath === undefined ? {} : {foregroundMaskPath}),
                    ...(foregroundAlphaPath === undefined ? {} : {foregroundAlphaPath}),
                    ...(backgroundIsColor === undefined ? {} : {backgroundIsColor}),
                    dpi: metadata.renderDpi
                        ?? pageDpi.get(pageNumbers[pageIndex]!)
                        ?? documentDpi,
                    // The engine reports the mode it actually rendered with,
                    // which is the only authority once `auto` resolves natively.
                    resolvedOutputMode: metadata.outputMode
                        ?? resolvedOutputModeByPage.get(pageNumbers[pageIndex]!)
                        ?? 'color',
                    metadata,
                };
                const preservedSource = resolveCompactSourcePreservation(
                    request,
                    pageNumber,
                    pageMetadata,
                    renderedOutput,
                    pageSizes?.[pageNumber - 1],
                    detectedRasterByPage.get(pageNumber),
                );
                pageOutputPages.push({
                    ...renderedOutput,
                    ...(preservedSource === undefined ? {} : {preservedSource}),
                });
                if (!metadata.skewApplied) summary.deskewSkipped += 1;
                if (request.options.crop && metadata.contentBox == null) summary.cropSkipped += 1;
                // The engine's own account of what it had to do to this page —
                // a page it could not hold at the document's scale, a raster it
                // could not publish. It travels with the summary and is logged
                // here, so a run that quietly compromised says where.
                for (const warning of metadata.warnings ?? []) {
                    const reported = `Page ${String(pageNumbers[pageIndex]!)}: ${warning}`;
                    summary.warnings.push(reported);
                    log('warn', `Scan cleanup: ${reported}`);
                }
            }
            if (request.options.readingOrder === 'rtl' && pageMetadata.layoutClassification === 'two-page-spread') {
                pageOutputPages.reverse();
            }
            outputPages.push(...pageOutputPages);
            if (intentionallyBlankOutputCount > 0 && pageOutputPages.length > 0) {
                for (const half of resolveBlankOutputHalves(
                    pageMetadata,
                    pageOutputPages,
                    intentionallyBlankOutputCount,
                )) {
                    emptyOutputMappings.push({
                        sourcePage: sourcePageNumber,
                        half,
                        outputOrdinal: null,
                        rotationDegrees: pageMetadata.rotationDegrees ?? 0,
                        excluded: false,
                        blank: true,
                    });
                }
            } else if (pageOutputPages.length === 0) {
                emptyOutputMappings.push({
                    sourcePage: sourcePageNumber,
                    half: 'full',
                    outputOrdinal: null,
                    rotationDegrees: pageMetadata.rotationDegrees ?? 0,
                    excluded: false,
                    blank: true,
                });
            }
            if (pageMetadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
            if (pageMetadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
        }
        summary.outputPages = outputPages.length;
        if (outputPages.length === 0) throw new Error('evb-scan-cleanup produced no output pages');
        const combineManifestPages = outputPages.map(output => {
            const pageWidthPoints = output.metadata.matchedCanvasTargetWidthPoints
                ?? output.metadata.canvasWidthPx / output.dpi * 72;
            const pageHeightPoints = output.metadata.matchedCanvasTargetHeightPoints
                ?? output.metadata.canvasHeightPx / output.dpi * 72;
            const pageSize = [
                pageWidthPoints.toFixed(6),
                pageHeightPoints.toFixed(6),
            ];
            const imagePlacement = output.metadata.pdfImagePlacement;
            if (
                imagePlacement !== undefined
                && (output.bilevelPath !== undefined || output.backgroundPath !== undefined)
            ) {
                throw new Error(
                    `Page ${String(output.sourcePageNumber)} attached continuous-tone placement `
                    + 'to a bilevel or layered page',
                );
            }
            const placementFields = imagePlacement === undefined
                ? []
                : validatePdfImagePlacement(
                    imagePlacement,
                    pageWidthPoints,
                    pageHeightPoints,
                    output.sourcePageNumber,
                ).map(value => value.toFixed(6));
            if (output.bilevelPath !== undefined) {
                return [
                    'image-bilevel',
                    ...pageSize,
                    output.bilevelPath,
                ].join('\t');
            }
            if (
                output.backgroundPath !== undefined
                && output.foregroundAlphaPath !== undefined
            ) {
                return [
                    'soft-layered-jpeg',
                    ...pageSize,
                    output.backgroundIsColor
                        ? SCAN_CLEANUP_COLOR_JPEG_QUALITY
                        : SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
                    output.backgroundPath,
                    output.foregroundAlphaPath,
                ].join('\t');
            }
            if (
                output.backgroundPath !== undefined
                && output.foregroundMaskPath !== undefined
            ) {
                if (output.metadata.layeredForegroundKind === 'source-mrc') {
                    const layers = trustedMrcLayersByPage.get(output.sourcePageNumber);
                    if (layers === undefined) {
                        throw new Error(
                            `Page ${String(output.sourcePageNumber)} published source-MRC metadata `
                            + 'without its extracted source layers',
                        );
                    }
                    const matrix = sourceMrcForegroundPdfMatrix(
                        output,
                        layers,
                        pageWidthPoints,
                        pageHeightPoints,
                    );
                    return [
                        'affine-masked-layered-jpeg',
                        ...pageSize,
                        output.backgroundIsColor
                            ? SCAN_CLEANUP_COLOR_JPEG_QUALITY
                            : SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
                        output.backgroundPath,
                        layers.foregroundPath,
                        layers.selectionMaskPath,
                        ...matrix.map(value => value.toFixed(10)),
                        layers.selectionMaskDecode,
                    ].join('\t');
                }
                return [
                    'layered-jpeg',
                    ...pageSize,
                    output.backgroundIsColor
                        ? SCAN_CLEANUP_COLOR_JPEG_QUALITY
                        : SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
                    output.backgroundPath,
                    output.foregroundMaskPath,
                ].join('\t');
            }
            const jpegQuality = resolveTonalJpegQuality(output.resolvedOutputMode);
            return (jpegQuality === undefined
                ? [
                    'image',
                    ...pageSize,
                    output.path,
                    ...placementFields,
                ]
                : [
                    'image-jpeg',
                    ...pageSize,
                    jpegQuality,
                    output.path,
                    ...placementFields,
                ]).join('\t');
        });
        const hasCompactSourcePages = outputPages.some(output => output.preservedSource !== undefined);
        const outputMappings: IScanCleanupOutputMapping[] = outputPages.map((output, outputIndex) => ({
            sourcePage: output.sourcePageNumber,
            half: output.metadata.half ?? 'full',
            outputOrdinal: outputIndex + 1,
            rotationDegrees: output.metadata.rotationDegrees ?? 0,
            excluded: false,
            blank: false,
        }));
        outputMappings.push(...emptyOutputMappings);
        const effectiveOptions = pages.map((page, index) => ({
            sourcePage: pageNumbers[index]!,
            options: materializeScanCleanupStampOptions({
                nativeOptions: page.options,
                options,
                qualityPath: 'raster',
            }),
        }));
        const pagePlanDigests = effectiveOptions.map(record => buildScanCleanupPagePlanDigest(
            record.sourcePage,
            record.options,
            pageMetadataBySource.get(record.sourcePage) ?? {excluded: true},
        ));
        const assemblerBackend = request.assemblyBackend
            ?? paths.assemblyBackend
            ?? (hasCompactSourcePages
                ? isScanCleanupCliFallbackSentinel(paths.pdfPageOpsBinary)
                    ? 'cli-fallback-qpdf-page-ops'
                    : 'native-pdf-page-ops'
                : isScanCleanupCliFallbackSentinel(paths.pdfImageCombineBinary)
                    ? 'cli-fallback-wasm-or-img2pdf-qpdf'
                    : 'native-pdf-image-combine');
        const transportMode = request.transportMode
            ?? paths.transportMode
            ?? (canStreamRasters && rasterHandoff.format === 'ppm'
                ? 'fifo-ppm'
                : rasterHandoff.format === 'ppm' ? 'file-ppm' : 'file-png');
        const buildIds = await buildScanCleanupStampBuildIds({
            paths,
            assemblerBackend,
            transportMode,
            ...(dependencies.hashNativeBinary === undefined
                ? {}
                : {hashNativeBinary: dependencies.hashNativeBinary}),
        });
        const stamp = buildScanCleanupProvenanceStamp({
            sourceSha256: await sha256ScanCleanupFile(prepared.pdfPath),
            effectiveOptions,
            outputMappings,
            pagePlanDigests,
            buildIds,
        });
        const provenanceStampHex = encodeScanCleanupProvenanceStampHex(stamp);
        await writeFile(join(scratch, 'scan-cleanup-provenance-stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
        const combineManifest = buildScanCleanupCompactManifest(
            combineManifestPages,
            provenanceStampHex,
        );
        const combineManifestEnvelopePath = join(scratch, 'combine-manifest.json');
        const combineManifestLegacyPath = join(scratch, 'combine-manifest.tsv');
        await Promise.all([
            writeFile(
                combineManifestEnvelopePath,
                serializeScanCleanupCompactManifest(combineManifest),
            ),
            writeFile(
                combineManifestLegacyPath,
                serializeLegacyScanCleanupCompactManifest(combineManifest),
            ),
        ]);
        const combineManifestPath = paths.provenanceStampSupport === false
            ? combineManifestLegacyPath
            : combineManifestEnvelopePath;
        emitProgress('assembling', 0, outputPages.length, []);
        const rasterizedPdfPath = hasCompactSourcePages
            ? join(scratch, 'rasterized-cleaned.pdf')
            : stagedPdfPath;
        await dependencies.runCommand(paths.pdfImageCombineBinary, [
            '--output',
            rasterizedPdfPath,
            '--compact-manifest',
            combineManifestPath,
            '--json-progress',
        ], {
            signal,
            commandLabel: 'evb-pdf-image-combine(scan-cleanup)',
            timeoutMs: 10 * 60 * 1000,
            env: {
                ...process.env,
                EVB_PDF_COMBINE_MAX_PAGES: String(Math.max(outputPages.length, 1)),
                EVB_PDF_COMBINE_MAX_OUTPUT_BYTES: String(resolveCombineOutputByteCap(outputPages.length)),
            },
            onStdout: createPdfCombineProgressHandler(
                outputPages.length,
                (processed, total) => emitProgress('assembling', processed, total),
                line => log('debug', `Ignoring malformed scan cleanup combine progress: ${line}`),
            ),
            log,
        });
        await assembleWithCompactSourcePages(
            outputPages,
            paths,
            prepared.pdfPath,
            rasterizedPdfPath,
            stagedPdfPath,
            scratch,
            signal,
            log,
            dependencies,
            provenanceStampHex,
        );
        const [
            sourceFile,
            outputFile,
        ] = await Promise.all([
            stat(prepared.pdfPath),
            stat(stagedPdfPath),
        ]);
        if (outputFile.size <= 0) throw new Error('PDF assembler produced an empty file');
        const compactSourceBudget = resolveScanCleanupCompactSourceBudget({
            documentPageCount,
            options: request.options,
            pageRasterByNumber: detectedRasterByPage,
            partialRun: request.sourcePageNumbers !== undefined,
            sourceBytes: sourceFile.size,
        });
        const streamBytesByOutput = new Map<IRenderedCleanupOutputPage, NonNullable<
            IScanCleanupOutputPageForSummary['streamBytes']
        >>();
        await Promise.all(outputPages.map(async output => {
            const [
                composite,
                bilevel,
                background,
                foregroundMask,
                foregroundAlpha,
            ] = await Promise.all([
                readOptionalFileSize(output.path),
                output.bilevelPath === undefined
                    ? Promise.resolve(undefined)
                    : readOptionalFileSize(output.bilevelPath),
                output.backgroundPath === undefined
                    ? Promise.resolve(undefined)
                    : readOptionalFileSize(output.backgroundPath),
                output.foregroundMaskPath === undefined
                    ? Promise.resolve(undefined)
                    : readOptionalFileSize(output.foregroundMaskPath),
                output.foregroundAlphaPath === undefined
                    ? Promise.resolve(undefined)
                    : readOptionalFileSize(output.foregroundAlphaPath),
            ]);
            streamBytesByOutput.set(output, {
                ...(composite === undefined ? {} : {composite}),
                ...(bilevel === undefined ? {} : {bilevel}),
                ...(background === undefined ? {} : {background}),
                ...(foregroundMask === undefined ? {} : {foregroundMask}),
                ...(foregroundAlpha === undefined ? {} : {foregroundAlpha}),
            });
        }));
        const representationReport = {
            schemaVersion: 1 as const,
            sourceBytes: sourceFile.size,
            outputBytes: outputFile.size,
            outputToSourceByteRatio: outputFile.size / sourceFile.size,
            compactSourceBudget,
            outputMappings,
            pages: outputPages.map((output, outputIndex) => {
                const sourceRaster = detectedRasterByPage.get(output.sourcePageNumber);
                return {
                    outputPageNumber: outputIndex + 1,
                    outputOrdinal: outputIndex + 1,
                    sourcePageNumber: output.sourcePageNumber,
                    semanticMode: output.resolvedOutputMode,
                    representation: output.preservedSource !== undefined
                        ? 'preserved-compact-source'
                        : output.bilevelPath !== undefined
                            ? 'bilevel'
                            : output.backgroundPath !== undefined
                                ? 'mixed'
                                : output.resolvedOutputMode,
                    preservationReason: output.preservedSource?.reason ?? null,
                    sourceDpi: sourceDpiByPage.get(output.sourcePageNumber) ?? null,
                    sourceBackgroundDpi: sourceRaster?.backgroundDpi ?? null,
                    renderDpi: output.dpi,
                    illuminationNormalized: output.metadata.illuminationNormalized === true,
                    textToneApplied: output.metadata.textToneDiagnostics?.applied === true,
                    binarizationMode: output.metadata.binarizationMode ?? null,
                    half: output.metadata.half ?? 'full',
                    rotationDegrees: output.metadata.rotationDegrees ?? 0,
                    excluded: false,
                    blank: false,
                    ...(streamBytesByOutput.get(output) === undefined
                        ? {}
                        : {streamBytes: streamBytesByOutput.get(output)!}),
                };
            }),
        } satisfies IScanCleanupRepresentationReport;
        await writeFile(
            join(scratch, 'scan-cleanup-representation-report.json'),
            JSON.stringify(representationReport, null, 2),
        );
        assertScanCleanupCompactSourceBudget(outputFile.size, compactSourceBudget);
        await validateStagedPdf(paths.qpdfBinary, stagedPdfPath, signal, log, dependencies.runCommand);
        emitProgress('handoff', 0, pageCount, []);
        await copyFile(stagedPdfPath, publishTempPath);
        if (signal.aborted) throw signal.reason;
        await rename(publishTempPath, request.outputPdfPath);
        emitProgress('handoff', pageCount, pageCount, pageNumbers);
        return summary;
    } catch (error) {
        if (error instanceof ScanCleanupPdfValidationError) {
            preserveScratchForDiagnostics = true;
        }
        throw error;
    } finally {
        await rm(publishTempPath, {force: true}).catch(() => undefined);
        await preserveScanCleanupJsonEvidence(scratch, log).catch(error => {
            log('warn', `Failed to preserve scan cleanup JSON evidence: ${getErrorMessage(error)}`);
        });
        if (!preserveScratchForDiagnostics) {
            await rm(scratch, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        } else {
            log('warn', `Preserving invalid staged scan cleanup PDF for diagnostics: ${stagedPdfPath}`);
        }
    }
}
