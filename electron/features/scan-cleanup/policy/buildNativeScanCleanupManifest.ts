import type {
    INativeScanCleanupManifestV3,
    INativeScanCleanupOutputV3,
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    TNativeScanCleanupOperation,
    TNativeScanCleanupRenderMode,
    TScanCleanupCanvasScope,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION} from '@contracts/electronApiScanCleanup';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {
    resolveEffectiveScanCleanupOptions,
    type IEffectiveNativeScanCleanupOptionsV3,
    type IScanCleanupExperimentalOptions,
    type TScanCleanupQualityPath,
} from '@electron/features/scan-cleanup/policy/effectiveOptions';

export interface IScanCleanupManifestPageInput {
    inputPath: string;
    pageNumber: number;
    dpi: number;
    sourceDpi?: number;
    requestedRenderDpi?: number;
    renderCrop?: INativeScanCleanupManifestV3['pages'][number]['options']['renderCrop'];
    resolvedOutputMode?: TScanCleanupOutputMode;
    observedLayout?: TScanCleanupLayoutClassification;
    automaticContentBoxes?: INativeScanCleanupManifestV3['pages'][number]['options']['automaticContentBoxes'];
    automaticSkewDegrees?: INativeScanCleanupManifestV3['pages'][number]['options']['automaticSkewDegrees'];
    pageMetadataPath: string;
    outputs?: INativeScanCleanupOutputV3[];
    documentPrior?: IScanCleanupDocumentPrior;
    detailRenderPlan?: INativeScanCleanupManifestV3['pages'][number]['detailRenderPlan'];
}

export interface IBuildNativeScanCleanupManifestInput {
    operation: TNativeScanCleanupOperation;
    analysisPurpose?: INativeScanCleanupManifestV3['analysisPurpose'];
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    qualityPath: TScanCleanupQualityPath;
    options: IScanCleanupOptions;
    pages: IScanCleanupManifestPageInput[];
    documentCanvas?: IScanCleanupDocumentCanvasPlan;
    experimental?: IScanCleanupExperimentalOptions;
    hostMemoryBytes?: number;
}

export function serializeNativeScanCleanupOptions(
    options: IEffectiveNativeScanCleanupOptionsV3,
): INativeScanCleanupManifestV3['pages'][number]['options'] {
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
    analysisPurpose,
    renderMode,
    canvasScope,
    qualityPath,
    options,
    pages,
    documentCanvas,
    experimental,
    hostMemoryBytes,
}: IBuildNativeScanCleanupManifestInput): INativeScanCleanupManifestV3 {
    return {
        version: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
        operation,
        ...(analysisPurpose === undefined ? {} : {analysisPurpose}),
        renderMode,
        canvasScope,
        ...(documentCanvas === undefined ? {} : {documentCanvas}),
        ...(hostMemoryBytes !== undefined && hostMemoryBytes > 0 ? {hostMemoryBytes} : {}),
        pages: pages.map(page => ({
            inputPath: page.inputPath,
            sourcePageIndex: page.pageNumber - 1,
            pageMetadataPath: page.pageMetadataPath,
            options: serializeNativeScanCleanupOptions(
                resolveEffectiveScanCleanupOptions({
                    options,
                    pageOverride: getScanCleanupPageOverride(options.pageOverrides, page.pageNumber),
                    dpi: page.dpi,
                    ...(page.sourceDpi === undefined ? {} : {sourceDpi: page.sourceDpi}),
                    ...(page.requestedRenderDpi === undefined
                        ? {}
                        : {requestedRenderDpi: page.requestedRenderDpi}),
                    ...(page.renderCrop === undefined ? {} : {renderCrop: page.renderCrop}),
                    ...(page.resolvedOutputMode === undefined
                        ? {}
                        : {resolvedOutputMode: page.resolvedOutputMode}),
                    ...(page.observedLayout === undefined
                        ? {}
                        : {observedLayout: page.observedLayout}),
                    ...(page.automaticContentBoxes === undefined
                        ? {}
                        : {automaticContentBoxes: page.automaticContentBoxes}),
                    ...(page.automaticSkewDegrees === undefined
                        ? {}
                        : {automaticSkewDegrees: page.automaticSkewDegrees}),
                    qualityPath,
                    ...(experimental === undefined ? {} : {experimental}),
                }),
            ),
            outputs: page.outputs ?? [],
            ...(page.documentPrior === undefined ? {} : {documentPrior: page.documentPrior}),
            ...(page.detailRenderPlan === undefined ? {} : {detailRenderPlan: page.detailRenderPlan}),
        })),
    };
}
