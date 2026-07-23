import type {
    INativeScanCleanupOptionsV2,
    IScanCleanupManualZones,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupDespeckleLevel,
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
    qualityPath: TScanCleanupQualityPath;
    experimental?: IScanCleanupExperimentalOptions;
}

export interface IEffectiveNativeScanCleanupOptionsV2 extends INativeScanCleanupOptionsV2 {
    despeckleLevel: TScanCleanupDespeckleLevel;
    manualZones: IScanCleanupManualZones;
}

const MAX_PIXELS = 160_000_000;
const MAX_DIMENSION_PX = 40_000;

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
    qualityPath,
    experimental = DEFAULT_SCAN_CLEANUP_EXPERIMENTAL_OPTIONS,
}: IResolveEffectiveScanCleanupOptionsInput): IEffectiveNativeScanCleanupOptionsV2 {
    const lossless = qualityPath === 'lossless';
    const outputMode = lossless ? 'color' : options.outputMode;
    const hasBinaryLayer = outputMode === 'bw' || outputMode === 'mixed';
    const dewarpRequested = !lossless && experimental.autoDewarp;
    const despeckleLevel = !lossless && hasBinaryLayer
        ? resolveScanCleanupDespeckleLevel(options)
        : 'off';
    return {
        dpi,
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
        maxPixels: MAX_PIXELS,
        maxDimensionPx: MAX_DIMENSION_PX,
    };
}
