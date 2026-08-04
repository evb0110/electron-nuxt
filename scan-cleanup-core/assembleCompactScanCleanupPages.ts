import {
    rename,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import type {
    INativeScanCleanupOutputMetadataV3,
    INativeScanCleanupPageMetadataV3,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import type {
    IDetectedPageRaster,
    IPdfMrcLayers,
    IPdfPageSize,
    TScanCleanupLog,
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@scan-cleanup-core/types';
import {
    type IScanCleanupRect,
    mapLosslessAnalysisRectToPdf,
    placeUniformBox,
} from '@scan-cleanup-core/policy/documentCanvas';
import {
    buildScanCleanupPageOpsInstructions,
    serializeLegacyScanCleanupPageOpsInstructions,
    serializeScanCleanupPageOpsInstructions,
} from '@scan-cleanup-core/compactManifest';

const REPORTED_PAGE_NUMBER_LIMIT = 20;

export function describePageNumbers(pageNumbers: readonly number[]) {
    return pageNumbers.length <= REPORTED_PAGE_NUMBER_LIMIT
        ? pageNumbers.join(', ')
        : `${pageNumbers.slice(0, REPORTED_PAGE_NUMBER_LIMIT).join(', ')} and ${String(pageNumbers.length - REPORTED_PAGE_NUMBER_LIMIT)} more`;
}

export interface IRenderedCleanupOutputPage {
    sourcePageNumber: number;
    path: string;
    bilevelPath?: string;
    backgroundPath?: string;
    foregroundMaskPath?: string;
    foregroundAlphaPath?: string;
    backgroundIsColor?: boolean;
    dpi: number;
    resolvedOutputMode: TScanCleanupOutputMode;
    metadata: INativeScanCleanupOutputMetadataV3;
    preservedSource?: {
        reason:
            | 'auto-color-compact-layered-no-raster-change'
            | 'auto-mixed-trusted-mrc-tone-preserved';
        sourcePageIndex: number;
        rotationQuarterTurns: number;
        cropRect: IScanCleanupRect;
        contentTransform: {
            scale: number;
            translateX: number;
            translateY: number;
        };
    };
}

export function sourceMrcForegroundPdfMatrix(
    output: IRenderedCleanupOutputPage,
    layers: IPdfMrcLayers,
    pageWidthPoints: number,
    pageHeightPoints: number,
) {
    const metadata = output.metadata;
    const matrix = metadata.forwardTransform?.matrix;
    if (
        matrix === undefined
        || metadata.inputWidthPx === undefined
        || metadata.inputHeightPx === undefined
        || metadata.outputWidthPx <= 0
        || metadata.outputHeightPx <= 0
        || metadata.rotationDegrees !== 0
        || metadata.dewarpMapping != null
    ) {
        throw new Error(
            `Page ${String(output.sourcePageNumber)} cannot preserve its source MRC foreground `
            + 'because its cleanup geometry is not affine in the source orientation',
        );
    }
    const inputScaleX = metadata.inputWidthPx / layers.foregroundWidth;
    const inputScaleY = metadata.inputHeightPx / layers.foregroundHeight;
    const contentWidth = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const contentHeight = metadata.matchedCanvasContentHeightPx ?? metadata.outputHeightPx;
    const matchScaleX = contentWidth / metadata.outputWidthPx;
    const matchScaleY = contentHeight / metadata.outputHeightPx;
    const offsetX = metadata.placementOffsetXPx;
    const offsetY = metadata.placementOffsetYPx;
    const sourceToCanvas = {
        a: matrix[0]![0]! * inputScaleX * matchScaleX,
        b: matrix[0]![1]! * inputScaleY * matchScaleX,
        c: matrix[0]![2]! * matchScaleX + offsetX,
        d: matrix[1]![0]! * inputScaleX * matchScaleY,
        e: matrix[1]![1]! * inputScaleY * matchScaleY,
        f: matrix[1]![2]! * matchScaleY + offsetY,
    };
    const pointScaleX = pageWidthPoints / metadata.canvasWidthPx;
    const pointScaleY = pageHeightPoints / metadata.canvasHeightPx;
    const sourceWidth = layers.foregroundWidth;
    const sourceHeight = layers.foregroundHeight;
    const pdfMatrix = [
        pointScaleX * sourceToCanvas.a * sourceWidth,
        -pointScaleY * sourceToCanvas.d * sourceWidth,
        -pointScaleX * sourceToCanvas.b * sourceHeight,
        pointScaleY * sourceToCanvas.e * sourceHeight,
        pointScaleX * (sourceToCanvas.b * sourceHeight + sourceToCanvas.c),
        pageHeightPoints
        - pointScaleY * (sourceToCanvas.e * sourceHeight + sourceToCanvas.f),
    ];
    if (!pdfMatrix.every(Number.isFinite)) {
        throw new Error(
            `Page ${String(output.sourcePageNumber)} produced a non-finite source MRC transform`,
        );
    }
    return pdfMatrix;
}

export function resolveCompactSourcePreservation(
    request: IRunScanCleanupPipelineRequest,
    sourcePageNumber: number,
    pageMetadata: INativeScanCleanupPageMetadataV3,
    output: Omit<IRenderedCleanupOutputPage, 'preservedSource'>,
    pageSize: IPdfPageSize | undefined,
    sourceRaster: IDetectedPageRaster | undefined,
) {
    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, sourcePageNumber);
    // Auto is allowed to retain a compact source page when cleanup made no
    // raster change. JPX/JBIG2 are supported by EVB Viewer's configured PDF.js
    // runtime and by the reference desktop renderers; transcoding them merely
    // for a separate no-WASM review surface adds no quality and can multiply
    // the document size. That review surface is classified separately by the
    // generated-PDF verifier.
    const configuredMode = pageOverride.outputModeOverride ?? request.options.outputMode;
    const manualZones = pageOverride.manualZones;
    const preservesTrustedMrcTone = output.resolvedOutputMode === 'mixed'
        && output.metadata.trustedMrcBackgroundPreserved === true;
    if (
        configuredMode !== 'auto'
        || (output.resolvedOutputMode !== 'color' && !preservesTrustedMrcTone)
        || sourceRaster?.hasBilevelLayer !== true
        || sourceRaster.backgroundDpi === undefined
        || !Number.isFinite(sourceRaster.backgroundDpi)
        || sourceRaster.backgroundDpi <= 0
        || pageSize === undefined
        || pageSize.rotation !== 0
        || pageOverride.rotationDegrees !== 0
        || pageMetadata.layoutClassification !== 'single-uncut-page'
        || pageMetadata.outputCount !== 1
        || output.metadata.half !== 'full'
        || output.metadata.skewApplied
        || output.metadata.dewarpModel != null
        || (!preservesTrustedMrcTone && output.metadata.illuminationNormalized === true)
        || (!preservesTrustedMrcTone && output.metadata.textToneDiagnostics?.applied === true)
        || (!preservesTrustedMrcTone && output.metadata.binarizationMode != null)
        || pageOverride.manualSkewDegrees !== undefined
        || (manualZones?.picture.length ?? 0) > 0
        || (manualZones?.fill.length ?? 0) > 0
        || output.metadata.cropRect === undefined
        || output.metadata.inputWidthPx === undefined
        || output.metadata.inputHeightPx === undefined
    ) {
        return undefined;
    }
    const targetWidth = output.metadata.matchedCanvasTargetWidthPoints
        ?? output.metadata.canvasWidthPx / output.dpi * 72;
    const targetHeight = output.metadata.matchedCanvasTargetHeightPoints
        ?? output.metadata.canvasHeightPx / output.dpi * 72;
    const sourceCrop = mapLosslessAnalysisRectToPdf(
        output.metadata.cropRect,
        output.metadata.inputWidthPx,
        output.metadata.inputHeightPx,
        pageMetadata.rotationDegrees,
        pageSize,
    );
    const scale = Math.min(
        targetWidth / sourceCrop.width,
        targetHeight / sourceCrop.height,
    );
    if (!Number.isFinite(scale) || scale <= 0) {
        return undefined;
    }
    const alignment = pageOverride.placementOverrides?.full ?? request.options.pageAlignment;
    const placed = placeUniformBox(
        {
            x: sourceCrop.x * scale,
            y: sourceCrop.y * scale,
            width: sourceCrop.width * scale,
            height: sourceCrop.height * scale,
        },
        targetWidth,
        targetHeight,
        alignment,
    );
    return {
        reason: preservesTrustedMrcTone
            ? 'auto-mixed-trusted-mrc-tone-preserved' as const
            : 'auto-color-compact-layered-no-raster-change' as const,
        sourcePageIndex: sourcePageNumber - 1,
        rotationQuarterTurns: 0,
        cropRect: {
            x: 0,
            y: 0,
            width: targetWidth,
            height: targetHeight,
        },
        contentTransform: {
            scale,
            translateX: -placed.x,
            translateY: -placed.y,
        },
    };
}

function appendQpdfPageSelection(
    args: string[],
    path: string,
    firstPage: number,
    lastPage: number,
) {
    args.push(path, firstPage === lastPage
        ? String(firstPage)
        : `${String(firstPage)}-${String(lastPage)}`);
}

export async function assembleWithCompactSourcePages(
    outputPages: readonly IRenderedCleanupOutputPage[],
    paths: IScanCleanupWorkerPaths,
    preparedPdfPath: string,
    rasterizedPdfPath: string,
    stagedPdfPath: string,
    scratch: string,
    signal: AbortSignal,
    log: TScanCleanupLog,
    dependencies: IRunScanCleanupPipelineDependencies,
    provenanceStampHex?: string,
) {
    const preservedPages = outputPages.flatMap(output => (
        output.preservedSource === undefined ? [] : [output.preservedSource]
    ));
    if (preservedPages.length === 0) {
        if (rasterizedPdfPath !== stagedPdfPath) {
            await rename(rasterizedPdfPath, stagedPdfPath);
        }
        return;
    }
    if (!paths.pdfPageOpsBinary) {
        throw new Error('evb-pdf-page-ops is unavailable for compact source-page preservation');
    }
    const instructionsPath = join(scratch, 'preserved-source-pages.json');
    const preservedPdfPath = join(scratch, 'preserved-source-pages.pdf');
    const instructions = buildScanCleanupPageOpsInstructions(preservedPages.map(page => ({
        sourcePageIndex: page.sourcePageIndex,
        rotationQuarterTurns: page.rotationQuarterTurns,
        outputs: [{
            cropRect: page.cropRect,
            contentTransform: page.contentTransform,
        }],
    })), provenanceStampHex);
    await writeFile(
        instructionsPath,
        paths.provenanceStampSupport === false
            ? serializeLegacyScanCleanupPageOpsInstructions(instructions)
            : serializeScanCleanupPageOpsInstructions(instructions),
    );
    await dependencies.runCommand(paths.pdfPageOpsBinary, [
        'split-pages',
        '--input',
        preparedPdfPath,
        '--output',
        preservedPdfPath,
        '--instructions-file',
        instructionsPath,
    ], {
        signal,
        commandLabel: 'evb-pdf-page-ops(split-pages:compact-scan-cleanup-pages)',
        timeoutMs: 10 * 60 * 1000,
        log,
    });

    const qpdfArgs = [
        '--empty',
        // Some otherwise capable PDF consumers only render the first stream in
        // a page Contents array. split-pages wraps preserved source content in
        // separate graphics-state streams, so leaving the array intact can make
        // the page appear blank outside spec-compliant renderers. Coalescing is
        // lossless: image objects and their compact JPX/JBIG2 data are retained.
        '--coalesce-contents',
        '--pages',
    ];
    let preservedPageNumber = 0;
    let runPath = '';
    let runFirst = 0;
    let runLast = 0;
    const flush = () => {
        if (runPath !== '') {
            appendQpdfPageSelection(qpdfArgs, runPath, runFirst, runLast);
        }
    };
    outputPages.forEach((output, index) => {
        const pageNumber = output.preservedSource === undefined
            ? index + 1
            : ++preservedPageNumber;
        const path = output.preservedSource === undefined
            ? rasterizedPdfPath
            : preservedPdfPath;
        if (path === runPath && pageNumber === runLast + 1) {
            runLast = pageNumber;
            return;
        }
        flush();
        runPath = path;
        runFirst = pageNumber;
        runLast = pageNumber;
    });
    flush();
    qpdfArgs.push('--', stagedPdfPath);
    await dependencies.runCommand(paths.qpdfBinary, qpdfArgs, {
        signal,
        commandLabel: 'qpdf(scan-cleanup:retain-compact-source-pages)',
        timeoutMs: 10 * 60 * 1000,
        log,
    });
    log(
        'debug',
        `Scan cleanup retained the original compact image layers for ${String(preservedPages.length)} automatic no-raster-change page(s)`,
    );
}
