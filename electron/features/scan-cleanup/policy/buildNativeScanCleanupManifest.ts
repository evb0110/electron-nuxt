import type {
    INativeScanCleanupManifestV2,
    INativeScanCleanupOutputV2,
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    TNativeScanCleanupOperation,
    TNativeScanCleanupRenderMode,
    TScanCleanupCanvasScope,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION} from '@contracts/electronApiScanCleanup';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {
    resolveEffectiveScanCleanupOptions,
    type IEffectiveNativeScanCleanupOptionsV2,
    type IScanCleanupExperimentalOptions,
    type TScanCleanupQualityPath,
} from '@electron/features/scan-cleanup/policy/effectiveOptions';

export interface IScanCleanupManifestPageInput {
    inputPath: string;
    pageNumber: number;
    dpi: number;
    pageMetadataPath: string;
    outputs?: INativeScanCleanupOutputV2[];
    documentPrior?: IScanCleanupDocumentPrior;
}

export interface IBuildNativeScanCleanupManifestInput {
    operation: TNativeScanCleanupOperation;
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    qualityPath: TScanCleanupQualityPath;
    options: IScanCleanupOptions;
    pages: IScanCleanupManifestPageInput[];
    experimental?: IScanCleanupExperimentalOptions;
}

export function serializeNativeScanCleanupOptions(
    options: IEffectiveNativeScanCleanupOptionsV2,
): INativeScanCleanupManifestV2['pages'][number]['options'] {
    const {
        despeckleLevel,
        manualZones,
        ...baselineOptions
    } = options;
    const derivedDespeckleLevel = options.despeckle ? 'normal' : 'off';
    const hasManualZones = manualZones.picture.length > 0 || manualZones.fill.length > 0;
    return {
        ...baselineOptions,
        ...(despeckleLevel === derivedDespeckleLevel ? {} : {despeckleLevel}),
        ...(hasManualZones ? {manualZones} : {}),
    };
}

export function buildNativeScanCleanupManifest({
    operation,
    renderMode,
    canvasScope,
    qualityPath,
    options,
    pages,
    experimental,
}: IBuildNativeScanCleanupManifestInput): INativeScanCleanupManifestV2 {
    return {
        version: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
        operation,
        renderMode,
        canvasScope,
        pages: pages.map(page => ({
            inputPath: page.inputPath,
            sourcePageIndex: page.pageNumber - 1,
            pageMetadataPath: page.pageMetadataPath,
            options: serializeNativeScanCleanupOptions(
                resolveEffectiveScanCleanupOptions({
                    options,
                    pageOverride: getScanCleanupPageOverride(options.pageOverrides, page.pageNumber),
                    dpi: page.dpi,
                    qualityPath,
                    ...(experimental === undefined ? {} : {experimental}),
                }),
            ),
            outputs: page.outputs ?? [],
            ...(page.documentPrior === undefined ? {} : {documentPrior: page.documentPrior}),
        })),
    };
}
