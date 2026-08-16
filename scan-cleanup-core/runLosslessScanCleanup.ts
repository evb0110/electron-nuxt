import {
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import type {
    INativeScanCleanupAnalysisOutputV3,
    INativeScanCleanupPageMetadataV3,
} from '@contracts/electronApiScanCleanup';
import {decodeNativeScanCleanupPageMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
} from '@contracts/scanCleanupPageOverrides';
import {
    resolveSourceDpi,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
    type IPdfPageSize,
    type IScanCleanupOutputMapping,
    type IScanCleanupRepresentationReport,
    type ISourceDpiDetectionResult,
    type TScanCleanupLog,
} from '@scan-cleanup-core/types';
import {buildNativeScanCleanupManifest} from '@scan-cleanup-core/policy/buildNativeScanCleanupManifest';
import {
    buildScanCleanupPageOpsInstructions,
    isScanCleanupCliFallbackSentinel,
    serializeLegacyScanCleanupPageOpsInstructions,
    serializeScanCleanupPageOpsInstructions,
} from '@scan-cleanup-core/compactManifest';
import {buildScanCleanupStampBuildIds} from '@scan-cleanup-core/buildManifest';
import {
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    sha256ScanCleanupFile,
} from '@scan-cleanup-core/provenanceStamp';
import {
    CANVAS_CONTENT_SCALE_EPSILON,
    type IScanCleanupRect,
    mapLosslessAnalysisRectToPdf,
    orientScanCleanupInsetsToPageSpace,
    placeUniformBox,
    resolveScanCleanupCanvasFitScale,
    resolveScanCleanupDocumentCanvas,
    resolveScanCleanupDroppedMatchWarning,
    resolveScanCleanupOutputPageSpacePaperRect,
    resolveScanCleanupPageCanvasBox,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@scan-cleanup-core/policy/documentCanvas';
import {createPagePlanResolver} from '@scan-cleanup-core/createPagePlanResolver';
import type {TEmitScanCleanupProgress} from '@scan-cleanup-core/createScanCleanupProgressReporter';
import {createEmptyScanCleanupSummary} from '@scan-cleanup-core/createScanCleanupProgressReporter';
import {ScanCleanupNativeToolUnavailableError} from '@scan-cleanup-core/errors';
import {
    logRasterHandoff,
    mapScanCleanupRasterPages,
    resolveRasterHandoff,
} from '@scan-cleanup-core/resolveRasterHandoff';

const CANONICAL_ANALYSIS_DPI = 150;

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
        throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
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
        renderDpi: CANONICAL_ANALYSIS_DPI,
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
            CANONICAL_ANALYSIS_DPI,
            undefined,
            signal,
        );
        rasterizedCount += 1;
        rasterizedPageNumbers.add(plan.pageNumber);
        emitProgress('rasterizing', rasterizedCount, pageNumbers.length, rasterizedPageNumbers);
        return {
            inputPath,
            analysisInputPath: inputPath,
            analysisDpi: CANONICAL_ANALYSIS_DPI,
            pageNumber: plan.pageNumber,
            dpi: CANONICAL_ANALYSIS_DPI,
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
        // Lossless analysis reads rasters and trusted layers staged by the
        // caller under the shared temp root, not only this scratch.
        allowedPathRoot: paths.tempDir,
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
            contentDetected: boolean;
        }>;
        pageOverride: ReturnType<typeof getScanCleanupPageOverride>;
        pageSize: IPdfPageSize;
    }> = [];
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    for (const [
        index,
        page,
    ] of pages.entries()) {
        const metadata = decodeNativeScanCleanupPageMetadataJson(
            await readFile(page.pageMetadataPath, 'utf8'),
        );
        emitProgress('collecting', index + 1, pages.length);
        const sourcePageNumber = pageNumbers[index]!;
        pageMetadataBySource.set(sourcePageNumber, metadata);
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
        const outputs = (metadata.outputs ?? []).map(output => {
            const paper = resolveScanCleanupOutputPageSpacePaperRect(
                pageSize,
                output.half === 'full' ? 1 : 2,
                pageOverride.rotationDegrees,
            );
            return {
                half: output.half,
                contentDetected: output.contentBox !== undefined,
                cropRect: mapLosslessAnalysisRectToPdf(
                    output.cropRect,
                    output.inputWidthPx,
                    output.inputHeightPx,
                    metadata.rotationDegrees,
                    pageSize,
                ),
                // The cutter selects source pixels; it does not measure the
                // paper. Both spread leaves inherit one half of the oriented
                // source sheet even when their selected regions are unequal.
                paperRect: {
                    x: 0,
                    y: 0,
                    width: paper.widthPoints,
                    height: paper.heightPoints,
                },
            };
        });
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
    const allOutputs = analyzedPages.flatMap(page => page.outputs.map(output => ({
        ...output,
        sourcePageIndex: page.sourcePageIndex,
    })));
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
            const fitMarginAxis = (leading: number, trailing: number, total: number) => {
                const sum = leading + trailing;
                if (sum < total || sum === 0) {
                    return [
                        leading,
                        trailing,
                    ] as const;
                }
                const available = Math.max(0, total - 0.01);
                const fittedLeading = available * leading / sum;
                return [
                    fittedLeading,
                    available - fittedLeading,
                ] as const;
            };
            const marginsMm = resolveScanCleanupMarginsMm(request.options.marginsMm, page.pageOverride);
            const requestedVisualMargins = {
                left: marginsMm.leftMm / 25.4 * 72,
                top: marginsMm.topMm / 25.4 * 72,
                right: marginsMm.rightMm / 25.4 * 72,
                bottom: marginsMm.bottomMm / 25.4 * 72,
            };
            const resolveOutputScale = (output: (typeof page.outputs)[number]) => {
                const requestedMargins = orientScanCleanupInsetsToPageSpace(
                    request.options.crop && output.contentDetected ? requestedVisualMargins : {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    page.pageSize.rotation + page.pageOverride.rotationDegrees,
                );
                const [
                    marginLeft,
                    marginRight,
                ] = fitMarginAxis(requestedMargins.left, requestedMargins.right, box.widthPoints);
                const [
                    marginBottom,
                    marginTop,
                ] = fitMarginAxis(requestedMargins.bottom, requestedMargins.top, box.heightPoints);
                const innerWidth = Math.max(0.01, box.widthPoints - marginLeft - marginRight);
                const innerHeight = Math.max(0.01, box.heightPoints - marginTop - marginBottom);
                const paperScale = resolveScanCleanupCanvasFitScale(box, {
                    widthPoints: output.paperRect.width,
                    heightPoints: output.paperRect.height,
                });
                return paperScale * Math.min(1, resolveScanCleanupCanvasFitScale({
                    widthPoints: innerWidth,
                    heightPoints: innerHeight,
                }, {
                    widthPoints: output.cropRect.width * paperScale,
                    heightPoints: output.cropRect.height * paperScale,
                }));
            };
            const sharedSpreadScale = page.outputs.length === 2
                && page.outputs.some(output => output.half === 'left')
                && page.outputs.some(output => output.half === 'right')
                ? Math.min(...page.outputs.map(resolveOutputScale))
                : null;
            for (const output of page.outputs) {
                const marginsRequested = Object.values(requestedVisualMargins).some(margin => margin > 0);
                const marginsAvailable = request.options.crop && output.contentDetected;
                if (marginsRequested && !marginsAvailable) {
                    fittedPageWarnings.push(
                        `Page ${String(page.sourcePageIndex + 1)}: Requested margins were not applied because `
                        + 'content detection or cropping is unavailable',
                    );
                }
                const requestedMargins = orientScanCleanupInsetsToPageSpace(
                    marginsAvailable ? requestedVisualMargins : {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    page.pageSize.rotation + page.pageOverride.rotationDegrees,
                );
                const [
                    marginLeft,
                    marginRight,
                ] = fitMarginAxis(requestedMargins.left, requestedMargins.right, box.widthPoints);
                const [
                    marginBottom,
                    marginTop,
                ] = fitMarginAxis(requestedMargins.bottom, requestedMargins.top, box.heightPoints);
                if (
                    marginLeft !== requestedMargins.left
                    || marginTop !== requestedMargins.top
                    || marginRight !== requestedMargins.right
                    || marginBottom !== requestedMargins.bottom
                ) {
                    fittedPageWarnings.push(
                        `Page ${String(page.sourcePageIndex + 1)}: Matched page size reduced requested margins `
                        + 'because they leave no drawable canvas',
                    );
                }
                const innerWidth = Math.max(0.01, box.widthPoints - marginLeft - marginRight);
                const innerHeight = Math.max(0.01, box.heightPoints - marginTop - marginBottom);
                const paperScale = resolveScanCleanupCanvasFitScale(box, {
                    widthPoints: output.paperRect.width,
                    heightPoints: output.paperRect.height,
                });
                const leafFit = Math.min(1, resolveScanCleanupCanvasFitScale({
                    widthPoints: innerWidth,
                    heightPoints: innerHeight,
                }, {
                    widthPoints: output.cropRect.width * paperScale,
                    heightPoints: output.cropRect.height * paperScale,
                }));
                const scale = sharedSpreadScale ?? paperScale * leafFit;
                const fit = scale / paperScale;
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
                        + `inside the ${innerWidth.toFixed(1)}x${innerHeight.toFixed(1)} pt margin box, `
                        + 'below the document\'s scale',
                    );
                }
                const alignment = page.pageOverride.placementOverrides?.[output.half]
                    ?? request.options.pageAlignment;
                if (Math.abs(scale - 1) <= CANVAS_CONTENT_SCALE_EPSILON) {
                    const innerBox = placeUniformBox(
                        output.cropRect,
                        innerWidth,
                        innerHeight,
                        alignment,
                    );
                    output.cropRect = {
                        x: innerBox.x - marginLeft,
                        y: innerBox.y - marginBottom,
                        width: box.widthPoints,
                        height: box.heightPoints,
                    };
                    continue;
                }
                const innerBox = placeUniformBox(
                    {
                        x: output.cropRect.x * scale,
                        y: output.cropRect.y * scale,
                        width: output.cropRect.width * scale,
                        height: output.cropRect.height * scale,
                    },
                    innerWidth,
                    innerHeight,
                    alignment,
                );
                const placed = {
                    x: innerBox.x - marginLeft,
                    y: innerBox.y - marginBottom,
                };
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
    const sourceDpiByPage = new Map(rasterPlans.map(plan => [
        plan.pageNumber,
        plan.dpi,
    ]));
    const outputMappings: IScanCleanupOutputMapping[] = allOutputs.map((output, outputIndex) => {
        const sourcePage = output.sourcePageIndex + 1;
        const metadata = pageMetadataBySource.get(sourcePage);
        return {
            sourcePage,
            half: output.half ?? 'full',
            outputOrdinal: outputIndex + 1,
            rotationDegrees: metadata?.rotationDegrees ?? 0,
            excluded: false,
            blank: false,
        };
    });
    for (const pageNumber of pageNumbers) {
        const metadata = pageMetadataBySource.get(pageNumber);
        const hasOutput = outputMappings.some(mapping => mapping.sourcePage === pageNumber);
        if (hasOutput) continue;
        outputMappings.push({
            sourcePage: pageNumber,
            half: 'full',
            outputOrdinal: null,
            rotationDegrees: metadata?.rotationDegrees ?? getScanCleanupPageOverride(
                request.options.pageOverrides,
                pageNumber,
            ).rotationDegrees,
            excluded: metadata?.excluded === true,
            blank: metadata?.excluded !== true,
        });
    }
    const effectiveOptions = pages.map((page, index) => {
        const sourcePage = pageNumbers[index]!;
        const materialized = materializeScanCleanupStampOptions({
            nativeOptions: page.options,
            options: request.options,
            qualityPath: 'lossless',
        });
        return {
            sourcePage,
            options: materialized,
        };
    });
    const pagePlanDigests = effectiveOptions.map(record => buildScanCleanupPagePlanDigest(
        record.sourcePage,
        record.options,
        pageMetadataBySource.get(record.sourcePage) ?? {excluded: true},
    ));
    const buildIds = await buildScanCleanupStampBuildIds({
        paths,
        ...(dependencies.hashNativeBinary === undefined
            ? {}
            : {hashNativeBinary: dependencies.hashNativeBinary}),
        assemblerBackend: request.assemblyBackend
            ?? paths.assemblyBackend
            ?? (isScanCleanupCliFallbackSentinel(paths.pdfPageOpsBinary)
                ? 'cli-fallback-qpdf-page-ops'
                : 'native-pdf-page-ops'),
        transportMode: request.transportMode
            ?? paths.transportMode
            ?? 'source-preserved',
    });
    const stamp = buildScanCleanupProvenanceStamp({
        sourceSha256: await sha256ScanCleanupFile(preparedPdfPath),
        effectiveOptions,
        outputMappings,
        pagePlanDigests,
        buildIds,
    });
    const provenanceStampHex = encodeScanCleanupProvenanceStampHex(stamp);
    await writeFile(join(scratch, 'scan-cleanup-provenance-stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
    const instructionsPath = join(scratch, 'split-pages.json');
    const instructions = buildScanCleanupPageOpsInstructions(analyzedPages.map(page => ({
        sourcePageIndex: page.sourcePageIndex,
        rotationQuarterTurns: page.rotationQuarterTurns,
        outputs: page.outputs.map(output => ({
            cropRect: output.cropRect,
            ...(output.contentTransform ? {contentTransform: output.contentTransform} : {}),
        })),
    })), provenanceStampHex);
    await writeFile(
        instructionsPath,
        paths.provenanceStampSupport === false
            ? serializeLegacyScanCleanupPageOpsInstructions(instructions)
            : serializeScanCleanupPageOpsInstructions(instructions),
    );
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
    const [
        sourceFile,
        outputFile,
    ] = await Promise.all([
        stat(preparedPdfPath),
        stat(stagedPdfPath),
    ]);
    const representationReport = {
        schemaVersion: 1 as const,
        sourceBytes: sourceFile.size,
        outputBytes: outputFile.size,
        outputToSourceByteRatio: outputFile.size / sourceFile.size,
        compactSourceBudget: null,
        outputMappings,
        pages: allOutputs.map((output, outputIndex) => {
            const sourcePageNumber = output.sourcePageIndex + 1;
            const metadata = pageMetadataBySource.get(sourcePageNumber);
            return {
                outputPageNumber: outputIndex + 1,
                outputOrdinal: outputIndex + 1,
                sourcePageNumber,
                semanticMode: 'color' as const,
                representation: 'source-preserved',
                preservationReason: 'source-preserved',
                sourceDpi: sourceDpiByPage.get(sourcePageNumber) ?? null,
                sourceBackgroundDpi: null,
                renderDpi: sourceDpiByPage.get(sourcePageNumber) ?? 1,
                illuminationNormalized: false,
                textToneApplied: false,
                binarizationMode: null,
                half: output.half ?? 'full',
                rotationDegrees: metadata?.rotationDegrees ?? 0,
                excluded: false,
                blank: false,
            };
        }),
    } satisfies IScanCleanupRepresentationReport;
    await writeFile(
        join(scratch, 'scan-cleanup-representation-report.json'),
        `${JSON.stringify(representationReport, null, 2)}\n`,
    );
    return summary;
}
