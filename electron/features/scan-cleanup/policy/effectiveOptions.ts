import type {
    INativeScanCleanupOptionsV3,
    IScanCleanupManualZones,
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupPageOverride,
    TScanCleanupDespeckleLevel,
    TScanCleanupLayoutClassification,
    TScanCleanupLayoutByPage,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeSetting,
} from '@contracts/electronApiScanCleanup';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupPageLayout,
} from '@contracts/scanCleanupPageOverrides';
import type {IPdfPageSize} from '@electron/pdf/pdfPageSizes';

export function resolveReusablePagePlan(
    options: IScanCleanupOptions,
    layoutByPage: TScanCleanupLayoutByPage | undefined,
    evidenceByPage: Partial<Record<string, IScanCleanupPagePlanEvidence>> | undefined,
    pageNumber: number,
) {
    const evidence = evidenceByPage?.[String(pageNumber)];
    const pageOverride = getScanCleanupPageOverride(options.pageOverrides, pageNumber);
    const observedLayout = layoutByPage?.[String(pageNumber)];
    if (
        evidence === undefined
        || evidence.pageNumber !== pageNumber
        || evidence.rotationDegrees !== pageOverride.rotationDegrees
        || evidence.layoutClassification !== observedLayout
    ) {
        return {};
    }
    const automaticContentBoxes = Object.fromEntries(Object.entries(evidence.outputs).flatMap(([
        half,
        output,
    ]) => output?.contentBox === undefined ? [] : [[
        half,
        output.contentBox,
    ]]));
    const automaticSkewDegrees = Object.fromEntries(Object.entries(evidence.outputs).flatMap(([
        half,
        output,
    ]) => output?.detectedSkewDegrees === undefined ? [] : [[
        half,
        output.detectedSkewDegrees,
    ]]));
    return {
        ...(Object.keys(automaticContentBoxes).length === 0 ? {} : {automaticContentBoxes}),
        ...(Object.keys(automaticSkewDegrees).length === 0 ? {} : {automaticSkewDegrees}),
    };
}

export interface IScanCleanupExperimentalOptions {
    autoDewarp: boolean;
    autoDewarpDepth?: number;
}

const DEFAULT_SCAN_CLEANUP_EXPERIMENTAL_OPTIONS: Readonly<IScanCleanupExperimentalOptions> = Object.freeze({autoDewarp: false});

export type TScanCleanupQualityPath = 'raster' | 'lossless';

export interface IResolveEffectiveScanCleanupOptionsInput {
    options: IScanCleanupOptions;
    pageOverride: IScanCleanupPageOverride;
    dpi: number;
    sourceDpi?: number;
    requestedRenderDpi?: number;
    renderCrop?: INativeScanCleanupOptionsV3['renderCrop'];
    resolvedOutputMode?: TScanCleanupOutputMode;
    observedLayout?: TScanCleanupLayoutClassification;
    automaticContentBoxes?: INativeScanCleanupOptionsV3['automaticContentBoxes'];
    automaticSkewDegrees?: INativeScanCleanupOptionsV3['automaticSkewDegrees'];
    qualityPath: TScanCleanupQualityPath;
    experimental?: IScanCleanupExperimentalOptions;
}

export interface IEffectiveNativeScanCleanupOptionsV3 extends INativeScanCleanupOptionsV3 {
    despeckleLevel: TScanCleanupDespeckleLevel;
    manualZones: IScanCleanupManualZones;
}

const MAX_BILEVEL_PIXELS = 160_000_000;
const MAX_CONTINUOUS_TONE_PIXELS = 80_000_000;
const MAX_DIMENSION_PX = 40_000;

export const SCAN_CLEANUP_MAX_DIMENSION_PX = MAX_DIMENSION_PX;

/**
 * One canvas is shared by every output of the document, so it has to fit the
 * tightest budget any of them can be rendered under — but only the budgets the
 * document's own settings can actually produce. A document that is bilevel
 * throughout is normalized onto the bilevel grid, which is twice the pixels a
 * continuous-tone page is allowed; enabling colour output is what lowers it,
 * rather than the mere possibility of colour somewhere.
 *
 * `auto` counts as continuous-tone: the engine resolves it per page from the
 * pixels, so a canvas sized for a binary layer could be a grid a page resolved
 * to colour is not allowed to be rendered on.
 */
export function resolveScanCleanupMatchedCanvasMaxPixels(
    configuredModes: Iterable<TScanCleanupOutputModeSetting>,
) {
    for (const mode of configuredModes) {
        if (mode !== 'bw') {
            return MAX_CONTINUOUS_TONE_PIXELS;
        }
    }
    return MAX_BILEVEL_PIXELS;
}

// An unresolved (absent) mode gets the bilevel budget because the native
// engine may still resolve the page to a supersampled binary layer.
export function resolveScanCleanupPipelineMaxPixels(
    outputMode?: TScanCleanupOutputMode,
) {
    return outputMode === undefined || outputMode === 'bw'
        ? MAX_BILEVEL_PIXELS
        : MAX_CONTINUOUS_TONE_PIXELS;
}

// Rome p1/p7/p49 at source DPI retained scan texture, fine text, and mixed
// illustration edges at these settings. Color gets two extra quality points
// for chroma detail; grayscale and mixed pages do not spend bytes on it.
export const SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY = 85;
export const SCAN_CLEANUP_COLOR_JPEG_QUALITY = 87;

export function resolveTonalJpegQuality(mode: TScanCleanupOutputMode) {
    if (mode === 'color') {
        return SCAN_CLEANUP_COLOR_JPEG_QUALITY;
    }
    if (mode === 'grayscale' || mode === 'mixed') {
        return SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY;
    }
    return undefined;
}

// What a page is measured at when nothing has measured it yet: one page view in
// points, which is the cheapest render Poppler can be asked for.
export const SCAN_CLEANUP_SIZE_PROBE_DPI = 72;

/**
 * The resolution a page may actually be rendered at: what was asked for, held
 * inside the pixel budget its output mode allows and the largest dimension the
 * engine accepts, measured from a raster of that page at a known resolution.
 */
export function resolveSafeRenderDpi(
    requestedRenderDpi: number,
    maxPixels: number,
    probe: {
        dpi: number;
        width: number;
        height: number
    },
) {
    return Math.max(1, Math.floor(Math.min(
        requestedRenderDpi,
        probe.dpi * Math.min(MAX_DIMENSION_PX / probe.width, MAX_DIMENSION_PX / probe.height),
        probe.dpi * Math.sqrt(maxPixels / (probe.width * probe.height)),
    )));
}

/**
 * The pixel guardrail a page can be planned against without rendering it: the
 * raster row pdfimages reported, or the page's own paper turned the way it is
 * displayed, which is what a size probe would have measured. A page outside a
 * run's scope is planned from this, so the document's pixel grid is the same
 * whether or not that page was one of the pages cleaned.
 */
export function resolveScanCleanupDocumentGuardrail(
    detected: {
        width: number;
        height: number
    } | undefined,
    sourceDpi: number | undefined,
    pageSize: IPdfPageSize | undefined,
) {
    if (detected !== undefined && sourceDpi !== undefined) {
        return {
            dpi: sourceDpi,
            width: detected.width,
            height: detected.height,
        };
    }
    if (pageSize === undefined) {
        return undefined;
    }
    const swapsAxes = Math.abs(Math.round(pageSize.rotation / 90)) % 2 === 1;
    return {
        dpi: SCAN_CLEANUP_SIZE_PROBE_DPI,
        width: (swapsAxes ? pageSize.heightPoints : pageSize.widthPoints) / 72 * SCAN_CLEANUP_SIZE_PROBE_DPI,
        height: (swapsAxes ? pageSize.widthPoints : pageSize.heightPoints) / 72 * SCAN_CLEANUP_SIZE_PROBE_DPI,
    };
}

// A page with no measurable raster that may still be cleaned to a binary layer
// is synthesized rather than resampled, and 1-bit text needs finer sampling
// than the paper itself asks for to keep its edges.
export const SCAN_CLEANUP_BILEVEL_FALLBACK_DPI = 600;

export interface IResolveScanCleanupPlannedDpiInput {
    sourceDpi: number;
    hasDetectedRaster: boolean;
    carriesBinaryLayer: boolean;
    maxPixels: number;
    guardrail: {
        dpi: number;
        width: number;
        height: number
    } | undefined;
}

/**
 * The resolution a page is planned at: what its content asks for, raised to the
 * synthesis floor when the page may carry a binary layer it has no raster for,
 * and held inside the pixel budget its guardrail allows.
 */
export function resolveScanCleanupPlannedDpi({
    sourceDpi,
    hasDetectedRaster,
    carriesBinaryLayer,
    maxPixels,
    guardrail,
}: IResolveScanCleanupPlannedDpiInput) {
    const requestedRenderDpi = !hasDetectedRaster && carriesBinaryLayer
        ? Math.max(sourceDpi, SCAN_CLEANUP_BILEVEL_FALLBACK_DPI)
        : sourceDpi;
    return {
        sourceDpi,
        requestedRenderDpi,
        dpi: guardrail === undefined
            ? requestedRenderDpi
            : resolveSafeRenderDpi(requestedRenderDpi, maxPixels, guardrail),
    };
}

/**
 * The resolution one page contributes to the document's shared canvas.
 *
 * It reads the output mode the page is *configured* with — its override, or the
 * document's setting — rather than the mode a run resolved for it: a canvas
 * that moved when detection recommended a mode, or when a selection resolved
 * fewer pages than a full run, would make the same page a different size
 * depending on when it was cleaned. `auto` therefore takes the synthesis floor,
 * because the engine may still resolve such a page to a binary layer.
 */
export function resolveScanCleanupCanvasPageDpi(
    input: Omit<IResolveScanCleanupPlannedDpiInput, 'carriesBinaryLayer' | 'maxPixels'>
        & {configuredMode: TScanCleanupOutputModeSetting},
) {
    return resolveScanCleanupPlannedDpi({
        ...input,
        carriesBinaryLayer: input.configuredMode !== 'grayscale' && input.configuredMode !== 'color',
        maxPixels: resolveScanCleanupMatchedCanvasMaxPixels([input.configuredMode]),
    }).dpi;
}

function resolveScanCleanupDespeckleLevel(
    options: IScanCleanupOptions,
): TScanCleanupDespeckleLevel {
    const legacyEnabled = options.despeckle ?? true;
    return options.despeckleLevel ?? (legacyEnabled ? 'normal' : 'off');
}

export function resolveEffectiveScanCleanupOptions({
    options,
    pageOverride,
    dpi,
    sourceDpi = dpi,
    requestedRenderDpi = dpi,
    renderCrop,
    resolvedOutputMode,
    observedLayout,
    automaticContentBoxes,
    automaticSkewDegrees,
    qualityPath,
    experimental = DEFAULT_SCAN_CLEANUP_EXPERIMENTAL_OPTIONS,
}: IResolveEffectiveScanCleanupOptionsInput): IEffectiveNativeScanCleanupOptionsV3 {
    const lossless = qualityPath === 'lossless';
    const outputMode = lossless
        ? 'color'
        : resolvedOutputMode ?? pageOverride.outputModeOverride ?? options.outputMode;
    const hasBinaryLayer = outputMode === 'auto' || outputMode === 'bw' || outputMode === 'mixed';
    const dewarpRequested = !lossless && experimental.autoDewarp;
    const despeckleLevel = !lossless && hasBinaryLayer
        ? resolveScanCleanupDespeckleLevel(options)
        : 'off';
    const configuredLayout = resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride);
    const layout = configuredLayout !== 'auto' || pageOverride.manualSplit !== null
        ? configuredLayout
        : observedLayout === 'single-uncut-page'
            ? 'force-single'
            : observedLayout === 'two-page-spread'
                ? 'force-two-page'
                : observedLayout === 'page-with-offcut'
                    ? 'page-with-offcut'
                    : 'auto';
    return {
        dpi,
        sourceDpi,
        requestedRenderDpi,
        ...(renderCrop === undefined ? {} : {renderCrop}),
        binarization: options.binarization ?? 'auto',
        thickness: lossless ? 0 : options.thickness,
        normalizeIllumination: !lossless && (options.normalizeIllumination ?? true),
        despeckle: despeckleLevel !== 'off',
        despeckleLevel,
        outputMode,
        ocrMode: false,
        // Detection is durable page evidence, not merely a canvas hint. Reuse
        // it when the user left layout automatic so preview/final rendering do
        // not repeat the same split classification. Explicit user choices and
        // manual cutters always win.
        layout,
        manualSplit: pageOverride.manualSplit,
        ...(pageOverride.manualSkewDegrees === undefined
            ? {}
            : {manualSkewDegrees: pageOverride.manualSkewDegrees}),
        manualContentBoxes: pageOverride.manualContentBoxes ?? {},
        ...(automaticContentBoxes === undefined ? {} : {automaticContentBoxes}),
        ...(automaticSkewDegrees === undefined ? {} : {automaticSkewDegrees}),
        manualZones: pageOverride.manualZones ?? {
            picture: [],
            fill: [],
        },
        cropContent: options.crop,
        matchPageSize: options.matchPageSize,
        pageAlignment: options.pageAlignment,
        placementOverrides: pageOverride.placementOverrides ?? {},
        margins: {...resolveScanCleanupMarginsMm(options.marginsMm, pageOverride)},
        experimental: {
            autoDewarp: dewarpRequested,
            ...(dewarpRequested && experimental.autoDewarpDepth !== undefined
                ? {autoDewarpDepth: experimental.autoDewarpDepth}
                : {}),
        },
        rotationDegrees: pageOverride.rotationDegrees,
        excluded: pageOverride.excluded,
        skipBlankPages: !lossless && options.skipBlankPages,
        maxPixels: resolveScanCleanupPipelineMaxPixels(resolvedOutputMode),
        maxDimensionPx: MAX_DIMENSION_PX,
    };
}
