import {
    copyFile,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import {
    dirname,
    join,
} from 'path';
import type {
    INativeScanCleanupAnalysisOutputV3,
    INativeScanCleanupOutputMetadataV3,
    INativeScanCleanupPageMetadataV3,
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupSourcePageMetadata,
    TNativeScanCleanupProgressV3,
    TScanCleanupLayoutByPage,
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import type { IScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import { getErrorMessage } from '@contracts/getErrorMessage';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import { getPdfPageCount } from '@electron/pdf/pdfPageCount';
import {
    readPdfPageSizes,
    type IPdfPageSize,
} from '@electron/pdf/pdfPageSizes';
import {
    detectSourceDpiFromPageSizes,
    detectSourceDpiDetails,
    resolveSourceDpi,
} from '@electron/pdf/sourceDpiDetection';
import {
    renderPdfPageToPng,
    renderPdfPageToPpm,
} from '@electron/ocr/worker/popplerStage';
import { createPdfCombineProgressHandler } from '@electron/native-tools/createPdfCombineProgressHandler';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import {
    requirePublishedRaster,
    runScanCleanupSidecar,
} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {buildNativeScanCleanupManifest} from '@electron/features/scan-cleanup/policy/buildNativeScanCleanupManifest';
import {
    CANVAS_CONTENT_SCALE_EPSILON,
    type IScanCleanupRect,
    mapLosslessAnalysisRectToPdf,
    placeUniformBox,
    resolveScanCleanupCanvasFitScale,
    resolveScanCleanupDocumentCanvas,
    resolveScanCleanupDroppedMatchWarning,
    resolveMatchedCanvasResamplePages,
    resolveScanCleanupPageCanvasBox,
    resolveScanCleanupUnclassifiedPages,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@electron/features/scan-cleanup/policy/documentCanvas';
import {
    resolveTonalJpegQuality,
    SCAN_CLEANUP_COLOR_JPEG_QUALITY,
    SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
    resolveScanCleanupCanvasPageDpi,
    resolveScanCleanupDocumentGuardrail,
    resolveScanCleanupPipelineMaxPixels,
    resolveScanCleanupPlannedDpi,
    resolveReusablePagePlan,
    SCAN_CLEANUP_SIZE_PROBE_DPI,
} from '@electron/features/scan-cleanup/policy/effectiveOptions';
import {
    readPbmDimensions,
    readPngDimensions,
    readPpmDimensions,
} from '@electron/features/scan-cleanup/worker/rasterLayerDimensions';
import type { TEmitScanCleanupProgress } from '@electron/features/scan-cleanup/worker/createScanCleanupProgressReporter';
import {
    createEmptyScanCleanupSummary,
    createScanCleanupProgressReporter,
} from '@electron/features/scan-cleanup/worker/createScanCleanupProgressReporter';
import {
    logRasterHandoff,
    mapScanCleanupRasterPages,
    readAvailableScratchBytes,
    resolveCombineOutputByteCap,
    resolveRasterHandoff,
    runRasterProducerConsumer,
} from '@electron/features/scan-cleanup/worker/resolveRasterHandoff';

export interface IScanCleanupWorkerPaths {
    qpdfBinary: string;
    pdftoppmBinary: string;
    pdfimagesBinary?: string;
    pdfinfoBinary?: string;
    scanCleanupBinary: string;
    pdfImageCombineBinary: string;
    pdfPageOpsBinary?: string;
    tempDir: string;
}

export interface IRunScanCleanupPipelineRequest {
    sourcePdfPath: string;
    outputPdfPath: string;
    options: IScanCleanupOptions;
    sourcePageNumbers?: number[];
    outputModeRecommendations?: Partial<Record<string, TScanCleanupOutputMode>>;
    /**
     * What the renderer has already observed about how each page is cut. The
     * matched canvas is measured over produced pages, so a spread has to be
     * measured as the two half sheets it becomes; the preview measures it from
     * the same map, which is what makes the two agree.
     */
    layoutByPage?: TScanCleanupLayoutByPage;
    sourcePageMetadataByPage?: Partial<Record<string, IScanCleanupSourcePageMetadata>>;
    pagePlanEvidenceByPage?: Partial<Record<string, IScanCleanupPagePlanEvidence>>;
}

export interface IRunScanCleanupPipelineDependencies {
    getPageCount: typeof getPdfPageCount;
    detectSourceDpi: typeof detectSourceDpiDetails;
    createRasterPipes?: (
        paths: readonly string[],
        signal: AbortSignal,
        log: TWorkerLog,
    ) => Promise<void>;
    renderPage: typeof renderPdfPageToPng;
    renderPagePpm: typeof renderPdfPageToPpm;
    runSidecar: typeof runScanCleanupSidecar;
    runCommand: typeof runNativeToolCommand;
    getAvailableScratchBytes: typeof readAvailableScratchBytes;
}

const defaultDependencies: IRunScanCleanupPipelineDependencies = {
    getPageCount: getPdfPageCount,
    detectSourceDpi: detectSourceDpiDetails,
    createRasterPipes: async (paths, signal, log) => {
        await runNativeToolCommand('mkfifo', [...paths], {
            signal,
            commandLabel: 'mkfifo(scan-cleanup-raster-streams)',
            log,
        });
    },
    renderPage: renderPdfPageToPng,
    renderPagePpm: renderPdfPageToPpm,
    runSidecar: runScanCleanupSidecar,
    runCommand: runNativeToolCommand,
    getAvailableScratchBytes: readAvailableScratchBytes,
};

// A scan is hundreds of pages long, so a warning about most of them says how
// many and where it starts rather than printing a list nobody reads.
const REPORTED_PAGE_NUMBER_LIMIT = 20;

function describePageNumbers(pageNumbers: readonly number[]) {
    return pageNumbers.length <= REPORTED_PAGE_NUMBER_LIMIT
        ? pageNumbers.join(', ')
        : `${pageNumbers.slice(0, REPORTED_PAGE_NUMBER_LIMIT).join(', ')} and ${String(pageNumbers.length - REPORTED_PAGE_NUMBER_LIMIT)} more`;
}

async function runLosslessScanCleanup(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    preparedPdfPath: string,
    preparedWarnings: string[],
    pageNumbers: number[],
    pageSizes: readonly IPdfPageSize[],
    dpiDetails: Awaited<ReturnType<typeof detectSourceDpiDetails>>,
    scratch: string,
    stagedPdfPath: string,
    signal: AbortSignal,
    emitProgress: TEmitScanCleanupProgress,
    log: TWorkerLog,
    policy: IScanCleanupRuntimePolicy,
    dependencies: IRunScanCleanupPipelineDependencies,
) {
    if (!paths.pdfPageOpsBinary) throw new Error('evb-pdf-page-ops is unavailable for lossless scan cleanup');
    const documentDpi = resolveSourceDpi(dpiDetails.documentDpi);
    const rasterPlans = pageNumbers.map(pageNumber => {
        const detected = dpiDetails.pageRasterByNumber.get(pageNumber);
        const dpi = resolveSourceDpi(detected?.dpi, documentDpi);
        return {
            pageNumber,
            dpi,
            raster: detected === undefined
                ? undefined
                : {
                    dpi: resolveSourceDpi(detected.dpi, documentDpi),
                    width: detected.width,
                    height: detected.height,
                },
        };
    });
    const rasterHandoff = await resolveRasterHandoff(rasterPlans.map(plan => ({
        renderDpi: plan.dpi,
        raster: plan.raster,
    })), scratch, dependencies.getAvailableScratchBytes);
    logRasterHandoff(log, 'lossless analysis', rasterHandoff);
    let rasterizedCount = 0;
    const rasterizedPageNumbers = new Set<number>();
    emitProgress('rasterizing', 0, pageNumbers.length, []);
    const pageInputs = await mapScanCleanupRasterPages(rasterPlans, policy.rasterConcurrency, async plan => {
        signal.throwIfAborted();
        const extension = rasterHandoff.format;
        const inputPath = join(scratch, `analysis-${plan.pageNumber}.${extension}`);
        const renderer = extension === 'ppm'
            ? dependencies.renderPagePpm
            : dependencies.renderPage;
        await renderer(
            paths,
            log,
            plan.pageNumber,
            preparedPdfPath,
            inputPath,
            plan.dpi,
            undefined,
            signal,
        );
        rasterizedCount += 1;
        rasterizedPageNumbers.add(plan.pageNumber);
        emitProgress('rasterizing', rasterizedCount, pageNumbers.length, rasterizedPageNumbers);
        return {
            inputPath,
            pageNumber: plan.pageNumber,
            dpi: plan.dpi,
            ...(request.layoutByPage?.[String(plan.pageNumber)] === undefined
                ? {}
                : {observedLayout: request.layoutByPage[String(plan.pageNumber)]}),
            ...resolveReusablePagePlan(
                request.options,
                request.layoutByPage,
                request.pagePlanEvidenceByPage,
                plan.pageNumber,
            ),
            pageMetadataPath: join(scratch, `analysis-${plan.pageNumber}.json`),
        };
    });
    const manifest = buildNativeScanCleanupManifest({
        operation: 'analyze',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'lossless',
        hostMemoryBytes: policy.totalRamBytes,
        options: request.options,
        experimental: {
            autoDewarp: request.options.autoDewarp ?? false,
            ...(request.options.autoDewarpDepth === undefined
                ? {}
                : {autoDewarpDepth: request.options.autoDewarpDepth}),
        },
        pages: pageInputs,
    });
    const pages = manifest.pages;
    const manifestPath = join(scratch, 'lossless-analysis-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    emitProgress('classifying', 0, pageNumbers.length, []);
    const classifiedPageNumbers = new Set<number>();
    await dependencies.runSidecar(paths.scanCleanupBinary, manifestPath, signal, log, (_progress, nativeProgress) => {
        if (nativeProgress.pageNumber !== undefined) {
            classifiedPageNumbers.add(pageNumbers[nativeProgress.pageNumber - 1]!);
        }
        emitProgress('classifying', classifiedPageNumbers.size, pageNumbers.length, classifiedPageNumbers);
    });
    emitProgress('collecting', 0, pages.length, []);

    const summary = createEmptyScanCleanupSummary(pageNumbers.length, preparedWarnings);
    // What this path tells the user reaches them through the summary, and the
    // same sentence belongs in the log — the same pairing the raster path uses.
    const warn = (message: string) => {
        summary.warnings.push(message);
        log('warn', `Scan cleanup: ${message}`);
    };
    const analyzedPages: Array<{
        sourcePageIndex: number;
        rotationQuarterTurns: number;
        outputs: Array<{
            half: INativeScanCleanupAnalysisOutputV3['half'];
            cropRect: IScanCleanupRect;
            /** This output's share of the sheet, in the page's own PDF user space. */
            paperRect: IScanCleanupRect;
            contentTransform?: {
                scale: number;
                translateX: number;
                translateY: number;
            };
        }>;
        pageOverride: ReturnType<typeof getScanCleanupPageOverride>;
        pageSize: IPdfPageSize;
    }> = [];
    for (const [
        index,
        page,
    ] of pages.entries()) {
        const metadata = JSON.parse(await readFile(page.pageMetadataPath, 'utf8')) as INativeScanCleanupPageMetadataV3;
        emitProgress('collecting', index + 1, pages.length);
        const sourcePageNumber = pageNumbers[index]!;
        const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, sourcePageNumber);
        if (metadata.excluded) {
            summary.excludedPages += 1;
            continue;
        }
        if (metadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
        if (metadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
        const pageSize = pageSizes[sourcePageNumber - 1];
        if (!pageSize) throw new Error(`evb-pdf-page-ops returned no geometry for page ${String(sourcePageNumber)}`);
        const outputs = (metadata.outputs ?? []).map(output => ({
            half: output.half,
            cropRect: mapLosslessAnalysisRectToPdf(
                output.cropRect,
                output.inputWidthPx,
                output.inputHeightPx,
                metadata.rotationDegrees,
                pageSize,
            ),
            // The paper this output owns, not the content that survived
            // cropping: a spread half owns half the sheet, and that is what
            // matched page size scales onto the document rectangle.
            paperRect: mapLosslessAnalysisRectToPdf(
                output.sourceRegion,
                output.inputWidthPx,
                output.inputHeightPx,
                metadata.rotationDegrees,
                pageSize,
            ),
        }));
        if (request.options.readingOrder === 'rtl' && metadata.layoutClassification === 'two-page-spread') outputs.reverse();
        analyzedPages.push({
            sourcePageIndex: sourcePageNumber - 1,
            rotationQuarterTurns: pageOverride.rotationDegrees / 90,
            outputs,
            pageOverride,
            pageSize,
        });
    }
    const allOutputs = analyzedPages.flatMap(page => page.outputs);
    if (allOutputs.length === 0) throw new Error('evb-scan-cleanup analysis produced no output pages');
    // This path reaches the canvas by scaling the page's own objects, not by
    // resampling them: a page that is physically smaller than the document is
    // enlarged onto the shared rectangle with its own content streams, fonts
    // and images intact. Pages that would need their pixels resampled to reach
    // the shared grid never get here — the run rendered instead. The pixel grid
    // is still derived, so the plan the preview showed and the plan this run
    // uses are the same object.
    const documentCanvas = request.options.matchPageSize
        ? resolveScanCleanupDocumentCanvas(
            pageSizes,
            SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
            request.options,
            request.layoutByPage,
        )
        : null;
    // A matched run that ends up without a rectangle cleans every page at its
    // own size, which is what the setting was turned on to prevent: the raster
    // path names that, and so does this one.
    if (documentCanvas === null && request.options.matchPageSize) {
        const droppedWarning = resolveScanCleanupDroppedMatchWarning(pageSizes, request.options);
        if (droppedWarning) warn(droppedWarning);
    }
    const scaledRasterPages = new Set<number>();
    const fittedPageWarnings: string[] = [];
    if (documentCanvas) {
        for (const page of analyzedPages) {
            // The canvas is one rectangle for the whole document, in the
            // orientation the reader sees. split-pages writes the box in the
            // page's own unrotated space and keeps the source rotation plus this
            // page's override, so the box that displays as the canvas is the
            // canvas turned back by the same amount. It already contains every
            // page's content and margins, so nothing here grows it for one page.
            const box = resolveScanCleanupPageCanvasBox(
                documentCanvas,
                page.pageSize,
                page.pageOverride.rotationDegrees,
            );
            for (const output of page.outputs) {
                // How far the paper this output owns is from the document's. A
                // half sheet is measured as a half sheet, so a spread's halves
                // land on the canvas at the same scale as a page that was
                // scanned on its own; paper that already is the canvas keeps
                // its content exactly where it is, and the common case still
                // writes nothing but a box.
                const paperScale = resolveScanCleanupCanvasFitScale(box, {
                    widthPoints: output.paperRect.width,
                    heightPoints: output.paperRect.height,
                });
                // Margins laid around cropped content can ask for more room
                // than the document rectangle has. The rectangle is fixed, so
                // the page is scaled to fit rather than clipped at the box
                // edge — the policy the raster path applies to the same
                // overflow. A page that fits pays nothing: this is 1.
                const fit = Math.min(1, resolveScanCleanupCanvasFitScale(box, {
                    widthPoints: output.cropRect.width * paperScale,
                    heightPoints: output.cropRect.height * paperScale,
                }));
                const scale = paperScale * fit;
                // Paper larger than the document rectangle is the one way this
                // page can be below the document's scale without overflowing
                // it: the canvas was measured from the layout the run expected
                // for this page — a spread's half sheet — and analysis then cut
                // the sheet differently, so the whole sheet is placed inside a
                // rectangle measured for part of it. Nothing is clipped and the
                // grid stays uniform; the page is simply smaller than its
                // neighbours, which is only visible if the run says so.
                if (paperScale < 1 - CANVAS_CONTENT_SCALE_EPSILON) {
                    fittedPageWarnings.push(
                        `Page ${String(page.sourcePageIndex + 1)}: Matched page size placed this page at `
                        + `${(paperScale * 100).toFixed(1)}% of the document's scale because its `
                        + `${output.paperRect.width.toFixed(1)}x${output.paperRect.height.toFixed(1)} pt paper is larger `
                        + `than the ${box.widthPoints.toFixed(1)}x${box.heightPoints.toFixed(1)} pt document canvas, `
                        + 'which was measured from a different layout for this page',
                    );
                }
                if (fit < 1 - CANVAS_CONTENT_SCALE_EPSILON) {
                    fittedPageWarnings.push(
                        `Page ${String(page.sourcePageIndex + 1)}: Matched page size fitted this page to `
                        + `${(output.cropRect.width * scale).toFixed(1)}x${(output.cropRect.height * scale).toFixed(1)} pt `
                        + `inside the ${box.widthPoints.toFixed(1)}x${box.heightPoints.toFixed(1)} pt document canvas, `
                        + 'below the document\'s scale',
                    );
                }
                const alignment = page.pageOverride.placementOverrides?.[output.half] ?? request.options.pageAlignment;
                if (Math.abs(scale - 1) <= CANVAS_CONTENT_SCALE_EPSILON) {
                    output.cropRect = placeUniformBox(
                        output.cropRect,
                        box.widthPoints,
                        box.heightPoints,
                        alignment,
                    );
                    continue;
                }
                // The content is scaled first and then laid out on the canvas,
                // so the box is the canvas exactly and the transform is what
                // carries the page's own objects into it.
                const placed = placeUniformBox(
                    {
                        x: output.cropRect.x * scale,
                        y: output.cropRect.y * scale,
                        width: output.cropRect.width * scale,
                        height: output.cropRect.height * scale,
                    },
                    box.widthPoints,
                    box.heightPoints,
                    alignment,
                );
                output.contentTransform = {
                    scale,
                    translateX: -placed.x,
                    translateY: -placed.y,
                };
                output.cropRect = {
                    x: 0,
                    y: 0,
                    width: box.widthPoints,
                    height: box.heightPoints,
                };
                // The run decided before analysis which pages could keep their
                // own pixels, from the layout it was told to expect. A page that
                // turns out to be cut differently and carries a raster is scaled
                // here without being resampled, which is the one case where a
                // matched lossless document can hold two visual resolutions.
                if (dpiDetails.pageRasterByNumber.has(page.sourcePageIndex + 1)) {
                    scaledRasterPages.add(page.sourcePageIndex + 1);
                }
            }
        }
    }
    if (scaledRasterPages.size > 0) {
        warn(`Matched page size scaled ${String(scaledRasterPages.size)} page(s) that carry their own raster without re-rendering them: ${describePageNumbers([...scaledRasterPages])}`);
    }
    for (const warning of fittedPageWarnings) warn(warning);
    summary.outputPages = allOutputs.length;
    const instructionsPath = join(scratch, 'split-pages.json');
    await writeFile(instructionsPath, JSON.stringify({pages: analyzedPages.map(page => ({
        sourcePageIndex: page.sourcePageIndex,
        rotationQuarterTurns: page.rotationQuarterTurns,
        outputs: page.outputs.map(output => ({
            cropRect: output.cropRect,
            ...(output.contentTransform ? {contentTransform: output.contentTransform} : {}),
        })),
    }))}));
    emitProgress('assembling', 0, allOutputs.length, []);
    await dependencies.runCommand(paths.pdfPageOpsBinary, [
        'split-pages',
        '--input',
        preparedPdfPath,
        '--output',
        stagedPdfPath,
        '--instructions-file',
        instructionsPath,
    ], {
        signal,
        commandLabel: 'evb-pdf-page-ops(split-pages:scan-cleanup)',
        timeoutMs: 10 * 60 * 1000,
        log,
    });
    emitProgress('assembling', allOutputs.length, allOutputs.length);
    return summary;
}

export async function runScanCleanupPipeline(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    signal: AbortSignal,
    onProgress: (progress: TScanCleanupProgress) => void,
    policy: IScanCleanupRuntimePolicy,
    log: TWorkerLog = () => undefined,
    dependencies: IRunScanCleanupPipelineDependencies = defaultDependencies,
): Promise<TScanCleanupSummary> {
    const scratch = await mkdtemp(join(paths.tempDir, 'scan-cleanup-'));
    const sessionId = randomUUID();
    const stagedPdfPath = join(scratch, 'cleaned.pdf');
    const publishTempPath = join(dirname(request.outputPdfPath), `.${sessionId}.scan-cleanup.tmp`);
    // Set once the run knows which assembler it is actually using: a matched
    // lossless run whose pages cannot keep their own pixels renders instead.
    let losslessRun = request.options.preserveOriginalQuality === true;
    const emitProgress = createScanCleanupProgressReporter(onProgress, () => losslessRun);
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
        const pageNumbers = request.sourcePageNumbers === undefined
            ? Array.from({length: documentPageCount}, (_, index) => index + 1)
            : [...request.sourcePageNumbers];
        const documentPageNumbers = Array.from(
            {length: documentPageCount},
            (_, index) => index + 1,
        );
        if (
            pageNumbers.length === 0
            || pageNumbers.some(pageNumber => pageNumber > documentPageCount)
        ) {
            throw new Error('Scan cleanup source page scope is outside the document');
        }
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
            throw new Error('evb-pdf-page-ops is unavailable for lossless scan cleanup');
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
        if (
            pageSizes === null
            && (request.options.preserveOriginalQuality === true || request.options.matchPageSize)
        ) {
            try {
                if (!paths.pdfPageOpsBinary && !paths.pdfinfoBinary) {
                    throw new Error('no PDF tool is available to read page geometry');
                }
                pageSizes = await readPdfPageSizes(prepared.pdfPath, {
                    log,
                    pdfPageOpsBinary: paths.pdfPageOpsBinary,
                    pdfinfoBinary: paths.pdfinfoBinary,
                    runCommand: dependencies.runCommand,
                    signal,
                    tempDir: scratch,
                });
            } catch (error) {
                if (signal.aborted || request.options.preserveOriginalQuality === true) throw error;
                warn(`Matched page size was dropped: this document's page geometry could not be measured (${getErrorMessage(error)})`);
            }
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
        const dpiDetails = metadataDpiDetails ?? await dependencies.detectSourceDpi(
            prepared.pdfPath,
            paths.pdfimagesBinary,
            log,
            undefined,
            signal,
            dpiProbePages,
            (completedPages, totalPages) => emitProgress('probing', completedPages, totalPages),
        );
        if (metadataDpiDetails) {
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
                pageSizes!,
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
        for (const pageNumber of plannedPageNumbers) {
            const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, pageNumber);
            if (pageOverride.excluded) {
                resolvedOutputModeByPage.set(pageNumber, 'color');
                continue;
            }
            const configuredMode = pageOverride.outputModeOverride ?? request.options.outputMode;
            if (configuredMode !== 'auto') {
                resolvedOutputModeByPage.set(pageNumber, configuredMode);
                continue;
            }
            // Pages without a recommendation stay `auto`: the single final
            // render resolves them natively from full-resolution evidence and
            // reports the resolution back through the page metadata.
            const recommendation = request.outputModeRecommendations?.[String(pageNumber)];
            if (recommendation !== undefined) resolvedOutputModeByPage.set(pageNumber, recommendation);
        }
        const requiresBilevelQuality = (pageNumber: number) => {
            const mode = resolvedOutputModeByPage.get(pageNumber);
            return mode === undefined || mode === 'bw' || mode === 'mixed';
        };
        // Pixel guardrails come from the pdfimages raster row for detected
        // pages; only undetected pages that may produce a binary layer (and
        // therefore take the synthesis DPI floor) pay for a 72-DPI probe.
        const guardrailByPage = new Map<number, {
            dpi: number;
            width: number;
            height: number
        }>();
        for (const pageNumber of pageNumbers) {
            const detected = detectedRasterByPage.get(pageNumber);
            if (detected === undefined) continue;
            guardrailByPage.set(pageNumber, {
                dpi: sourceDpiByPage.get(pageNumber)!,
                width: detected.width,
                height: detected.height,
            });
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
        const rasterPlans = pageNumbers.map(pageNumber => {
            const resolvedOutputMode = resolvedOutputModeByPage.get(pageNumber);
            const guardrail = guardrailByPage.get(pageNumber);
            return {
                pageNumber,
                resolvedOutputMode,
                ...resolveScanCleanupPlannedDpi({
                    sourceDpi: sourceDpiByPage.get(pageNumber)!,
                    hasDetectedRaster: detectedRasterByPage.has(pageNumber),
                    carriesBinaryLayer: requiresBilevelQuality(pageNumber),
                    maxPixels: resolveScanCleanupPipelineMaxPixels(resolvedOutputMode),
                    guardrail,
                }),
                guardrail,
            };
        });
        const supportsRasterStreaming = process.platform !== 'win32'
            && dependencies.createRasterPipes !== undefined;
        const rasterHandoff = await resolveRasterHandoff(rasterPlans.map(plan => ({
            renderDpi: plan.dpi,
            raster: plan.guardrail,
        })), scratch, dependencies.getAvailableScratchBytes, supportsRasterStreaming
            ? policy.rasterConcurrency
            : rasterPlans.length);
        logRasterHandoff(log, 'final', rasterHandoff);
        const pageDpi = new Map<number, number>();
        const pageInputs = rasterPlans.map(plan => {
            pageDpi.set(plan.pageNumber, plan.dpi);
            const extension = rasterHandoff.format;
            const inputPath = join(scratch, `source-${plan.pageNumber}.${extension}`);
            return {
                inputPath,
                pageNumber: plan.pageNumber,
                dpi: plan.dpi,
                sourceDpi: plan.sourceDpi,
                requestedRenderDpi: plan.requestedRenderDpi,
                ...(plan.resolvedOutputMode === undefined ? {} : {resolvedOutputMode: plan.resolvedOutputMode}),
                ...(request.layoutByPage?.[String(plan.pageNumber)] === undefined
                    ? {}
                    : {observedLayout: request.layoutByPage[String(plan.pageNumber)]}),
                ...resolveReusablePagePlan(
                    request.options,
                    request.layoutByPage,
                    request.pagePlanEvidenceByPage,
                    plan.pageNumber,
                ),
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
                })),
            };
        });
        // The rectangle the preview presented, on the finest resolution the
        // *document* is rendered at, so it has one output DPI and no page is
        // resampled below the detail it arrived with. Every input is a property
        // of the document — page geometry, the raster rows pdfimages reported
        // for all of it, the output modes the document is *configured* with —
        // and never the size probe a run renders for its own scope nor the
        // per-page modes detection recommended, which is what makes a
        // selection's grid the grid a full run writes and the grid of a run
        // started before detection settled the grid of one started after.
        const finestCanvasDpi = canvasPageNumbers.reduce((finest, pageNumber) => {
            const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, pageNumber);
            return pageOverride.excluded ? finest : Math.max(finest, resolveScanCleanupCanvasPageDpi({
                configuredMode: pageOverride.outputModeOverride ?? request.options.outputMode,
                sourceDpi: sourceDpiByPage.get(pageNumber)!,
                hasDetectedRaster: detectedRasterByPage.has(pageNumber),
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
        const canvasDpi = documentCanvas && documentCanvas.widthPoints > 0
            ? documentCanvas.widthPx / documentCanvas.widthPoints * 72
            : finestCanvasDpi;
        if (canvasDpi < finestCanvasDpi * 0.99) {
            warn(
                `Matched page size normalized this document at ${String(Math.round(canvasDpi))} DPI `
                + `instead of the ${String(Math.round(finestCanvasDpi))} DPI its finest page was rendered at, `
                + 'to keep one shared page inside the output pixel budget',
            );
        }
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
        const manifest = buildNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            hostMemoryBytes: policy.totalRamBytes,
            options,
            ...(documentCanvas === null ? {} : {documentCanvas}),
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: pageInputs,
        });
        const pages = manifest.pages;
        const manifestPath = join(scratch, 'cleanup-manifest.json');
        await writeFile(manifestPath, JSON.stringify(manifest));
        const canStreamRasters = supportsRasterStreaming
            && rasterHandoff.format === 'ppm'
            && dependencies.createRasterPipes !== undefined;
        let rasterizedCount = 0;
        const rasterizedPageNumbers = new Set<number>();
        emitProgress('rasterizing', 0, pageCount, []);
        const rasterize = async (operationSignal: AbortSignal) => {
            await mapScanCleanupRasterPages(rasterPlans, policy.rasterConcurrency, async (plan, index) => {
                operationSignal.throwIfAborted();
                const page = pageInputs[index]!;
                const renderer = rasterHandoff.format === 'ppm'
                    ? dependencies.renderPagePpm
                    : dependencies.renderPage;
                await renderer(
                    paths,
                    log,
                    plan.pageNumber,
                    prepared.pdfPath,
                    page.inputPath,
                    plan.dpi,
                    undefined,
                    operationSignal,
                );
                rasterizedCount += 1;
                rasterizedPageNumbers.add(plan.pageNumber);
                emitProgress('rasterizing', rasterizedCount, pageCount, rasterizedPageNumbers);
            });
        };
        const renderedPageNumbers = new Set<number>();
        let rasterizationFinished = false;
        const reportNativeProgress = (
            _progress: TScanCleanupProgress,
            nativeProgress: TNativeScanCleanupProgressV3,
        ) => {
            if (nativeProgress.stage !== 'page-complete') {
                return;
            }
            if (nativeProgress.pageNumber !== undefined) {
                renderedPageNumbers.add(pageNumbers[nativeProgress.pageNumber - 1]!);
            }
            if (rasterizationFinished) {
                emitProgress('rendering', renderedPageNumbers.size, pageCount, renderedPageNumbers);
            }
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
                rasterizationFinished = true;
                emitProgress('rendering', renderedPageNumbers.size, pageCount, renderedPageNumbers);
            },
        });
        emitProgress('collecting', 0, pages.length, []);
        const outputPages: Array<{
            path: string;
            bilevelPath?: string;
            backgroundPath?: string;
            foregroundMaskPath?: string;
            backgroundIsColor?: boolean;
            dpi: number;
            resolvedOutputMode: TScanCleanupOutputMode;
            metadata: INativeScanCleanupOutputMetadataV3
        }> = [];
        const summary = createEmptyScanCleanupSummary(pageCount, warnings);
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            const {outputs} = page;
            const pageMetadata = JSON.parse(await readFile(page.pageMetadataPath, 'utf8')) as INativeScanCleanupPageMetadataV3;
            emitProgress('collecting', pageIndex + 1, pages.length);
            if (pageMetadata.excluded) {
                summary.excludedPages += 1;
                continue;
            }
            summary.blankPagesSkipped += pageMetadata.blankOutputsSkipped;
            const pageOutputPages: typeof outputPages = [];
            for (const output of outputs) {
                // The sidecar publishes one raster per output and writes this
                // metadata beside it, so its absence means the output half was
                // never produced.
                let metadataJson: string;
                try {
                    metadataJson = await readFile(output.metadataPath, 'utf8');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    continue;
                }
                const metadata = JSON.parse(metadataJson) as INativeScanCleanupOutputMetadataV3;
                const pageNumber = pageNumbers[pageIndex]!;
                let bilevelPath: string | undefined;
                let backgroundPath: string | undefined;
                let foregroundMaskPath: string | undefined;
                let backgroundIsColor: boolean | undefined;
                if (metadata.layeredWritten) {
                    backgroundPath = await requirePublishedRaster(
                        output.backgroundOutputPath,
                        pageNumber,
                        'mixed background layer',
                    );
                    foregroundMaskPath = await requirePublishedRaster(
                        output.foregroundMaskOutputPath,
                        pageNumber,
                        'mixed foreground mask',
                    );
                    const [
                        backgroundHeader,
                        maskHeader,
                    ] = await Promise.all([
                        readPpmDimensions(backgroundPath),
                        readPbmDimensions(foregroundMaskPath),
                    ]);
                    const renderDpi = metadata.renderDpi
                        ?? pageDpi.get(pageNumber)
                        ?? documentDpi;
                    const backgroundDpi = metadata.layeredBackgroundDpi;
                    if (
                        !Number.isFinite(renderDpi)
                        || renderDpi <= 0
                        || backgroundDpi === undefined
                        || !Number.isFinite(backgroundDpi)
                        || backgroundDpi <= 0
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
                    if (
                        maskHeader.width !== metadata.canvasWidthPx
                        || maskHeader.height !== metadata.canvasHeightPx
                        || backgroundHeader.width !== expectedBackgroundWidth
                        || backgroundHeader.height !== expectedBackgroundHeight
                    ) {
                        throw new Error(
                            `Page ${pageNumber} mixed layer dimensions do not match metadata `
                            + `(background ${backgroundHeader.width}x${backgroundHeader.height}, `
                            + `expected ${expectedBackgroundWidth}x${expectedBackgroundHeight}; `
                            + `mask ${maskHeader.width}x${maskHeader.height}, `
                            + `expected ${metadata.canvasWidthPx}x${metadata.canvasHeightPx})`,
                        );
                    }
                    backgroundIsColor = backgroundHeader.isColor;
                } else if (metadata.bilevelWritten) {
                    bilevelPath = await requirePublishedRaster(
                        output.bilevelOutputPath,
                        pageNumber,
                        'bilevel output',
                    );
                } else {
                    await requirePublishedRaster(output.outputPath, pageNumber, 'composite output');
                }
                pageOutputPages.push({
                    path: output.outputPath,
                    ...(bilevelPath === undefined ? {} : {bilevelPath}),
                    ...(backgroundPath === undefined ? {} : {backgroundPath}),
                    ...(foregroundMaskPath === undefined ? {} : {foregroundMaskPath}),
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
            if (pageMetadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
            if (pageMetadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
        }
        summary.outputPages = outputPages.length;
        if (outputPages.length === 0) throw new Error('evb-scan-cleanup produced no output pages');
        const combineManifestPath = join(scratch, 'combine-manifest.tsv');
        await writeFile(combineManifestPath, outputPages.map(output => {
            const pageSize = [
                (output.metadata.matchedCanvasTargetWidthPoints
                ?? output.metadata.canvasWidthPx / output.dpi * 72).toFixed(6),
                (output.metadata.matchedCanvasTargetHeightPoints
                ?? output.metadata.canvasHeightPx / output.dpi * 72).toFixed(6),
            ];
            if (output.bilevelPath !== undefined) {
                return [
                    'image-bilevel',
                    ...pageSize,
                    output.bilevelPath,
                ].join('\t');
            }
            if (
                output.backgroundPath !== undefined
                && output.foregroundMaskPath !== undefined
            ) {
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
                ]
                : [
                    'image-jpeg',
                    ...pageSize,
                    jpegQuality,
                    output.path,
                ]).join('\t');
        }).join('\n') + '\n');
        emitProgress('assembling', 0, outputPages.length, []);
        await dependencies.runCommand(paths.pdfImageCombineBinary, [
            '--output',
            stagedPdfPath,
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
        if ((await stat(stagedPdfPath)).size <= 0) throw new Error('PDF assembler produced an empty file');
        emitProgress('handoff', 0, pageCount, []);
        await copyFile(stagedPdfPath, publishTempPath);
        if (signal.aborted) throw signal.reason;
        await rename(publishTempPath, request.outputPdfPath);
        emitProgress('handoff', pageCount, pageCount, pageNumbers);
        return summary;
    } finally {
        await rm(publishTempPath, {force: true}).catch(() => undefined);
        await rm(scratch, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}
