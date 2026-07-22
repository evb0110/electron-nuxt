import type {
    INativeScanCleanupOptionsV2,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
} from '@contracts/electronApiScanCleanup';
import {
    resolveScanCleanupMarginsMm,
    resolveScanCleanupPageLayout,
} from '@contracts/scanCleanupPageOverrides';

export interface IScanCleanupExperimentalOptions {autoDewarp: boolean;}

export const DEFAULT_SCAN_CLEANUP_EXPERIMENTAL_OPTIONS: Readonly<IScanCleanupExperimentalOptions> = Object.freeze({autoDewarp: false});

export type TScanCleanupQualityPath = 'raster' | 'lossless';

export interface IResolveEffectiveScanCleanupOptionsInput {
    options: IScanCleanupOptions;
    pageOverride: IScanCleanupPageOverride;
    dpi: number;
    qualityPath: TScanCleanupQualityPath;
    experimental?: IScanCleanupExperimentalOptions;
}

const MAX_PIXELS = 160_000_000;
const MAX_DIMENSION_PX = 40_000;

export function resolveEffectiveScanCleanupOptions({
    options,
    pageOverride,
    dpi,
    qualityPath,
    experimental = DEFAULT_SCAN_CLEANUP_EXPERIMENTAL_OPTIONS,
}: IResolveEffectiveScanCleanupOptionsInput): INativeScanCleanupOptionsV2 {
    const lossless = qualityPath === 'lossless';
    const outputMode = lossless ? 'color' : options.outputMode;
    const dewarpRequested = !lossless && experimental.autoDewarp;
    return {
        dpi,
        binarization: 'auto',
        thickness: lossless ? 0 : options.thickness,
        normalizeIllumination: !lossless,
        despeckle: !lossless && outputMode === 'bw' && options.despeckle,
        outputMode,
        ocrMode: false,
        layout: resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride),
        manualSplit: pageOverride.manualSplit,
        manualContentBoxes: dewarpRequested ? {} : pageOverride.manualContentBoxes ?? {},
        cropContent: options.crop && !dewarpRequested,
        matchPageSize: options.matchPageSize,
        pageAlignment: options.pageAlignment,
        placementOverrides: pageOverride.placementOverrides ?? {},
        margins: dewarpRequested
            ? {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            }
            : {...resolveScanCleanupMarginsMm(options.marginsMm, pageOverride)},
        experimental: {autoDewarp: dewarpRequested},
        rotationDegrees: pageOverride.rotationDegrees,
        excluded: pageOverride.excluded,
        skipBlankPages: !lossless && options.skipBlankPages,
        maxPixels: MAX_PIXELS,
        maxDimensionPx: MAX_DIMENSION_PX,
    };
}
