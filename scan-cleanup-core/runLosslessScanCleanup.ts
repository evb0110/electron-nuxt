import {
    readFile,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import type {
    INativeScanCleanupAnalysisOutputV3,
    INativeScanCleanupPageMetadataV3,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {
    resolveSourceDpi,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
    type IPdfPageSize,
    type ISourceDpiDetectionResult,
    type TScanCleanupLog,
} from '@scan-cleanup-core/types';
import {buildNativeScanCleanupManifest} from '@scan-cleanup-core/policy/buildNativeScanCleanupManifest';
import {
    CANVAS_CONTENT_SCALE_EPSILON,
    type IScanCleanupRect,
    mapLosslessAnalysisRectToPdf,
    placeUniformBox,
    resolveScanCleanupCanvasFitScale,
    resolveScanCleanupDocumentCanvas,
    resolveScanCleanupDroppedMatchWarning,
    resolveScanCleanupPageCanvasBox,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@scan-cleanup-core/policy/documentCanvas';
import {createPagePlanResolver} from '@scan-cleanup-core/createPagePlanResolver';
import type {TEmitScanCleanupProgress} from '@scan-cleanup-core/createScanCleanupProgressReporter';
import {createEmptyScanCleanupSummary} from '@scan-cleanup-core/createScanCleanupProgressReporter';
import {
    logRasterHandoff,
    mapScanCleanupRasterPages,
    resolveRasterHandoff,
} from '@scan-cleanup-core/resolveRasterHandoff';

const REPORTED_PAGE_NUMBER_LIMIT = 20;

function describePageNumbers(pageNumbers: readonly number[]) {
    return pageNumbers.length <= REPORTED_PAGE_NUMBER_LIMIT
        ? pageNumbers.join(', ')
        : `${pageNumbers.slice(0, REPORTED_PAGE_NUMBER_LIMIT).join(', ')} and ${String(pageNumbers.length - REPORTED_PAGE_NUMBER_LIMIT)} more`;
}

export async function runLosslessScanCleanup(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    preparedPdfPath: string,
    preparedWarnings: string[],
    pageNumbers: number[],
    pageSizes: readonly IPdfPageSize[],
    dpiDetails: ISourceDpiDetectionResult,
    scratch: string,
    stagedPdfPath: string,
    signal: AbortSignal,
    emitProgress: TEmitScanCleanupProgress,
    log: TScanCleanupLog,
    policy: IScanCleanupRuntimePolicy,
    dependencies: IRunScanCleanupPipelineDependencies,
) {
    if (!paths.pdfPageOpsBinary) {
        throw new Error('evb-pdf-page-ops is unavailable for lossless scan cleanup');
    }
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
    const pagePlanResolver = createPagePlanResolver(request, log, 'lossless');
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
            ...pagePlanResolver.resolve(plan.pageNumber),
            pageMetadataPath: join(scratch, `analysis-${plan.pageNumber}.json`),
        };
    });
    pagePlanResolver.report();
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
        if (!pageSize) {
            throw new Error(`evb-pdf-page-ops returned no geometry for page ${String(sourcePageNumber)}`);
        }
        const outputs = (metadata.outputs ?? []).map(output => ({
            half: output.half,
            cropRect: mapLosslessAnalysisRectToPdf(
                output.cropRect,
                output.inputWidthPx,
                output.inputHeightPx,
                metadata.rotationDegrees,
                pageSize,
            ),
            paperRect: mapLosslessAnalysisRectToPdf(
                output.sourceRegion,
                output.inputWidthPx,
                output.inputHeightPx,
                metadata.rotationDegrees,
                pageSize,
            ),
        }));
        if (request.options.readingOrder === 'rtl' && metadata.layoutClassification === 'two-page-spread') {
            outputs.reverse();
        }
        analyzedPages.push({
            sourcePageIndex: sourcePageNumber - 1,
            rotationQuarterTurns: pageOverride.rotationDegrees / 90,
            outputs,
            pageOverride,
            pageSize,
        });
    }
    const allOutputs = analyzedPages.flatMap(page => page.outputs);
    if (allOutputs.length === 0) {
        throw new Error('evb-scan-cleanup analysis produced no output pages');
    }
    const documentCanvas = request.options.matchPageSize
        ? resolveScanCleanupDocumentCanvas(
            pageSizes,
            SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
            request.options,
            request.layoutByPage,
        )
        : null;
    if (documentCanvas === null && request.options.matchPageSize) {
        const droppedWarning = resolveScanCleanupDroppedMatchWarning(pageSizes, request.options);
        if (droppedWarning) warn(droppedWarning);
    }
    const scaledRasterPages = new Set<number>();
    const fittedPageWarnings: string[] = [];
    if (documentCanvas) {
        for (const page of analyzedPages) {
            const box = resolveScanCleanupPageCanvasBox(
                documentCanvas,
                page.pageSize,
                page.pageOverride.rotationDegrees,
            );
            for (const output of page.outputs) {
                const paperScale = resolveScanCleanupCanvasFitScale(box, {
                    widthPoints: output.paperRect.width,
                    heightPoints: output.paperRect.height,
                });
                const fit = Math.min(1, resolveScanCleanupCanvasFitScale(box, {
                    widthPoints: output.cropRect.width * paperScale,
                    heightPoints: output.cropRect.height * paperScale,
                }));
                const scale = paperScale * fit;
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
                const alignment = page.pageOverride.placementOverrides?.[output.half]
                    ?? request.options.pageAlignment;
                if (Math.abs(scale - 1) <= CANVAS_CONTENT_SCALE_EPSILON) {
                    output.cropRect = placeUniformBox(
                        output.cropRect,
                        box.widthPoints,
                        box.heightPoints,
                        alignment,
                    );
                    continue;
                }
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
                if (dpiDetails.pageRasterByNumber.has(page.sourcePageIndex + 1)) {
                    scaledRasterPages.add(page.sourcePageIndex + 1);
                }
            }
        }
    }
    if (scaledRasterPages.size > 0) {
        warn(
            `Matched page size scaled ${String(scaledRasterPages.size)} page(s) that carry their own raster `
            + `without re-rendering them: ${describePageNumbers([...scaledRasterPages])}`,
        );
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
