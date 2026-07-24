import type {
    INativeScanCleanupOptionsV3,
    IScanCleanupManualZones,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupDespeckleLevel,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import {
    resolveScanCleanupMarginsMm,
    resolveScanCleanupPageLayout,
} from '@contracts/scanCleanupPageOverrides';

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

// An unresolved (absent) mode gets the bilevel budget because the native
// engine may still resolve the page to a supersampled binary layer.
export function resolveScanCleanupPipelineMaxPixels(
    outputMode?: TScanCleanupOutputMode,
) {
    return outputMode === undefined || outputMode === 'bw'
        ? MAX_BILEVEL_PIXELS
        : MAX_CONTINUOUS_TONE_PIXELS;
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
        layout: resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride),
        manualSplit: pageOverride.manualSplit,
        ...(pageOverride.manualSkewDegrees === undefined
            ? {}
            : {manualSkewDegrees: pageOverride.manualSkewDegrees}),
        manualContentBoxes: pageOverride.manualContentBoxes ?? {},
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
